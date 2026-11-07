"""explain-code's validate.py: checking a CodeTour's anchors against the files
on disk, or against the tour's `ref` in git, and reporting each broken one.
No network: each test builds a throwaway repo."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "skills/general/explain-code/scripts/validate.py"

GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
FIVE_LINES = "def load():\n    return read()\n\n\ndef read():\n"


def step(title="s", **anchor):
    return {"title": title, "description": "d", **anchor}


class Repo(unittest.TestCase):
    """Every test gets its own repo with src/app.py (5 lines) committed on main."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        self.root = Path(tmp.name) / "repo"
        self.root.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.write("src/app.py", FIVE_LINES)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "c")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def validate(self, steps=None, *, tour=None, repo=None):
        """Write a tour and validate it; return (exit code, problem lines, summary, stderr)."""
        tour = tour if tour is not None else {"title": "t", "steps": steps}
        path = self.root / ".tours/t.tour"
        path.parent.mkdir(exist_ok=True)
        path.write_text(tour if isinstance(tour, str) else json.dumps(tour))
        r = subprocess.run([sys.executable, str(SCRIPT), str(path), str(repo or self.root)],
                           capture_output=True, text=True)
        lines = r.stdout.splitlines()
        return r.returncode, lines[:-1], (lines[-1] if lines else ""), r.stderr

    def assertProblems(self, steps, *expected, **kw):
        code, problems, _, err = self.validate(steps, **kw)
        self.assertEqual(problems, list(expected), err)
        self.assertEqual(code, 1 if expected else 0)


class Valid(Repo):
    def test_a_good_tour_passes_with_a_summary(self):
        code, problems, summary, _ = self.validate([
            step("dir", directory="src"),
            step("file", file="src/app.py"),
            step("line", file="src/app.py", line=5),
            step("sel", file="src/app.py", selection={"start": {"line": 1, "character": 1},
                                                      "end": {"line": 2, "character": 5}}),
            step("pat", file="src/app.py", pattern=r"^def read"),
            step("prose only"),
        ])
        self.assertEqual((code, problems), (0, []))
        self.assertTrue(summary.endswith("t.tour: 6 steps checked on disk, 0 problem(s)"), summary)

    def test_content_only_steps_after_the_first_are_fine(self):
        self.assertProblems([step(file="src/app.py"), step(), step()])

    def test_a_uri_first_step_counts_as_anchored(self):
        self.assertProblems([step(uri="https://example.com")])

    def test_an_invalid_regex_pattern_falls_back_to_a_plain_substring(self):
        self.write("src/app.py", "x = f(a[0\n")
        self.assertProblems([step(file="src/app.py", pattern="f(a[0")])

    def test_the_repo_argument_defaults_to_the_current_directory(self):
        path = self.root / "t.tour"
        path.write_text(json.dumps({"steps": [step(file="src/app.py", line=2)]}))
        r = subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True,
                           text=True, cwd=self.root / "src")
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_a_folder_that_is_not_a_git_repo_is_checked_on_disk(self):
        with tempfile.TemporaryDirectory() as plain:
            Path(plain, "a.txt").write_text("one\n")
            Path(plain, "t.tour").write_text(json.dumps({"steps": [step(file="a.txt", line=1)]}))
            r = subprocess.run([sys.executable, str(SCRIPT), f"{plain}/t.tour", plain],
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)


