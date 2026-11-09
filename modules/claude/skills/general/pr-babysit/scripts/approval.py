#!/usr/bin/env python3
"""Approvals for pr-babysit: the babysitter proposes an action that goes out
under the user's name, and it runs only once the user approves it in the
Alt+A popup or the Agents tray, or on its own when Settings > Approvals says
auto.

  approval.py propose reply  <url> --session S --comment ID --body TEXT [--commit SHA]
  approval.py propose push   <url> --session S [--check NAME=ok|failed]... [--for SHA=TEXT]...
  approval.py propose retry  <url> --session S --job ID --name NAME [--reason TEXT]
  approval.py propose manual <url> --session S --job ID --name NAME [--stage STAGE]
  approval.py propose deploy <url> --session S --job ID --name NAME
  approval.py propose move   <url> --session S --onto SHA
  approval.py approve <id> [--body-file FILE] [--drop SHA]...
  approval.py reject <id>
  approval.py dismiss <id>
  approval.py list

A proposal is one JSON file in $XDG_RUNTIME_DIR/agent-hub/approvals/, holding
exactly what will run: the reply's text and thread, the commits and the
lease, the job. Approving runs that and nothing else, so what leaves the
machine is what the user saw. What happened is written back into the file;
the babysit's watcher (watch_pr.py) reports it to the session as an
[approval] event. Anything a script can't do safely (dropping commits,
moving commits onto a new head) is handed back to the session that way
instead of run.
"""

import argparse
import contextlib
import fcntl
import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import watch_pr as w

ROOT = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp") / "agent-hub" / "approvals"
LOG = ROOT / "log.jsonl"
KINDS = ("reply", "push", "retry", "manual", "deploy", "move")
# A manual job whose name or stage says it deploys always waits for the user,
# whatever Settings say.
DEPLOYS = re.compile(r"deploy|release|prod", re.IGNORECASE)


def emit(tag, msg):
    print(f"[{tag}] {msg}", flush=True)


# ------------------------------------------------------------ settings

def policy(kind):
    """'auto', 'ask' or 'off' for a kind of action, from Settings > Approvals."""
    if kind == "reply":
        return {"post": "auto", "draft": "ask", "off": "off"}[w.choice("approvals.reply", "draft", ("off", "draft", "post"))]
    if kind == "deploy":
        return "ask"
    return w.choice(f"approvals.{kind}", "ask", ("ask", "auto"))


# ------------------------------------------------------------ the store

def path_of(pid):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", pid or ""):
        raise SystemExit(f"Not an approval id: {pid!r}")
    return ROOT / f"{pid}.json"


def load(pid):
    try:
        return json.loads(path_of(pid).read_text())
    except (OSError, ValueError):
        return None


def save(p):
    ROOT.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / f".{p['id']}.tmp"
    tmp.write_text(json.dumps(p, indent=2))
    tmp.replace(path_of(p["id"]))


def remove(pid):
    path_of(pid).unlink(missing_ok=True)
    (ROOT / f"{pid}.lock").unlink(missing_ok=True)


def every():
    out = []
    with contextlib.suppress(OSError):
        for f in sorted(ROOT.glob("*.json")):
            with contextlib.suppress(OSError, ValueError):
                out.append(json.loads(f.read_text()))
    return out


