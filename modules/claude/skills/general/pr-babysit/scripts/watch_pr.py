#!/usr/bin/env python3
"""Watch a GitHub PR or GitLab MR and print one line per event worth acting on.

Polls through `gh api` / `glab api`, authenticated only by GITHUB_TOKEN (or
GH_TOKEN) / GITLAB_TOKEN. What has been reported is kept in a cache file, so
re-arming the watcher after a Monitor timeout never repeats an event.

Events: [watch] [setup] [busy] [auth] [error] [push] [failed] [manual] [stuck]
        [stage] [pipeline] [behind] [conflict] [comment] [review] [merged] [closed]

Pipeline events end with "| <progress>": every stage in pipeline order with
its state, e.g. "CI ✓ · QA ⏳ · EU". A stage is a GitLab stage, or on GitHub
the part of the check name before " / " (a reusable workflow call).
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


def when(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def age_minutes(iso):
    if not iso:
        return 0
    return (datetime.now(timezone.utc) - when(iso)).total_seconds() / 60


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
            "fork": (pr["head"].get("repo") or {}).get("full_name") != pr["base"]["repo"]["full_name"],
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
            group, _, job = c["name"].partition(" / ")
            snap["checks"].append({
                "id": c["id"],
                "name": c["name"],
                "group": group,
                "job": job or group,
                "status": self.check_status(c),
                "url": c.get("html_url") or c.get("details_url") or "",
                "waited": age_minutes(c.get("started_at")) if c["status"] == "queued" else 0,
                "started": c.get("started_at"),
                "finished": c.get("completed_at"),
                "allow_failure": False,
            })
        for s in self.api(f"{self.repo()}/commits/{sha}/status").get("statuses", []):
            state = {"success": "success", "pending": "pending"}.get(s["state"], "failed")
            snap["checks"].append({
                "id": f"status:{s['context']}",
                "name": s["context"],
                "group": s["context"],
                "job": s["context"],
                "status": state,
                "url": s.get("target_url") or "",
                "waited": age_minutes(s.get("created_at")) if state == "pending" else 0,
                "started": s.get("created_at"),
                "finished": s.get("updated_at") if state != "pending" else None,
                "allow_failure": False,
            })
        # A run waiting for first-time-contributor approval has no check runs
        # yet. Environment approvals are already a "waiting" check run.
        runs = self.api(f"{self.repo()}/actions/runs?head_sha={sha}&per_page=100")
        for r in runs.get("workflow_runs", []):
            if r["status"] == "action_required":
                snap["checks"].append({
                    "id": f"run:{r['id']}",
                    "name": f"workflow {r['name']} ({r['status'].replace('_', ' ')})",
                    "status": "manual",
                    "url": r["html_url"],
                    "waited": 0,
                    "allow_failure": False,
                })

        for t in self.review_threads(number):
            line = t.get("line") or t.get("originalLine")
            for c in t["comments"]["nodes"]:
                author = c.get("author") or {}
                # GraphQL drops the "[bot]" suffix that REST logins carry.
                bot = "[bot]" if author.get("__typename") == "Bot" else ""
                snap["comments"].append({
                    "id": f"rc:{c['databaseId']}",
                    "author": author.get("login", "ghost") + bot,
                    "where": f"{t['path']}:{line}" if line else t["path"],
                    "body": c["body"],
                    "url": c["url"],
                    "resolved": t["isResolved"],
                })
        # Conversation comments and review summaries cannot be resolved, so
        # they always count as open.
        for c in self.pages(f"repos/{self.project}/issues/{number}/comments"):
            snap["comments"].append({
                "id": f"ic:{c['id']}",
                "author": c["user"]["login"],
                "where": "",
                "body": c["body"],
                "url": c["html_url"],
                "resolved": False,
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
                    "resolved": False,
                })
        return snap

    THREADS_QUERY = """
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved path line originalLine
              comments(first: 100) { nodes { databaseId author { login __typename } body url } }
            }
          }
        }
      }
    }"""

    def review_threads(self, number):
        # Resolved state exists only in GraphQL, not on the REST comments API.
        owner, name = self.project.split("/", 1)
        threads, after = [], None
        while True:
            cmd = [self.cli, "api", "graphql", "--hostname", self.host,
                   "-f", f"query={self.THREADS_QUERY}",
                   "-F", f"owner={owner}", "-F", f"name={name}", "-F", f"number={number}"]
            if after:
                cmd += ["-f", f"after={after}"]
            page = json.loads(run(cmd))["data"]["repository"]["pullRequest"]["reviewThreads"]
            threads += page["nodes"]
            if not page["pageInfo"]["hasNextPage"]:
                return threads
            after = page["pageInfo"]["endCursor"]

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
            "fork": mr.get("source_project_id") != mr.get("target_project_id"),
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
                    "resolved": bool(n.get("resolvable") and n.get("resolved")),
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
            "group": j["stage"],
            "job": j["name"],
            "status": status,
            "url": url,
            "waited": (queued or 0) / 60,
            "started": j.get("started_at"),
            "finished": j.get("finished_at"),
            "allow_failure": j.get("allow_failure", False),
        }


def parse_remote(url):
    m = re.match(r"^(?:\w+://)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?/?$", url.strip())
    return (m.group(1), m.group(2)) if m else ("", "")


def parse_url(url):
    """Return (forge, number) for a PR or MR URL."""
    u = urllib.parse.urlparse(url)
    path = u.path.strip("/")
    m = re.match(r"(.+?)/pull/(\d+)", path)
    if m:
        return GitHub(u.hostname, m.group(1)), int(m.group(2))
    m = re.match(r"(.+?)/-/merge_requests/(\d+)", path)
    if m:
        return GitLab(u.hostname, m.group(1)), int(m.group(2))
    emit("setup", f"not a PR or MR URL: {url}")
    sys.exit(2)


def find_remote(forge, cwd):
    """Name of the remote in cwd that points at the PR's repo, or None."""
    try:
        out = run(["git", "remote", "-v"], cwd=cwd)
    except (ApiError, AuthError, OSError):
        return None
    want = (forge.host.lower(), forge.project.lower())
    for line in out.splitlines():
        name, url = line.split()[:2]
        host, project = parse_remote(url)
        if (host.lower(), project.lower()) == want:
            return name
    return None


