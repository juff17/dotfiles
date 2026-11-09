"""pr-babysit's watch_pr.py: saved facts, session files, the [watch] line, and
events that must not repeat. No network: the forge is a stand-in."""

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

SCRIPT = Path(__file__).resolve().parents[1] / "skills/general/pr-babysit/scripts/watch_pr.py"
spec = importlib.util.spec_from_file_location("watch_pr", SCRIPT)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

URL = "https://github.com/u/gad/pull/91"


class Forge:
    """Stands in for GitHub/GitLab: hands out the snapshots it was given."""

    host, project, cli = "github.com", "u/gad", "gh"

    def __init__(self, *snaps):
        self.snaps = list(snaps)

    def me(self):
        return "me"

    def snapshot(self, number):
        return self.snaps.pop(0)


def snap(sha="a" * 40, state="open", comments=(), checks=()):
    return {
        "state": state, "url": URL, "title": "Add pagination", "branch": "feat",
        "base": "main", "sha": sha, "fork": False, "checks": list(checks),
        "comments": list(comments), "reviews": [],
    }


def comment(id, author="rev", resolved=False):
    return {"id": id, "author": author, "resolved": resolved, "where": "", "body": "nit", "url": f"u#{id}"}


class Cache(unittest.TestCase):
    """Every test gets its own cache folder."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"XDG_CACHE_HOME": tmp.name})
        env.start()
        self.addCleanup(env.stop)
        settings = mock.patch.object(w, "SETTINGS", Path(tmp.name) / "settings.json")
        settings.start()
        self.addCleanup(settings.stop)
        self.base = w.pr_base(Forge(), 91)

    def watch(self, forge, *argv):
        """Run main() against the stand-in forge; return its exit code and lines."""
        out = io.StringIO()
        with mock.patch.object(w, "parse_url", return_value=(forge, 91)), \
                mock.patch.object(w, "find_remote", return_value="origin"), \
                mock.patch.object(w, "preflight"), \
                mock.patch.object(w, "take_lock", return_value=object()), \
                mock.patch.object(w.time, "sleep"), \
                mock.patch.object(sys, "argv", ["watch_pr.py", URL, *argv]), \
                contextlib.redirect_stdout(out):
            code = w.main()
        return code, out.getvalue().splitlines()


class Notes(Cache):
    def test_set_updates_and_clears(self):
        path = w.notes_path(self.base, "s1")
        w.set_notes(path, ["lease_sha=abc", "worktree=/p/wt"])
        self.assertEqual(w.set_notes(path, ["lease_sha=def", "clone=/p"]),
                         {"lease_sha": "def", "worktree": "/p/wt", "clone": "/p"})
        self.assertEqual(w.set_notes(path, ["worktree="]), {"lease_sha": "def", "clone": "/p"})
        self.assertEqual(w.load_notes(path), {"lease_sha": "def", "clone": "/p"})

    def test_rejects_unknown_keys_and_missing_equals(self):
        path = w.notes_path(self.base, "s1")
        for bad in ("bogus=1", "lease_sha"):
            with self.assertRaises(ValueError):
                w.set_notes(path, [bad])
        self.assertFalse(path.exists())

    def test_a_broken_file_reads_as_nothing_saved(self):
        path = w.notes_path(self.base, "s1")
        path.parent.mkdir(parents=True)
        path.write_text("{not json")
        self.assertEqual(w.load_notes(path), {})
        path.write_text(json.dumps({"lease_sha": "abc", "other": "x", "clone": 3}))
        self.assertEqual(w.load_notes(path), {"lease_sha": "abc"})

    def test_the_watcher_saving_state_leaves_notes_alone(self):
        notes = w.notes_path(self.base, "s1")
        w.set_notes(notes, ["lease_sha=abc"])
        w.save_state(w.session_state(self.base, "s1"), {"comments": set(), "events": set(), "sha": "x"})
        self.assertEqual(w.load_notes(notes), {"lease_sha": "abc"})

    def test_a_new_session_removes_the_old_sessions_files(self):
        w.set_notes(w.notes_path(self.base, "s1"), ["lease_sha=abc"])
        w.save_state(w.session_state(self.base, "s1"), {"comments": set(), "events": set()})
        w.session_state(self.base, "s1")
        self.assertEqual(len(list(self.base.parent.glob("*.json"))), 2, "the same session keeps both")
        w.session_state(self.base, "s2")
        self.assertEqual(list(self.base.parent.glob("*.json")), [])

    def test_set_on_the_command_line(self):
        env = dict(os.environ)
        run = lambda *a: subprocess.run([sys.executable, str(SCRIPT), URL, *a], capture_output=True, text=True, env=env)
        ok = run("--session", "s1", "--set", "lease_sha=abc", "--set", "clone=/p")
        self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "[saved] lease_sha abc, clone /p"))
        self.assertEqual(run("--set", "lease_sha=abc").returncode, 2, "needs --session")
        self.assertEqual(run("--session", "s1", "--set", "bogus=1").returncode, 2)


class Lock(Cache):
    def test_one_babysitter_per_pr(self):
        held = w.take_lock(self.base)
        self.addCleanup(held.close)
        self.assertIsNone(w.take_lock(self.base))
        held.close()
        again = w.take_lock(self.base)
        self.assertIsNotNone(again, "a closed (or dead) holder frees it")
        again.close()


class WatchLine(Cache):
    def test_resume_reprints_the_saved_facts(self):
        code, lines = self.watch(Forge(snap(state="merged")), "--session", "s1")
        self.assertEqual(code, 0)
        self.assertTrue(lines[0].startswith("[watch] attached "))
        self.assertNotIn("saved:", lines[0])

        w.set_notes(w.notes_path(self.base, "s1"), ["lease_sha=abc", "worktree=/p/wt", "clone=/p"])
        _, lines = self.watch(Forge(snap(state="merged")), "--session", "s1")
        self.assertTrue(lines[0].startswith("[watch] resumed "))
        self.assertTrue(lines[0].endswith("| saved: lease_sha abc, worktree /p/wt, clone /p, branch feat, remote origin"), lines[0])

    def test_attaching_saves_the_branch_and_remote_for_a_push(self):
        self.watch(Forge(snap(state="merged")), "--session", "s1")
        self.assertEqual(w.load_notes(w.notes_path(self.base, "s1")), {"branch": "feat", "remote": "origin"})

    def test_once_shows_no_saved_facts_and_saves_nothing(self):
        w.set_notes(w.notes_path(self.base, "s1"), ["lease_sha=abc"])
        _, lines = self.watch(Forge(snap()), "--once")
        self.assertNotIn("saved:", lines[0])
        self.assertEqual(list(self.base.parent.glob("*.s1.json")), [])


class Events(Cache):
    def test_a_rearm_never_repeats_comments(self):
        first = snap(comments=[comment(1), comment(2, author="me"), comment(3, resolved=True)])
        _, lines = self.watch(Forge(first, snap(state="merged", comments=first["comments"])), "--session", "s1")
        self.assertEqual([l.split()[0] for l in lines], ["[watch]", "[settings]", "[comment]", "[merged]"])
        self.assertIn("@rev", lines[2])

        again = snap(state="merged", comments=[comment(1), comment(4)])
        _, lines = self.watch(Forge(again), "--session", "s1")
        self.assertEqual([l for l in lines if l.startswith("[comment]")], ['[comment] @rev: "nit" id=4 u#4'])

    def test_approval_outcomes_come_between_polls(self):
        with mock.patch.object(w, "approval_outcomes", side_effect=[["push p1 approved: pushed"]] + [[]] * 100):
            _, lines = self.watch(Forge(snap(), snap(state="merged")), "--session", "s1", "--interval", "15")
        self.assertIn("[approval] push p1 approved: pushed", lines)
        self.assertLess(lines.index("[approval] push p1 approved: pushed"), len(lines) - 1)

    def test_a_finished_stage_goes_to_the_tray_when_settings_say_so(self):
        w.SETTINGS.write_text('{"prBabysit.notifyStage": true}')
        running = {"id": 1, "name": "lint", "group": "build", "job": "lint", "status": "running", "url": "", "waited": 0, "allow_failure": False}
        done = dict(running, status="success")
        later = dict(running, id=2, group="test", job="unit", name="unit")
        with mock.patch.object(w, "tray_note") as note:
            self.watch(Forge(snap(checks=[running, later]), snap(checks=[done, later]), snap(state="merged")), "--session", "s1")
        note.assert_called_once()
        self.assertIn("build passed", note.call_args[0][0])

    def test_a_moved_head_is_a_push(self):
        _, lines = self.watch(Forge(snap(sha="a" * 40), snap(sha="b" * 40, state="merged")), "--session", "s1")
        self.assertIn("[push] head moved to bbbbbbbb", lines)


class Flaky(Forge):
    """A forge whose snapshots can be errors, raised in turn."""

    def snapshot(self, number):
        s = self.snaps.pop(0)
        if isinstance(s, Exception):
            raise s
        return s


class ErrorAfter(Cache):
    def test_failed_polls_raise_an_error_once_settings_count_is_reached(self):
        w.SETTINGS.write_text('{"prBabysit.errorAfter": 2}')
        down = [w.ApiError("down"), w.ApiError("down"), w.ApiError("down")]
        _, lines = self.watch(Flaky(*down, snap(state="merged")), "--session", "s1")
        errors = [l for l in lines if l.startswith("[error]")]
        self.assertEqual(len(errors), 1)
        self.assertIn("failed 2 polls in a row", errors[0])

    def test_fewer_failures_than_the_default_raise_nothing(self):
        _, lines = self.watch(Flaky(w.ApiError("down"), snap(state="merged")), "--session", "s1")
        self.assertFalse([l for l in lines if l.startswith("[error]")])


class Settings(unittest.TestCase):
    """--interval and --stuck-after default to the hub's Settings file."""

    def read(self, text):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "settings.json"
            if text is not None:
                path.write_text(text)
            with mock.patch.object(w, "SETTINGS", path):
                return w.setting("prBabysit.interval", 60, 15, 600)

    def test_a_saved_value_is_the_default(self):
        self.assertEqual(self.read('{"prBabysit.interval": 120}'), 120)

    def test_no_file_or_a_bad_value_keeps_the_built_in_default(self):
        self.assertEqual(self.read(None), 60)
        self.assertEqual(self.read("{ not json"), 60)
        self.assertEqual(self.read("[1, 2]"), 60)
        self.assertEqual(self.read('{"prBabysit.interval": 5}'), 60)
        self.assertEqual(self.read('{"prBabysit.interval": "120"}'), 60)
        self.assertEqual(self.read('{"prBabysit.interval": true}'), 60)


if __name__ == "__main__":
    unittest.main()