@contextlib.contextmanager
def locked(pid):
    """One approval runs once, however many buttons were pressed."""
    ROOT.mkdir(parents=True, exist_ok=True)
    with open(ROOT / f"{pid}.lock", "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(json.dumps({"ok": False, "message": "Already running"})) from None
        yield


def log(p, result):
    ROOT.mkdir(parents=True, exist_ok=True)
    entry = {"at": int(time.time() * 1000), "pr": p["pr"]["key"], "kind": p["kind"],
             "job": (p.get("job") or {}).get("id"), "ok": result["ok"], "auto": result.get("auto", False)}
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def history():
    try:
        return [json.loads(line) for line in LOG.read_text().splitlines() if line.strip()]
    except (OSError, ValueError):
        return []


# ------------------------------------------------------------ git and the forge

def git(cwd, *args):
    p = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip()
        raise RuntimeError(err.splitlines()[-1] if err else f"git {args[0]} failed")
    return p.stdout.strip()


def forge_of(p):
    forge, _ = w.parse_url(p["pr"]["url"])
    return forge


def api(forge, path, method="GET", fields=None, typed=None):
    cmd = [forge.cli, "api", "--hostname", forge.host, "-X", method, path]
    for k, v in (fields or {}).items():
        cmd += ["-f", f"{k}={v}"]
    for k, v in (typed or {}).items():
        cmd += ["-F", f"{k}={v}"]
    out = w.run(cmd)
    return json.loads(out) if out.strip() else None


def pr_info(url):
    forge, number = w.parse_url(url)
    github = isinstance(forge, w.GitHub)
    return {
        "key": f"{forge.host}/{forge.project}#{number}",
        "url": url,
        "host": forge.host,
        "project": forge.project,
        "number": number,
        "forge": "github" if github else "gitlab",
        "repo": forge.project.rsplit("/", 1)[-1],
        "ref": f"{'#' if github else '!'}{number}",
    }


def saved(url, session):
    forge, number = w.parse_url(url)
    return w.load_notes(w.notes_path(w.pr_base(forge, number), session))


def commit_info(cwd, sha):
    out = git(cwd, "show", "--numstat", "--format=%H%x00%s", sha)
    head, *rest = out.splitlines()
    full, subject = head.split("\x00", 1)
    added = removed = files = 0
    for line in rest:
        parts = line.split("\t")
        if len(parts) == 3:
            files += 1
            added += int(parts[0]) if parts[0].isdigit() else 0
            removed += int(parts[1]) if parts[1].isdigit() else 0
    return {"sha": full, "subject": subject, "added": added, "removed": removed, "files": files}


def remote_head(cwd, remote, branch):
    out = git(cwd, "ls-remote", remote, f"refs/heads/{branch}")
    return out.split()[0] if out else ""


# ------------------------------------------------------------ proposing

def fetch_comment(url, cid):
    """The comment a reply answers, as the forge has it now."""
    forge, number = w.parse_url(url)
    kind, _, num = cid.partition(":")
    if isinstance(forge, w.GitHub):
        path = {"rc": f"repos/{forge.project}/pulls/comments/{num}",
                "ic": f"repos/{forge.project}/issues/comments/{num}",
                "rv": f"repos/{forge.project}/pulls/{number}/reviews/{num}"}.get(kind)
    else:
        path = f"{forge.proj()}/merge_requests/{number}/notes/{num}" if kind == "note" else None
    if not path or not num.isdigit():
        raise SystemExit(f"Not a comment id from a [comment] event: {cid}")
    c = forge.api(path)
    author = (c.get("user") or c.get("author") or {})
    where = ""
    if c.get("path"):
        line = c.get("line") or c.get("original_line")
        where = f"{c['path']}:{line}" if line else c["path"]
    pos = c.get("position") or {}
    if isinstance(pos, dict) and (pos.get("new_path") or pos.get("old_path")):
        line = pos.get("new_line") or pos.get("old_line")
        where = f"{pos.get('new_path') or pos.get('old_path')}:{line}" if line else pos.get("new_path") or pos.get("old_path")
    return {"id": cid, "author": author.get("login") or author.get("username") or "", "where": where,
            "body": c.get("body") or "", "url": c.get("html_url") or c.get("url") or url}


def build(args):
    pr = pr_info(args.url)
    notes = saved(args.url, args.session)
    p = {"id": f"{int(time.time() * 1000)}-{args.kind}-{secrets.token_hex(3)}", "kind": args.kind,
         "at": int(time.time() * 1000), "session": args.session, "pr": pr, "status": "pending",
         "claude_session": os.environ.get("CLAUDE_CODE_SESSION_ID", ""), "pane": os.environ.get("TMUX_PANE", ""),
         "script": str(Path(__file__).resolve())}
    where = f"{pr['repo']} {pr['ref']}"
    if args.kind == "reply":
        if not args.comment or args.body is None:
            raise SystemExit("A reply needs --comment and --body")
        c = fetch_comment(args.url, args.comment)
        p["thread"] = c
        p["body"] = args.body
        p["title"] = f"Reply to @{c['author']}" + (f" on {c['where']}" if c["where"] else "")
        if args.commit:
            if not notes.get("worktree"):
                raise SystemExit("--commit needs the worktree saved with watch_pr.py --set worktree=...")
            p["commit"] = commit_info(notes["worktree"], args.commit)
        p["key"] = f"reply:{c['id']}"
    elif args.kind in ("push", "move"):
        need = [k for k in ("worktree", "lease_sha", "branch", "remote") if not notes.get(k)]
        if need:
            raise SystemExit(f"Save {', '.join(need)} first: watch_pr.py <url> --session <id> --set KEY=VALUE")
        wt, lease = notes["worktree"], notes["lease_sha"]
        p.update(worktree=wt, remote=notes["remote"], branch=notes["branch"], lease=lease, local=git(wt, "branch", "--show-current"))
        if args.kind == "move":
            if not args.onto:
                raise SystemExit("A move needs --onto <sha>, the PR's new head")
            p["onto"] = args.onto
            count = int(git(wt, "rev-list", "--count", f"{lease}..HEAD") or 0)
            p["title"] = f"Move {count} local commit{'s' if count != 1 else ''} onto {args.onto[:7]}"
            p["key"] = "move"
        else:
            shas = git(wt, "rev-list", "--reverse", f"{lease}..HEAD").split()
            if not shas:
                raise SystemExit(f"Nothing to push: {p['local']} has no commits past {lease[:7]}")
            if git(wt, "status", "--porcelain", "--untracked-files=no"):
                raise SystemExit("The worktree has uncommitted changes; commit or drop them first")
            notes_for = dict(pair.split("=", 1) for pair in args.for_ or [] if "=" in pair)
            p["commits"] = []
            for sha in shas:
                info = commit_info(wt, sha)
                info["note"] = next((v for k, v in notes_for.items() if sha.startswith(k)), "")
                p["commits"].append(info)
            p["head"] = shas[-1]
            p["checks"] = []
            for pair in args.check or []:
                name, _, state = pair.rpartition("=")
                p["checks"].append({"name": name or state, "ok": state in ("ok", "passed", "pass")})
            try:
                p["remote_head"] = remote_head(wt, p["remote"], p["branch"])
            except RuntimeError:
                p["remote_head"] = ""
            n = len(shas)
            p["title"] = f"Push {n} commit{'s' if n != 1 else ''} to {p['branch']}"
            p["command"] = push_command(p)
            p["key"] = "push"
    else:
        if not args.job or not args.name:
            raise SystemExit(f"A {args.kind} needs --job and --name")
        p["job"] = {"id": args.job, "name": args.name, "reason": args.reason or "", "stage": args.stage or ""}
        verb = {"retry": "Retry", "manual": "Run", "deploy": "Approve"}[args.kind]
        p["title"] = f"{verb} {args.name}"
        p["key"] = f"{args.kind}:{args.job}"
    p["where"] = where
    return p


def push_command(p, head=None):
    return (f"git push --force-with-lease={p['branch']}:{p['lease']} {p['remote']} "
            f"{head or p['local']}:{p['branch']}")


def propose(args):
    mode = policy(args.kind)
    if mode == "off":
        emit("refused", "Settings > Approvals > Post a reply is off: keep the reply for the briefing")
        return 1
    if args.kind == "manual" and pr_info(args.url)["forge"] == "github":
        # GitHub's waiting jobs are environment or workflow approvals.
        args.kind, mode = "deploy", "ask"
    p = build(args)
    if args.kind == "manual" and DEPLOYS.search(f"{args.name} {args.stage or ''}"):
        mode = "ask"
    retried = any(h.get("kind") == "retry" and str(h.get("job")) == str(args.job) and h.get("pr") == p["pr"]["key"] for h in history())
    if args.kind == "retry" and retried:
        mode = "ask"
    # A new proposal replaces an older one about the same thing.
    for old in every():
        if old.get("pr", {}).get("key") == p["pr"]["key"] and old.get("key") == p["key"] and old.get("status") in ("pending", "failed"):
            remove(old["id"])
    save(p)
    if mode == "auto":
        result = approve(p["id"], auto=True)
        tag = "auto" if result["ok"] else "failed"
        emit(tag, f"{p['id']} {result['message']}")
        return 0 if result["ok"] else 1
    emit("proposed", f"{p['id']} {p['title']}: waiting for approval in Alt+A and the Agents tray")
    return 0


# ------------------------------------------------------------ approving

def finish(p, status, ok, message, auto=False, **extra):
    p["status"] = status
    p["result"] = {"ok": ok, "message": message, "at": int(time.time() * 1000), "auto": auto, **extra}
    # The session already heard about what it ran itself.
    p["reported"] = auto
    save(p)
    if status in ("done", "failed"):
        log(p, p["result"])
    return {"ok": ok, "message": message, "id": p["id"], "status": status}


def run_reply(p, forge):
    t, body = p["thread"], p["body"]
    kind, _, num = t["id"].partition(":")
    number = p["pr"]["number"]
    if isinstance(forge, w.GitHub):
        if kind == "rc":
            api(forge, f"repos/{forge.project}/pulls/{number}/comments/{num}/replies", "POST", {"body": body})
        else:
            api(forge, f"repos/{forge.project}/issues/{number}/comments", "POST", {"body": body})
    else:
        discussion = None
        for d in forge.pages(f"{forge.proj()}/merge_requests/{number}/discussions"):
            if any(str(n["id"]) == num for n in d["notes"]):
                discussion = d["id"]
                break
        if not discussion:
            raise RuntimeError(f"The thread for note {num} is gone")
        api(forge, f"{forge.proj()}/merge_requests/{number}/discussions/{discussion}/notes", "POST", {"body": body})
    return f"Posted the reply to @{t['author']}"


def run_push(p):
    wt = p["worktree"]
    head = git(wt, "rev-parse", "HEAD")
    if head != p["head"]:
        raise RuntimeError(f"{p['local']} moved since the proposal ({p['head'][:7]} → {head[:7]}); propose it again")
    now = remote_head(wt, p["remote"], p["branch"])
    if now != p["lease"]:
        raise RuntimeError(f"Someone pushed to {p['branch']} since {p['lease'][:7]} (now {now[:7] or 'gone'}); nothing was pushed")
    git(wt, "push", f"--force-with-lease={p['branch']}:{p['lease']}", p["remote"], f"{p['head']}:refs/heads/{p['branch']}")
    n = len(p["commits"])
    return f"Pushed {n} commit{'s' if n != 1 else ''} to {p['branch']}, now at {p['head'][:7]}", {"head": p["head"]}


def run_job(p, forge):
    job, kind = p["job"], p["kind"]
    jid = str(job["id"])
    if isinstance(forge, w.GitHub):
        if jid.startswith("status:"):
            raise RuntimeError(f"{job['name']} is an outside CI status; it can only be rerun from its own page")
        if jid.startswith("run:"):
            api(forge, f"repos/{forge.project}/actions/runs/{jid[4:]}/approve", "POST")
            return f"Approved workflow run {job['name']}"
        if kind == "retry":
            api(forge, f"repos/{forge.project}/actions/jobs/{jid}/rerun", "POST")
            return f"Retried {job['name']}"
        # An environment approval: the job is a check run of a workflow run.
        run_id = (forge.api(f"repos/{forge.project}/actions/jobs/{jid}") or {}).get("run_id")
        pending = forge.api(f"repos/{forge.project}/actions/runs/{run_id}/pending_deployments") or []
        envs = [d["environment"]["id"] for d in pending if d.get("current_user_can_approve")]
        if not envs:
            raise RuntimeError(f"Nothing you can approve is waiting on {job['name']}")
        cmd = [forge.cli, "api", "--hostname", forge.host, "-X", "POST",
               f"repos/{forge.project}/actions/runs/{run_id}/pending_deployments",
               "-f", "state=approved", "-f", "comment=Approved from pr-babysit"]
        for e in envs:
            cmd += ["-F", f"environment_ids[]={e}"]
        w.run(cmd)
        return f"Approved the deployment for {job['name']}"
    action = {"retry": "retry", "manual": "play", "deploy": "play"}[kind]
    api(forge, f"{forge.proj()}/jobs/{jid}/{action}", "POST")
    return f"{'Retried' if action == 'retry' else 'Started'} {job['name']}"


def approve(pid, body=None, drop=(), auto=False):
    with locked(pid):
        p = load(pid)
        if not p:
            return {"ok": False, "message": "That approval is gone"}
        if p["status"] not in ("pending", "failed"):
            return {"ok": False, "message": f"Already {p['status']}"}
        if body is not None and p["kind"] == "reply" and body != p["body"]:
            p["body"], p["edited"] = body, True
        if p["kind"] == "move":
            return finish(p, "handed", True, f"Approved: the session moves its commits onto {p['onto'][:7]}")
        if drop and p["kind"] == "push":
            gone = [c["sha"] for c in p["commits"] if any(c["sha"].startswith(d) for d in drop)]
            if gone:
                return finish(p, "handed", True, f"Approved without {len(gone)} commit(s): the session drops them, checks and asks again",
                              drop=gone)
        try:
            forge = forge_of(p)
            extra = {}
            if p["kind"] == "reply":
                message = run_reply(p, forge)
            elif p["kind"] == "push":
                message, extra = run_push(p)
            else:
                message = run_job(p, forge)
        except w.AuthError as e:
            return finish(p, "failed", False, f"{token_hint(p)} ({e})", auto)
        except (w.ApiError, RuntimeError, subprocess.TimeoutExpired, OSError) as e:
            return finish(p, "failed", False, str(e), auto)
        return finish(p, "done", True, message, auto, **extra)


def token_hint(p):
    names = "GITHUB_TOKEN or GH_TOKEN" if p["pr"]["forge"] == "github" else "GITLAB_TOKEN"
    return f"{names} was refused or isn't set where this ran; export it from ~/.zshenv"


def reject(pid):
    with locked(pid):
        p = load(pid)
        if not p:
            return {"ok": False, "message": "That approval is gone"}
        if p["status"] != "pending":
            return {"ok": False, "message": f"Already {p['status']}"}
        return finish(p, "rejected", True, "Rejected")


# ------------------------------------------------------------ the watcher's side

def outcomes(key, session):
    """Settled proposals of this babysit that the session hasn't heard about,
    as (tag, message) events. Each is reported once; settled ones other than
    failures then leave, a failure staying in the tray until it's proposed
    again or dismissed."""
    events = []
    for p in every():
        if p.get("pr", {}).get("key") != key or p.get("session") != session:
            continue
        if p.get("status") == "pending" or p.get("reported"):
            if p.get("reported") and p.get("status") != "failed":
                remove(p["id"])
            continue
        r = p.get("result") or {}
        what = f"{p['kind']} {p['id']} ({p['title']})"
        if p["status"] == "done":
            edited = " with the reply as the user edited it" if p.get("edited") else ""
            events.append(f"{what} approved{edited}: {r.get('message', '')}")
        elif p["status"] == "failed":
            events.append(f"{what} failed: {r.get('message', '')}. Work out why, fix what you can, and propose it again")
        elif p["status"] == "rejected":
            events.append(f"{what} rejected by the user; keep it for the briefing")
        elif p["status"] == "handed" and p["kind"] == "move":
            events.append(f"{what} approved: rebase {p['local']} onto {p['onto']} (git rebase --onto {p['onto']} {p['lease']}), "
                          "run lint and tests, save the new lease_sha, then propose the push")
        elif p["status"] == "handed":
            shas = " ".join(s[:7] for s in r.get("drop", []))
            events.append(f"{what} approved without {shas}: drop those commits from {p['local']}, "
                          "run lint and tests, then propose the push again")
        p["reported"] = True
        if p["status"] == "failed":
            save(p)
        else:
            remove(p["id"])
    return events


# ------------------------------------------------------------ command line

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("propose", help="ask the user to approve an action")
    pr.add_argument("kind", choices=KINDS)
    pr.add_argument("url")
    pr.add_argument("--session", required=True, help="the babysit's session id, as given to watch_pr.py")
    pr.add_argument("--comment", help="reply: the comment's id from its [comment] event (rc:, ic:, rv: or note:)")
    pr.add_argument("--body", help="reply: the text to post, exactly")
    pr.add_argument("--commit", help="reply: the commit that addressed it")
    pr.add_argument("--check", action="append", help="push: a check you ran, NAME=ok or NAME=failed")
    pr.add_argument("--for", dest="for_", action="append", help="push: SHA=what it addresses, e.g. '#8 @alice'")
    pr.add_argument("--job", help="retry, manual, deploy: the id from the event")
    pr.add_argument("--name", help="retry, manual, deploy: the job's name")
    pr.add_argument("--reason", help="retry: why it looks flaky")
    pr.add_argument("--stage", help="manual: the job's stage")
    pr.add_argument("--onto", help="move: the PR's new head")
    ok = sub.add_parser("approve", help="run an approval as proposed")
    ok.add_argument("id")
    ok.add_argument("--body-file", help="reply: post this file's text instead")
    ok.add_argument("--drop", action="append", default=[], help="push: leave this commit out; hands the push back")
    no = sub.add_parser("reject", help="turn a proposal down")
    no.add_argument("id")
    gone = sub.add_parser("dismiss", help="forget a failed or pending proposal")
    gone.add_argument("id")
    sub.add_parser("list", help="every proposal, as JSON")
    args = ap.parse_args(argv)

    if args.cmd == "propose":
        return propose(args)
    if args.cmd == "approve":
        body = Path(args.body_file).read_text().rstrip("\n") if args.body_file else None
        result = approve(args.id, body, args.drop)
    elif args.cmd == "reject":
        result = reject(args.id)
    elif args.cmd == "dismiss":
        remove(path_of(args.id).stem)
        result = {"ok": True, "message": "Dismissed"}
    else:
        print(json.dumps(every(), indent=2))
        return 0
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