class Invalid(Repo):
    def test_a_tour_with_no_steps(self):
        self.assertProblems([], "tour has no steps")
        self.assertProblems(None, "tour has no steps")

    def test_a_content_only_first_step(self):
        self.assertProblems([step(), step(file="src/app.py")],
                            "step 1: first step is content-only, anchor it to a file or directory")

    def test_a_missing_file(self):
        self.assertProblems([step("Gone", file="src/gone.py")],
                            "step 1 (Gone): file 'src/gone.py' not found on disk")

    def test_a_missing_directory(self):
        self.assertProblems([step("D", directory="lib")], "step 1 (D): directory 'lib' not found on disk")

    def test_a_file_step_naming_a_directory_is_not_found_on_disk(self):
        self.assertProblems([step("F", file="src")], "step 1 (F): file 'src' not found on disk")

    def test_line_out_of_range_on_either_side(self):
        self.assertProblems([step("L", file="src/app.py", line=6), step("Z", file="src/app.py", line=0)],
                            "step 1 (L): line 6 out of range (file has 5 lines)",
                            "step 2 (Z): line 0 out of range (file has 5 lines)")

    def test_selection_out_of_range_or_backwards(self):
        sel = lambda s, e: {"start": {"line": s, "character": 1}, "end": {"line": e, "character": 1}}
        self.assertProblems([step("A", file="src/app.py", selection=sel(4, 9)),
                             step("B", file="src/app.py", selection=sel(3, 2))],
                            "step 1 (A): selection 4-9 out of range (file has 5 lines)",
                            "step 2 (B): selection 3-2 out of range (file has 5 lines)")

    def test_a_non_integer_line_is_reported_not_a_crash(self):
        self.assertProblems([step("L", file="src/app.py", line="3"), step("B", file="src/app.py", line=True)],
                            "step 1 (L): line '3' is not a whole number",
                            "step 2 (B): line True is not a whole number")

    def test_a_malformed_selection_is_reported_not_a_crash(self):
        bad = [{"start": {"line": 1}}, {"start": 1, "end": 2}, ["1", "2"],
               {"start": {"line": "1"}, "end": {"line": 2}}]
        code, problems, _, err = self.validate([step(str(i), file="src/app.py", selection=sel)
                                                for i, sel in enumerate(bad, 1)])
        self.assertEqual((code, err), (1, ""))
        self.assertEqual(len(problems), len(bad), problems)
        for i, line in enumerate(problems, 1):
            self.assertTrue(line.startswith(f"step {i} ({i}): selection "), line)
            self.assertIn("is malformed", line)

    def test_a_pattern_that_matches_nothing(self):
        self.assertProblems([step("P", file="src/app.py", pattern="^class ")],
                            "step 1 (P): pattern '^class ' not found in 'src/app.py'")

    def test_an_untitled_step_is_labelled_untitled(self):
        self.assertProblems([{"file": "nope.py"}], "step 1 (untitled): file 'nope.py' not found on disk")

    def test_every_problem_is_reported_and_counted(self):
        code, problems, summary, _ = self.validate([step(), step(file="a.py"), step(directory="b")])
        self.assertEqual(code, 1)
        self.assertEqual(len(problems), 3)
        self.assertTrue(summary.endswith("3 steps checked on disk, 3 problem(s)"), summary)

    def test_unreadable_json_exits_with_a_message(self):
        code, _, _, err = self.validate(tour="{not json")
        self.assertEqual(code, 1)
        self.assertIn("cannot read tour", err)

    def test_a_missing_tour_file_exits_with_a_message(self):
        r = subprocess.run([sys.executable, str(SCRIPT), str(self.root / "none.tour"), str(self.root)],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("cannot read tour", r.stderr)

    def test_no_arguments_prints_usage(self):
        r = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Usage:", r.stderr)


class AtRef(Repo):
    """With a `ref`, steps are checked against git at that revision, not the disk."""

    def setUp(self):
        super().setUp()
        self.sha = self.git("rev-parse", "HEAD")
        # Move the working tree on so disk and the ref disagree.
        self.write("src/app.py", "only one line\n")
        self.write("src/new.py", "x\n")
        (self.root / "docs").mkdir()

    def tour(self, *steps, ref=None):
        return {"ref": ref or self.sha, "steps": list(steps)}

    def test_lines_and_patterns_are_checked_against_the_ref_not_the_disk(self):
        code, problems, summary, _ = self.validate(tour=self.tour(
            step(file="src/app.py", line=5), step(file="src/app.py", pattern="def read")))
        self.assertEqual((code, problems), (0, []))
        self.assertIn(f"checked at ref '{self.sha}'", summary)

    def test_a_branch_name_works_as_a_ref(self):
        code, problems, _, _ = self.validate(tour=self.tour(step(file="src/app.py", line=5), ref="main"))
        self.assertEqual((code, problems), (0, []))

    def test_a_file_only_on_disk_is_not_found_at_the_ref(self):
        code, problems, _, _ = self.validate(tour=self.tour(step("N", file="src/new.py")))
        self.assertEqual(problems, [f"step 1 (N): file 'src/new.py' not found at ref '{self.sha}'"])

    def test_directories_are_checked_at_the_ref(self):
        code, problems, _, _ = self.validate(tour=self.tour(
            step("S", directory="src/"), step("D", directory="docs")))
        self.assertEqual(problems, [f"step 2 (D): directory 'docs' not found at ref '{self.sha}'"])

    def test_a_ref_that_does_not_exist_stops_the_check(self):
        code, problems, _, err = self.validate(tour=self.tour(step(file="src/app.py"), ref="no-such-branch"))
        self.assertEqual(code, 1)
        self.assertIn("ref 'no-such-branch' is not a branch or commit in this repo", err)

    def test_a_file_step_naming_a_directory_is_not_found_at_the_ref(self):
        # `git show ref:dir` succeeds and prints the tree, so the type is checked.
        code, problems, _, _ = self.validate(tour=self.tour(step("F", file="src")))
        self.assertEqual(problems, [f"step 1 (F): file 'src' not found at ref '{self.sha}'"])


if __name__ == "__main__":
    unittest.main()