def take_lock(base):
    """Hold an exclusive lock for this PR for the life of the process."""
    import fcntl

    base.parent.mkdir(parents=True, exist_ok=True)
    handle = open(f"{base}.lock", "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return None
    return handle


def preflight(forge):
    if not shutil.which(forge.cli):
        emit("setup", f"{forge.cli} is not installed. Install it, then start the watcher again.")
        sys.exit(2)
    names = forge.token_vars()
    if not any(os.environ.get(n) for n in names):
        emit("setup", f"{' or '.join(names)} is not set. Export it from a file your shell loads "
                      "(for example ~/.zshenv or ~/.profile), then restart Claude Code.")
        sys.exit(2)


def pr_base(forge, number):
    """Cache path prefix shared by this PR's lock and state files."""
    root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "pr-babysit"
    return root / re.sub(r"[^A-Za-z0-9_.-]", "_", f"{forge.host}_{forge.project}_{number}")


def session_state(base, session):
    """State file for this session. Other sessions' files for the PR are removed,
    so a new session starts clean and reports everything still open."""
    keep = Path(f"{base}.{session}.json")
    for old in base.parent.glob(f"{base.name}.*.json"):
        if old != keep:
            old.unlink(missing_ok=True)
    return keep


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
    tmp = Path(f"{path}.tmp")
    tmp.write_text(json.dumps(out))
    tmp.replace(path)


def once(state, key):
    if key in state["events"]:
        return False
    state["events"].add(key)
    return True


UNFINISHED = ("waiting", "pending", "running", "manual")
MARK = {"passed": "✓", "failed": "✗", "canceled": "⊘", "running": "⏳", "manual": "⏸", "waiting": ""}


def stages(checks):
    """Group checks into stages, in pipeline order (by first job id)."""
    groups = {}
    for c in checks:
        if c.get("group"):
            groups.setdefault(c["group"], []).append(c)

    def first_id(jobs):
        ids = [j["id"] for j in jobs if isinstance(j["id"], int)]
        return min(ids) if ids else float("inf")

    out = []
    for name, jobs in sorted(groups.items(), key=lambda g: first_id(g[1])):
        counted = [j for j in jobs if not j["allow_failure"]] or jobs
        seen = {j["status"] for j in counted}
        if seen <= {"skipped"}:
            continue
        if "failed" in seen:
            status = "failed"
        elif seen & {"running", "pending"}:
            status = "running"
        elif "manual" in seen:
            status = "manual"
        elif "waiting" in seen:
            status = "waiting"
        elif "canceled" in seen:
            status = "canceled"
        else:
            status = "passed"
        out.append({
            "name": name,
            "status": status,
            "done": not seen & set(UNFINISHED),
            "jobs": [j["job"] for j in jobs if j["status"] != "skipped"],
        })
    return out


def progress(groups, detail=None):
    parts = []
    for g in groups:
        text = f"{g['name']} {MARK[g['status']]}".strip()
        if g["name"] == detail and g["jobs"] != [g["name"]]:
            text += f" ({', '.join(g['jobs'])})"
        parts.append(text)
    return " · ".join(parts)


def duration(checks):
    starts = [when(c["started"]) for c in checks if c.get("started")]
    ends = [when(c["finished"]) for c in checks if c.get("finished")]
    if not starts or not ends:
        return ""
    mins = int((max(ends) - min(starts)).total_seconds() // 60)
    return f" in {mins // 60}h {mins % 60}m" if mins >= 60 else f" in {max(mins, 1)}m"


def report(snap, state, me, stuck_after):
    sha, short = snap["sha"], snap["sha"][:8]
    # Stages already finished when a head is first seen are not news.
    fresh = state.get("sha") != sha
    groups = stages(snap["checks"])
    line = progress(groups)
    tail = f" | {line}" if line else ""

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
            emit(tag, f"{c['name']}{note} id={c['id']} {c['url']}{tail}")
        if (c["status"] == "pending" and c["waited"] >= stuck_after
                and once(state, f"{sha}:{c['id']}:stuck")):
            emit("stuck", f"{c['name']} has waited {int(c['waited'])} min for a runner "
                          f"id={c['id']} {c['url']}{tail}")

    finished = bool(blocking) and not any(c["status"] in UNFINISHED for c in blocking)
    for g in groups:
        # The pipeline event carries the last stages, so they are not sent twice.
        if g["done"] and once(state, f"{sha}:stage:{g['name']}") and not (fresh or finished):
            emit("stage", f"{g['name']} {g['status']} for {short} | {progress(groups, g['name'])}")
    if finished:
        failed = [c["name"] for c in blocking if c["status"] == "failed"]
        canceled = [c["name"] for c in blocking if c["status"] == "canceled"]
        result, names = ("failed", failed) if failed else ("canceled", canceled) if canceled else ("passed", [])
        if once(state, f"{sha}:pipeline:{result}"):
            detail = f": {', '.join(names)}" if names else ""
            emit("pipeline", f"{result} for {short}{duration(blocking)}, {len(names)} of "
                             f"{len(blocking)} checks {result if names else 'failed'}{detail}{tail}")

    for r in snap["reviews"]:
        if r["author"] != me and once(state, f"review:{r['id']}"):
            emit("review", f"@{r['author']} {r['state']} {r['url']}")

    for c in snap["comments"]:
        if c["resolved"] or c["id"] in state["comments"]:
            continue
        state["comments"].add(c["id"])
        if c["author"] == me:
            continue
        where = f" on {c['where']}" if c["where"] else ""
        emit("comment", f"@{c['author']}{where}: \"{flat(c['body'])}\" {c['url']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", help="PR or MR URL")
    ap.add_argument("-C", dest="cwd", default=".", help="local clone of the PR's repo (default: .)")
    ap.add_argument("--interval", type=int, default=60, help="seconds between polls (default 60)")
    ap.add_argument("--stuck-after", type=int, default=30,
                    help="minutes a job may wait for a runner before [stuck] (default 30)")
    ap.add_argument("--session", help="babysit session id; reuse it on every re-arm (required unless --once)")
    ap.add_argument("--once", action="store_true",
                    help="poll once and print events; no lock, state not saved")
    args = ap.parse_args()
    if not args.once and not args.session:
        ap.error("--session is required unless --once")

    forge, number = parse_url(args.url)
    remote = find_remote(forge, args.cwd)
    if remote is None:
        emit("setup", f"{os.path.abspath(args.cwd)} has no git remote for {forge.host}/{forge.project}. "
                      "Run from a clone of that repo, or pass -C <path>.")
        sys.exit(2)
    preflight(forge)

    base = pr_base(forge, number)
    lock = None if args.once else take_lock(base)
    if not args.once and lock is None:
        emit("busy", f"{args.url} is already being babysat by another session")
        sys.exit(2)

    try:
        me = forge.me()
    except AuthError as e:
        emit("auth", f"{forge.cli} rejected the token: {e}")
        sys.exit(2)
    except (ApiError, subprocess.TimeoutExpired) as e:
        emit("setup", f"cannot reach {forge.host} through {forge.cli}: {e}")
        sys.exit(2)

    path = None if args.once else session_state(base, args.session)
    state = (load_state(path) if path else None) or {"comments": set(), "events": set()}

    failures, attached = 0, False
    while True:
        try:
            snap = forge.snapshot(number)
            failures = 0
            if not attached:
                fork = " (from a fork)" if snap["fork"] else ""
                emit("watch", f"{'resumed' if state.get('sha') else 'attached'} {snap['url']} "
                              f"\"{flat(snap['title'], 80)}\", branch {snap['branch']}{fork} -> {snap['base']}, "
                              f"head {snap['sha']}, remote {remote}, "
                              f"{sum(not c['resolved'] and c['author'] != me for c in snap['comments'])} open comment(s), polling every {args.interval}s")
                attached = True
            report(snap, state, me, args.stuck_after)
            if path:
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
