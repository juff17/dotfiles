#!/usr/bin/env python3
"""Watch a GitHub PR or GitLab MR and print one line per event worth acting on.

Polls through `gh api` / `glab api`, authenticated only by GITHUB_TOKEN (or
GH_TOKEN) / GITLAB_TOKEN. What has been reported is kept in a cache file, so
re-arming the watcher after a Monitor timeout never repeats an event.

Events: [watch] [setup] [auth] [error] [push] [failed] [manual] [stuck]
        [pipeline] [behind] [conflict] [comment] [review] [merged] [closed]
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path


def emit(tag, msg):
    print(f"[{tag}] {msg}", flush=True)


def flat(text, limit=240):
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def age_minutes(iso):
    if not iso:
        return 0
    then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - then).total_seconds() / 60


class AuthError(Exception):
    pass


class ApiError(Exception):
    pass


def run(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=90)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip()
        last = err.splitlines()[-1] if err else f"exit {p.returncode}"
        if re.search(r"\b401\b|Bad credentials|Unauthorized", err, re.I):
            raise AuthError(last)
        raise ApiError(last)
    return p.stdout


class Forge:
    cli = ""

    def __init__(self, host, project):
        self.host = host
        self.project = project

    def api(self, path):
        out = run([self.cli, "api", "--hostname", self.host, path])
        return json.loads(out) if out.strip() else None

    def pages(self, path, key=None):
        items, page = [], 1
        sep = "&" if "?" in path else "?"
        while True:
            data = self.api(f"{path}{sep}per_page=100&page={page}")
            batch = data[key] if key else data
            items += batch
            if len(batch) < 100:
                return items
            page += 1


class GitHub(Forge):
    cli = "gh"

    def token_vars(self):
        if self.host == "github.com":
            return ["GH_TOKEN", "GITHUB_TOKEN"]
        return ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]

    def repo(self):
        return f"repos/{self.project}"

    def me(self):
        return self.api("user")["login"]

    def find_number(self, branch):
        owner = self.project.split("/")[0]
        prs = self.api(f"{self.repo()}/pulls?state=open&head={owner}:{urllib.parse.quote(branch)}")
        return prs[0]["number"] if prs else None

    def snapshot(self, number):
        pr = self.api(f"{self.repo()}/pulls/{number}")
        sha = pr["head"]["sha"]
        snap = {
            "state": "merged" if pr.get("merged") else ("closed" if pr["state"] == "closed" else "open"),
            "url": pr["html_url"],
            "title": pr["title"],
            "branch": pr["head"]["ref"],
            "base": pr["base"]["ref"],
            "sha": sha,
            "checks": [],
            "comments": [],
            "reviews": [],
        }
        if snap["state"] != "open":
            return snap

        ms = pr.get("mergeable_state")
        known = pr.get("mergeable") is not None and ms != "unknown"
        snap["conflict"] = ms == "dirty" if known else None
        snap["needs_rebase"] = ms == "behind" if known else None
        cmp = self.api(f"{self.repo()}/compare/{urllib.parse.quote(snap['base'])}...{sha}")
        snap["behind"] = cmp.get("behind_by", 0)

        for c in self.pages(f"{self.repo()}/commits/{sha}/check-runs", key="check_runs"):
            snap["checks"].append({
                "id": c["id"],
                "name": c["name"],
                "status": self.check_status(c),
                "url": c.get("html_url") or c.get("details_url") or "",
                "waited": age_minutes(c.get("started_at")) if c["status"] == "queued" else 0,
                "allow_failure": False,
            })
        for s in self.api(f"{self.repo()}/commits/{sha}/status").get("statuses", []):
            state = {"success": "success", "pending": "pending"}.get(s["state"], "failed")
            snap["checks"].append({
                "id": f"status:{s['context']}",
                "name": s["context"],
                "status": state,
                "url": s.get("target_url") or "",
                "waited": age_minutes(s.get("created_at")) if state == "pending" else 0,
                "allow_failure": False,
            })
        # Environment approvals and first-time-contributor approvals show up
        # only on workflow runs, not on check runs.
        runs = self.api(f"{self.repo()}/actions/runs?head_sha={sha}&per_page=100")
        for r in runs.get("workflow_runs", []):
            if r["status"] in ("waiting", "action_required"):
                snap["checks"].append({
                    "id": f"run:{r['id']}",
                    "name": f"workflow {r['name']} ({r['status'].replace('_', ' ')})",
                    "status": "manual",
                    "url": r["html_url"],
                    "waited": 0,
                    "allow_failure": False,
                })

        for c in self.pages(f"{self.repo()}/pulls/{number}/comments"):
            line = c.get("line") or c.get("original_line")
            snap["comments"].append({
                "id": f"rc:{c['id']}",
                "author": c["user"]["login"],
                "where": f"{c['path']}:{line}" if line else c["path"],
                "body": c["body"],
                "url": c["html_url"],
            })
        for c in self.pages(f"repos/{self.project}/issues/{number}/comments"):
            snap["comments"].append({
                "id": f"ic:{c['id']}",
                "author": c["user"]["login"],
                "where": "",
                "body": c["body"],
                "url": c["html_url"],
            })
        for r in self.pages(f"{self.repo()}/pulls/{number}/reviews"):
            if r["state"] in ("APPROVED", "CHANGES_REQUESTED"):
                snap["reviews"].append({
                    "id": f"rv:{r['id']}",
                    "author": r["user"]["login"],
                    "state": r["state"].replace("_", " ").lower(),
                    "url": r["html_url"],
                })
            if r.get("body"):
                snap["comments"].append({
                    "id": f"rv:{r['id']}",
                    "author": r["user"]["login"],
                    "where": "review summary",
                    "body": r["body"],
                    "url": r["html_url"],
                })
        return snap

    @staticmethod
    def check_status(c):
        if c["status"] == "in_progress":
            return "running"
        if c["status"] == "waiting":
            return "manual"
        if c["status"] != "completed":
            return "pending"
        return {
            "success": "success",
            "neutral": "success",
            "skipped": "skipped",
            "cancelled": "canceled",
            "stale": "canceled",
            "action_required": "manual",
        }.get(c.get("conclusion"), "failed")


class GitLab(Forge):
    cli = "glab"

    def token_vars(self):
        return ["GITLAB_TOKEN"]

    def proj(self):
        return f"projects/{urllib.parse.quote(self.project, safe='')}"

    def me(self):
        return self.api("user")["username"]

    def find_number(self, branch):
        mrs = self.api(f"{self.proj()}/merge_requests?state=opened&source_branch={urllib.parse.quote(branch)}")
        return mrs[0]["iid"] if mrs else None

    JOB_STATUS = {
        "running": "running",
        "success": "success",
        "failed": "failed",
        "canceled": "canceled",
        "canceling": "canceled",
        "skipped": "skipped",
        "manual": "manual",
        "pending": "pending",
    }

    def snapshot(self, iid):
        mr = self.api(f"{self.proj()}/merge_requests/{iid}?include_diverged_commits_count=true")
        state = {"merged": "merged", "closed": "closed"}.get(mr["state"], "open")
        snap = {
            "state": state,
            "url": mr["web_url"],
            "title": mr["title"],
            "branch": mr["source_branch"],
            "base": mr["target_branch"],
            "sha": mr["sha"],
            "checks": [],
            "comments": [],
            "reviews": [],
        }
        if state != "open":
            return snap

        dms = mr.get("detailed_merge_status")
        known = dms not in ("checking", "unchecked", "preparing", "approvals_syncing", None)
        snap["conflict"] = bool(mr.get("has_conflicts")) or dms == "conflict" if known else None
        snap["needs_rebase"] = dms == "need_rebase" if known else None
        snap["behind"] = mr.get("diverged_commits_count") or 0

        pipeline = mr.get("head_pipeline")
        if pipeline and pipeline.get("sha") == mr["sha"]:
            base = f"{self.proj()}/pipelines/{pipeline['id']}"
            for j in self.pages(f"{base}/jobs"):
                snap["checks"].append(self.job(j, j["web_url"]))
            # Child pipelines appear as bridge jobs; their own jobs are not listed.
            for b in self.pages(f"{base}/bridges"):
                down = b.get("downstream_pipeline") or {}
                snap["checks"].append(self.job(b, down.get("web_url") or b["web_url"]))

        for d in self.pages(f"{self.proj()}/merge_requests/{iid}/discussions"):
            for n in d["notes"]:
                if n.get("system"):
                    continue
                pos = n.get("position") or {}
                path = pos.get("new_path") or pos.get("old_path")
                line = pos.get("new_line") or pos.get("old_line")
                where = f"{path}:{line}" if path and line else (path or "")
                snap["comments"].append({
                    "id": f"note:{n['id']}",
                    "author": n["author"]["username"],
                    "where": where,
                    "body": n["body"],
                    "url": f"{mr['web_url']}#note_{n['id']}",
                })

        approvals = self.api(f"{self.proj()}/merge_requests/{iid}/approvals")
        for a in approvals.get("approved_by", []):
            user = a["user"]["username"]
            snap["reviews"].append({
                "id": f"approval:{user}",
                "author": user,
                "state": "approved",
                "url": mr["web_url"],
            })
        return snap

    def job(self, j, url):
        # created, scheduled, waiting_for_resource, etc. wait on other jobs,
        # not on a runner, so they never count as stuck.
        status = self.JOB_STATUS.get(j["status"], "waiting")
        queued = j.get("queued_duration") if status == "pending" else None
        return {
            "id": j["id"],
            "name": f"{j['name']} (stage {j['stage']})",
            "status": status,
            "url": url,
            "waited": (queued or 0) / 60,
            "allow_failure": j.get("allow_failure", False),
        }


def parse_remote(url):
    m = re.match(r"^(?:\w+://)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?/?$", url.strip())
    if not m:
        raise SystemExit(f"cannot parse git remote {url!r}")
    return m.group(1), m.group(2)


def parse_target(target, cwd, forge_name):
    """Return (forge, number or None, branch or None)."""
    number, branch = None, None
    if target and "://" in target:
        u = urllib.parse.urlparse(target)
        path = u.path.strip("/")
        m = re.match(r"(.+?)/pull/(\d+)", path)
        if m:
            return GitHub(u.hostname, m.group(1)), int(m.group(2)), None
        m = re.match(r"(.+?)/-/merge_requests/(\d+)", path)
        if m:
            return GitLab(u.hostname, m.group(1)), int(m.group(2)), None
        raise SystemExit(f"not a PR or MR URL: {target}")

    remote = run(["git", "remote", "get-url", "origin"], cwd=cwd).strip()
    host, project = parse_remote(remote)
    if target:
        number = int(target.lstrip("#!"))
    else:
        branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd).strip()
    name = forge_name or ("github" if "github" in host else "gitlab")
    cls = GitHub if name == "github" else GitLab
    return cls(host, project), number, branch


def preflight(forge):
    if not shutil.which(forge.cli):
        emit("setup", f"{forge.cli} is not installed. Install it, then start the watcher again.")
        sys.exit(2)
    names = forge.token_vars()
    if not any(os.environ.get(n) for n in names):
        emit("setup", f"{' or '.join(names)} is not set. Export it from a file your shell loads "
                      "(for example ~/.zshenv or ~/.profile), then restart Claude Code.")
        sys.exit(2)


def state_path(forge, number):
    root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "pr-babysit"
    key = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{forge.host}_{forge.project}_{number}")
    return root / f"{key}.json"


def load_state(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    data["comments"] = set(data["comments"])
    data["events"] = set(data["events"])
    return data


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    out = dict(state, comments=sorted(state["comments"]), events=sorted(state["events"]))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(out))
    tmp.replace(path)


def once(state, key):
    if key in state["events"]:
        return False
    state["events"].add(key)
    return True


def report(snap, state, me, stuck_after):
    sha, short = snap["sha"], snap["sha"][:8]

    if state.get("sha") and state["sha"] != sha:
        emit("push", f"head moved to {short}")
    state["sha"] = sha

    behind, rebase, conflict = snap.get("behind"), snap.get("needs_rebase"), snap.get("conflict")
    if conflict is not None and conflict != state.get("conflict"):
        if conflict:
            emit("conflict", f"{snap['branch']} has merge conflicts with {snap['base']}")
        state["conflict"] = conflict
    lagging = bool(behind) or bool(rebase)
    if rebase is not None and (lagging, rebase) != tuple(state.get("lagging") or (False, False)):
        if lagging:
            need = ", and the host requires a rebase before merge" if rebase else ""
            emit("behind", f"{snap['branch']} is {behind} commit(s) behind {snap['base']}{need}")
        state["lagging"] = [lagging, rebase]

    blocking = [c for c in snap["checks"] if not c["allow_failure"]]
    for c in snap["checks"]:
        tag = None
        if c["status"] == "failed":
            tag = "failed"
        elif c["status"] == "manual" and not c["allow_failure"]:
            tag = "manual"
        if tag and once(state, f"{sha}:{c['id']}:{c['status']}"):
            note = " (allowed to fail)" if c["allow_failure"] else ""
            emit(tag, f"{c['name']}{note} id={c['id']} {c['url']}")
        if (c["status"] == "pending" and c["waited"] >= stuck_after
                and once(state, f"{sha}:{c['id']}:stuck")):
            emit("stuck", f"{c['name']} has waited {int(c['waited'])} min for a runner "
                          f"id={c['id']} {c['url']}")

    unfinished = ("waiting", "pending", "running", "manual")
    if blocking and not any(c["status"] in unfinished for c in blocking):
        failed = [c["name"] for c in blocking if c["status"] == "failed"]
        result = "failed" if failed else "passed"
        if once(state, f"{sha}:pipeline:{result}"):
            detail = f": {', '.join(failed)}" if failed else ""
            emit("pipeline", f"{result} for {short}, {len(failed)} of {len(blocking)} checks failed{detail}")

    for r in snap["reviews"]:
        if r["author"] != me and once(state, f"review:{r['id']}"):
            emit("review", f"@{r['author']} {r['state']} {r['url']}")

    for c in snap["comments"]:
        if c["id"] in state["comments"]:
            continue
        state["comments"].add(c["id"])
        if c["author"] == me:
            continue
        where = f" on {c['where']}" if c["where"] else ""
        emit("comment", f"@{c['author']}{where}: \"{flat(c['body'])}\" {c['url']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", nargs="?", help="PR/MR URL or number (default: the current branch's)")
    ap.add_argument("-C", dest="cwd", default=".", help="repo directory (default: .)")
    ap.add_argument("--forge", choices=["github", "gitlab"], help="override host detection")
    ap.add_argument("--interval", type=int, default=60, help="seconds between polls (default 60)")
    ap.add_argument("--stuck-after", type=int, default=30,
                    help="minutes a job may stay pending before [stuck] (default 30)")
    ap.add_argument("--once", action="store_true", help="poll once, print events, do not save state")
    args = ap.parse_args()

    forge, number, branch = parse_target(args.target, args.cwd, args.forge)
    preflight(forge)

    try:
        me = forge.me()
        if number is None:
            number = forge.find_number(branch)
            if number is None:
                emit("setup", f"no open PR/MR for branch {branch} in {forge.project}")
                sys.exit(2)
    except AuthError as e:
        emit("auth", f"{forge.cli} rejected the token: {e}")
        sys.exit(2)
    except (ApiError, subprocess.TimeoutExpired) as e:
        emit("setup", f"cannot reach {forge.host} through {forge.cli}: {e}")
        sys.exit(2)

    path = state_path(forge, number)
    state = load_state(path)
    fresh = state is None
    if fresh:
        state = {"comments": set(), "events": set()}

    failures, attached = 0, False
    while True:
        try:
            snap = forge.snapshot(number)
            failures = 0
            if fresh:
                # Comments that predate the watch are context, not new events.
                state["comments"] = {c["id"] for c in snap["comments"]}
                fresh = False
            if not attached:
                emit("watch", f"{'resumed' if state.get('sha') else 'attached'} {snap['url']} "
                              f"\"{flat(snap['title'], 80)}\", branch {snap['branch']} -> {snap['base']}, "
                              f"{len(snap['comments'])} comment(s), polling every {args.interval}s")
                attached = True
            report(snap, state, me, args.stuck_after)
            if not args.once:
                save_state(path, state)
            if snap["state"] != "open":
                emit(snap["state"], snap["url"])
                return 0
        except AuthError as e:
            emit("auth", f"{forge.cli} rejected the token: {e}")
            return 2
        except (ApiError, subprocess.TimeoutExpired, ValueError, KeyError) as e:
            failures += 1
            if failures == 5:
                emit("error", f"API calls failed 5 polls in a row, still retrying: {e}")
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
