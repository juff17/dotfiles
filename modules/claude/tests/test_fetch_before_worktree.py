"""fetch-before-worktree.sh, the PreToolUse(EnterWorktree, Bash) hook: when it
fetches the remote, and that it never blocks the tool call."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "hooks/core/fetch-before-worktree.sh"


class Fetch(unittest.TestCase):
    """A local repo cloned from an upstream that gains a commit after the clone."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.settings = self.tmp / "settings.json"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update(HOME=str(self.tmp), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                        AGENT_HUB_SETTINGS=str(self.settings))
        self.up = self.tmp / "up"
        self.up.mkdir()
        self.git("init", "-q", cwd=self.up)
        self.git("commit", "-q", "--allow-empty", "-m", "one", cwd=self.up)
        self.repo = self.tmp / "repo"
        self.git("clone", "-q", str(self.up), str(self.repo), cwd=self.tmp)
        self.git("commit", "-q", "--allow-empty", "-m", "two", cwd=self.up)

    def git(self, *args, cwd):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", *args],
                              cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def hook(self, tool, tool_input, cwd=None):
        payload = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input,
                   "cwd": str(cwd or self.repo)}
        r = subprocess.run([str(HOOK)], input=json.dumps(payload), env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def fetched(self):
        return self.git("rev-parse", "origin/main", cwd=self.repo) == self.git("rev-parse", "main", cwd=self.up)

    def test_enter_worktree_fetches(self):
        self.assertFalse(self.fetched())
        self.hook("EnterWorktree", {"name": "fix-x"})
        self.assertTrue(self.fetched())

    def test_git_worktree_add_fetches(self):
        self.hook("Bash", {"command": "git worktree add -b x ../wt origin/main"})
        self.assertTrue(self.fetched())

    def test_entering_an_existing_worktree_does_not_fetch(self):
        self.hook("EnterWorktree", {"path": str(self.repo)})
        self.assertFalse(self.fetched())

    def test_other_bash_does_not_fetch(self):
        self.hook("Bash", {"command": "git worktree list"})
        self.assertFalse(self.fetched())

    def test_setting_off_does_not_fetch(self):
        self.settings.write_text(json.dumps({"worktree.fetch": False}))
        self.hook("EnterWorktree", {"name": "fix-x"})
        self.assertFalse(self.fetched())

    def test_broken_setting_reads_as_on(self):
        self.settings.write_text("{not json")
        self.hook("EnterWorktree", {"name": "fix-x"})
        self.assertTrue(self.fetched())

    def test_failed_fetch_warns_without_blocking(self):
        self.git("remote", "set-url", "origin", str(self.tmp / "gone"), cwd=self.repo)
        out = json.loads(self.hook("EnterWorktree", {"name": "fix-x"}))
        self.assertIn("git fetch origin failed", out["systemMessage"])
        self.assertNotIn("decision", out)

    def test_outside_git_does_nothing(self):
        self.assertEqual(self.hook("EnterWorktree", {"name": "fix-x"}, cwd=self.tmp), "")


if __name__ == "__main__":
    unittest.main()
