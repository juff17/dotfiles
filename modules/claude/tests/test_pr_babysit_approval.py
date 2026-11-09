"""pr-babysit's approval.py: proposals, what approving runs, Settings' auto
and ask, and what the watcher hears back. GitHub is a fake `gh` on PATH that
logs its calls; pushes go to a real bare repo in a temp folder."""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "skills/general/pr-babysit/scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("approval", SCRIPTS / "approval.py")
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)
w = ap.w

URL = "https://github.com/u/gad/pull/91"
KEY = "github.com/u/gad#91"

FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
path = next(a for a in args[1:] if not a.startswith("-") and a not in ("api", "POST", "GET") and "/" in a)
replies = json.load(open(os.environ["FAKE_REPLIES"])) if os.path.exists(os.environ["FAKE_REPLIES"]) else {}
r = replies.get(path, {})
if r == "fail":
    print("HTTP 422: Unprocessable", file=sys.stderr)
    sys.exit(1)
print(json.dumps(r))
"""


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True).stdout.strip()


class Approvals(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        bin_ = self.tmp / "bin"
        bin_.mkdir()
        for cli in ("gh", "glab"):
            (bin_ / cli).write_text(FAKE_GH)
            (bin_ / cli).chmod(0o755)
        self.log = self.tmp / "gh.log"
        self.replies = self.tmp / "replies.json"
        env = mock.patch.dict(os.environ, {
            "PATH": f"{bin_}:{os.environ['PATH']}",
            "FAKE_LOG": str(self.log),
            "FAKE_REPLIES": str(self.replies),
            "XDG_CACHE_HOME": str(self.tmp / "cache"),
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
            "CLAUDE_CODE_SESSION_ID": "claude-1", "TMUX_PANE": "%7",
        })
        env.start()
        self.addCleanup(env.stop)
        for name, value in (("ROOT", self.tmp / "approvals"), ("LOG", self.tmp / "approvals" / "log.jsonl")):
            p = mock.patch.object(ap, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.settings = self.tmp / "settings.json"
        p = mock.patch.object(w, "SETTINGS", self.settings)
        p.start()
        self.addCleanup(p.stop)
        self.reply({"repos/u/gad/pulls/comments/55": {
            "user": {"login": "alice"}, "path": "src/auth.py", "line": 42,
            "body": "This checks the cache first.", "html_url": "https://github.com/u/gad/pull/91#discussion_r55"}})

    def reply(self, replies):
        self.replies.write_text(json.dumps(replies))

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def posts(self):
        return [c for c in self.calls() if "POST" in c]

    def set(self, **values):
        self.settings.write_text(json.dumps(values))

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ap.main(list(argv))
        return code, out.getvalue().strip()

    def propose(self, *argv):
        code, out = self.run_cli("propose", *argv[:1], URL, "--session", "s1", *argv[1:])
        return code, out, (out.split()[1] if out.startswith("[") and len(out.split()) > 1 else "")

    # -------------------------------------------------------- the repo

    def repo(self):
        """A bare remote with feat, and a clone on babysit/91 two commits past it."""
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
        clone = self.tmp / "clone"
        subprocess.run(["git", "clone", "-q", str(remote), str(clone)], capture_output=True, check=True)
        (clone / "cache.py").write_text("ttl = 300\n")
        git(clone, "add", ".")
        git(clone, "commit", "-qm", "base")
        git(clone, "push", "-q", "origin", "HEAD:feat")
        lease = git(clone, "rev-parse", "HEAD")
        git(clone, "checkout", "-qb", "babysit/91")
        for i, text in enumerate(("ttl = 300\nvalid = True\n", "cache_ttl_seconds = 300\nvalid = True\n")):
            (clone / "cache.py").write_text(text)
            git(clone, "commit", "-qam", f"fix {i}")
        w.set_notes(w.notes_path(w.pr_base(w.parse_url(URL)[0], 91), "s1"),
                    [f"lease_sha={lease}", f"worktree={clone}", "branch=feat", "remote=origin"])
        return remote, clone, lease

    # -------------------------------------------------------- replies

    def test_a_reply_waits_then_posts_exactly_its_text_to_the_thread(self):
        code, out, pid = self.propose("reply", "--comment", "rc:55", "--body", "Fixed in 3f9a1c2.")
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("[proposed] "), out)
        p = ap.load(pid)
        self.assertEqual((p["status"], p["title"], p["thread"]["author"]), ("pending", "Reply to @alice on src/auth.py:42", "alice"))
        self.assertEqual((p["claude_session"], p["pane"], p["pr"]["ref"]), ("claude-1", "%7", "#91"))
        self.assertFalse(self.posts(), "nothing posted before approval")

        self.assertEqual(self.run_cli("approve", pid)[0], 0)
        posts = self.posts()
        self.assertEqual(len(posts), 1)
        self.assertIn("repos/u/gad/pulls/91/comments/55/replies", posts[0])
        self.assertIn("body=Fixed in 3f9a1c2.", posts[0])
        self.assertEqual(ap.load(pid)["status"], "done")

    def test_an_edited_reply_posts_the_edit_and_the_session_hears_so(self):
        _, _, pid = self.propose("reply", "--comment", "rc:55", "--body", "Draft")
        edit = self.tmp / "edit.txt"
        edit.write_text("Better wording\n")
        self.run_cli("approve", pid, "--body-file", str(edit))
        self.assertIn("body=Better wording", self.posts()[0])
        events = ap.outcomes(KEY, "s1")
        self.assertEqual(len(events), 1)
        self.assertIn("approved with the reply as the user edited it", events[0])
        self.assertEqual(ap.outcomes(KEY, "s1"), [], "reported once")
        self.assertIsNone(ap.load(pid), "a settled approval leaves once reported")

    def test_a_conversation_comment_is_answered_with_a_new_comment(self):
        self.reply({"repos/u/gad/issues/comments/9": {"user": {"login": "bob"}, "body": "Why?"}})
        _, _, pid = self.propose("reply", "--comment", "ic:9", "--body", "@bob because.")
        self.run_cli("approve", pid)
        self.assertIn("repos/u/gad/issues/91/comments", self.posts()[0])

    def test_replies_off_refuses_and_post_runs_without_asking(self):
        self.set(**{"approvals.reply": "off"})
        code, out, _ = self.propose("reply", "--comment", "rc:55", "--body", "x")
        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("[refused]"))
        self.set(**{"approvals.reply": "post"})
        code, out, pid = self.propose("reply", "--comment", "rc:55", "--body", "x")
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("[auto] "), out)
        self.assertEqual(ap.load(pid)["result"]["auto"], True)
        self.assertEqual(ap.outcomes(KEY, "s1"), [], "the session saw the auto result already")

    def test_a_rejected_reply_posts_nothing_and_is_reported(self):
        _, _, pid = self.propose("reply", "--comment", "rc:55", "--body", "x")
        self.assertEqual(self.run_cli("reject", pid)[0], 0)
        self.assertFalse(self.posts())
        self.assertIn("rejected by the user", ap.outcomes(KEY, "s1")[0])

    def test_a_failed_post_stays_for_the_tray_and_can_be_tried_again(self):
        _, _, pid = self.propose("reply", "--comment", "rc:55", "--body", "x")
        self.reply({"repos/u/gad/pulls/91/comments/55/replies": "fail"})
        code, out = self.run_cli("approve", pid)
        self.assertEqual(code, 1)
        self.assertIn("422", json.loads(out)["message"])
        self.assertIn("failed", ap.outcomes(KEY, "s1")[0])
        self.assertEqual(ap.load(pid)["status"], "failed", "kept after reporting")
        self.reply({})
        self.assertEqual(self.run_cli("approve", pid)[0], 0)

    def test_a_second_approve_does_nothing(self):
        _, _, pid = self.propose("reply", "--comment", "rc:55", "--body", "x")
        self.run_cli("approve", pid)
        code, out = self.run_cli("approve", pid)
        self.assertEqual((code, json.loads(out)["message"]), (1, "Already done"))
        self.assertEqual(len(self.posts()), 1)

    def test_another_babysit_session_never_hears_this_ones_outcomes(self):
        _, _, pid = self.propose("reply", "--comment", "rc:55", "--body", "x")
        self.run_cli("reject", pid)
        self.assertEqual(ap.outcomes(KEY, "other"), [])
        self.assertEqual(len(ap.outcomes(KEY, "s1")), 1)

    def test_a_new_proposal_replaces_the_older_one_about_the_same_comment(self):
        _, _, first = self.propose("reply", "--comment", "rc:55", "--body", "one")
        _, _, second = self.propose("reply", "--comment", "rc:55", "--body", "two")
        self.assertIsNone(ap.load(first))
        self.assertEqual(ap.load(second)["body"], "two")

    # -------------------------------------------------------- pushes

    def test_a_push_lists_its_commits_and_pushes_with_the_lease(self):
        remote, clone, lease = self.repo()
        head = git(clone, "rev-parse", "HEAD")
        code, out, pid = self.propose("push", "--check", "lint=ok", "--check", "unit tests 214=ok", "--for", f"{head[:7]}=#9 @bob")
        self.assertEqual(code, 0, out)
        p = ap.load(pid)
        self.assertEqual(p["title"], "Push 2 commits to feat")
        self.assertEqual([c["subject"] for c in p["commits"]], ["fix 0", "fix 1"])
        self.assertEqual(p["commits"][1]["note"], "#9 @bob")
        self.assertEqual(p["checks"], [{"name": "lint", "ok": True}, {"name": "unit tests 214", "ok": True}])
        self.assertEqual(p["remote_head"], lease)
        self.assertEqual(p["command"], f"git push --force-with-lease=feat:{lease} origin babysit/91:feat")

        self.assertEqual(self.run_cli("approve", pid)[0], 0)
        self.assertEqual(git(remote, "rev-parse", "feat"), head)
        self.assertIn("Pushed 2 commits to feat", ap.outcomes(KEY, "s1")[0])

    def test_a_push_is_refused_when_someone_pushed_since_the_lease(self):
        remote, clone, lease = self.repo()
        _, _, pid = self.propose("push")
        other = self.tmp / "other"
        subprocess.run(["git", "clone", "-q", "-b", "feat", str(remote), str(other)], capture_output=True, check=True)
        (other / "x").write_text("x")
        git(other, "add", ".")
        git(other, "commit", "-qm", "theirs")
        git(other, "push", "-q", "origin", "feat")
        theirs = git(other, "rev-parse", "HEAD")
        code, out = self.run_cli("approve", pid)
        self.assertEqual(code, 1)
        self.assertIn(f"Someone pushed to feat since {lease[:7]}", json.loads(out)["message"])
        self.assertEqual(git(remote, "rev-parse", "feat"), theirs, "their commit is still there")
        self.assertIn("propose it again", ap.outcomes(KEY, "s1")[0])

    def test_a_push_is_refused_when_the_branch_moved_after_the_proposal(self):
        remote, clone, lease = self.repo()
        _, _, pid = self.propose("push")
        (clone / "late.py").write_text("x")
        git(clone, "add", ".")
        git(clone, "commit", "-qm", "late")
        self.assertEqual(self.run_cli("approve", pid)[0], 1)
        self.assertEqual(git(remote, "rev-parse", "feat"), lease)

    def test_dropping_a_commit_hands_the_push_back_to_the_session(self):
        remote, clone, lease = self.repo()
        _, _, pid = self.propose("push")
        drop = ap.load(pid)["commits"][0]["sha"]
        self.assertEqual(self.run_cli("approve", pid, "--drop", drop[:7])[0], 0)
        self.assertEqual(git(remote, "rev-parse", "feat"), lease, "nothing pushed")
        event = ap.outcomes(KEY, "s1")[0]
        self.assertIn(f"approved without {drop[:7]}", event)
        self.assertIn("propose the push again", event)

    def test_a_push_needs_saved_facts_and_something_to_push(self):
        with self.assertRaisesRegex(SystemExit, "Save worktree, lease_sha, branch, remote first"):
            self.run_cli("propose", "push", URL, "--session", "nobody")
        _, clone, lease = self.repo()
        git(clone, "reset", "-q", "--hard", lease)
        with self.assertRaisesRegex(SystemExit, "Nothing to push"):
            self.propose("push")

    def test_moving_commits_is_always_the_sessions_job(self):
        _, clone, lease = self.repo()
        _, _, pid = self.propose("move", "--onto", "abc1234")
        self.run_cli("approve", pid)
        event = ap.outcomes(KEY, "s1")[0]
        self.assertIn(f"git rebase --onto abc1234 {lease}", event)

    # -------------------------------------------------------- jobs

    def test_retry_auto_runs_once_per_job_then_asks(self):
        self.set(**{"approvals.retry": "auto"})
        code, out, _ = self.propose("retry", "--job", "77", "--name", "test:integration", "--reason", "runner lost")
        self.assertTrue(out.startswith("[auto] "), out)
        self.assertIn("repos/u/gad/actions/jobs/77/rerun", self.posts()[0])
        code, out, pid = self.propose("retry", "--job", "77", "--name", "test:integration")
        self.assertTrue(out.startswith("[proposed] "), out)
        self.assertEqual(ap.load(pid)["status"], "pending")

    def test_a_gitlab_manual_job_plays_on_auto_unless_it_deploys(self):
        self.set(**{"approvals.manual": "auto"})
        mr = "https://gitlab.com/u/gad/-/merge_requests/91"
        _, out = self.run_cli("propose", "manual", mr, "--session", "s1", "--job", "5", "--name", "deploy:staging", "--stage", "deploy")
        self.assertTrue(out.startswith("[proposed] "), out)
        _, out = self.run_cli("propose", "manual", mr, "--session", "s1", "--job", "6", "--name", "lint:slow", "--stage", "test")
        self.assertTrue(out.startswith("[auto] "), out)
        self.assertIn("projects/u%2Fgad/jobs/6/play", self.posts()[0])

    def test_a_github_manual_job_is_a_deployment_and_always_asks(self):
        self.set(**{"approvals.manual": "auto"})
        _, out, pid = self.propose("manual", "--job", "5", "--name", "e2e")
        self.assertTrue(out.startswith("[proposed] "), out)
        self.assertEqual((ap.load(pid)["kind"], ap.load(pid)["title"]), ("deploy", "Approve e2e"))

    def test_an_outside_status_cannot_be_retried_from_here(self):
        _, _, pid = self.propose("retry", "--job", "status:ci/jenkins", "--name", "jenkins")
        code, out = self.run_cli("approve", pid)
        self.assertEqual(code, 1)
        self.assertIn("outside CI", json.loads(out)["message"])


class Watcher(unittest.TestCase):
    """watch_pr.py's side: [settings] and stage notes."""

    def test_settings_line_follows_the_settings_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "settings.json"
            with mock.patch.object(w, "SETTINGS", path):
                self.assertIn("auto-fix on", w.babysit_settings())
                path.write_text(json.dumps({"prBabysit.autoFix": False, "prBabysit.autoRebase": "clean", "approvals.reply": "off"}))
                said = w.babysit_settings()
        self.assertIn("auto-fix off", said)
        self.assertIn("abort and ask on a conflict", said)
        self.assertIn("never propose replies", said)

    def test_a_tray_note_is_one_json_file_in_the_notes_folder(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": tmp}):
            w.tray_note("feat: build passed", "build ✓ · test ⏳")
            files = list((Path(tmp) / "agent-hub" / "notes").glob("*.json"))
            self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text())["title"], "feat: build passed")


if __name__ == "__main__":
    unittest.main()
