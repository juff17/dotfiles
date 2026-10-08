#!/usr/bin/env python3
"""
validate.py: check a CodeTour .tour file's anchors against the repo.

Usage:
  python3 validate.py <path/to/name.tour> [repoRoot]

Checks every step against the revision the reader will actually see: the
tour's `ref` if it has one (read from git, the way CodeTour does), otherwise
the files on disk.

  - file / directory steps exist at that revision
  - `line` and `selection` fall within the file
  - `pattern` matches somewhere in the file
  - the first step is anchored (not content-only)

Prints one line per problem and exits 1 if any were found. Needs only
Python 3 and git.
"""
import json
import re
import subprocess
import sys
from pathlib import Path


def git(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    tour_path = Path(sys.argv[1])
    repo = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.cwd()
    root = git(repo, "rev-parse", "--show-toplevel")
    repo = Path(root.strip()) if root else repo

    try:
        tour = json.loads(tour_path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"{tour_path}: cannot read tour: {e}")

    ref = tour.get("ref")
    if ref and git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}") is None:
        sys.exit(f"{tour_path}: ref '{ref}' is not a branch or commit in this repo")

    def read_file(path):
        if ref:
            return git(repo, "show", f"{ref}:{path}")
        p = repo / path
        return p.read_text(errors="replace") if p.is_file() else None

    def dir_exists(path):
        if ref:
            return git(repo, "cat-file", "-t", f"{ref}:{path.rstrip('/')}") == "tree\n"
        return (repo / path).is_dir()

    where = f"at ref '{ref}'" if ref else "on disk"
    problems = []
    steps = tour.get("steps") or []
    if not steps:
        problems.append("tour has no steps")
    elif not any(k in steps[0] for k in ("file", "directory", "uri")):
        problems.append("step 1: first step is content-only, anchor it to a file or directory")

    for i, step in enumerate(steps, 1):
        label = f"step {i} ({step.get('title', 'untitled')})"
        if "directory" in step and not dir_exists(step["directory"]):
            problems.append(f"{label}: directory '{step['directory']}' not found {where}")
        if "file" not in step:
            continue
        text = read_file(step["file"])
        if text is None:
            problems.append(f"{label}: file '{step['file']}' not found {where}")
            continue
        n = len(text.splitlines())
        if "line" in step and not 1 <= step["line"] <= n:
            problems.append(f"{label}: line {step['line']} out of range (file has {n} lines)")
        sel = step.get("selection")
        if sel:
            s, e = sel["start"]["line"], sel["end"]["line"]
            if not (1 <= s <= e <= n):
                problems.append(f"{label}: selection {s}-{e} out of range (file has {n} lines)")
        if "pattern" in step:
            try:
                found = re.search(step["pattern"], text, re.MULTILINE)
            except re.error:
                found = step["pattern"] in text
            if not found:
                problems.append(f"{label}: pattern {step['pattern']!r} not found in '{step['file']}'")

    for p in problems:
        print(p)
    print(f"{tour_path}: {len(steps)} steps checked {where}, {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
