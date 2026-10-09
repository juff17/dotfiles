#!/usr/bin/env python3
"""change_markers: find log messages added on this branch, as regexes to watch for.

Scans lines added since the merge base with the base branch (committed and
uncommitted) for logging calls, then keeps the longest fixed text of each
message so it still matches once placeholders are filled in at runtime.

Usage:
  change_markers.py [-C DIR] [--base BRANCH]

Prints one JSON object per marker: {"where": "file:line", "text": ..., "regex": ...}
Prints nothing when the branch adds no log calls.
"""

import argparse
import json
import re
import subprocess
import sys

LOG_CALL_RE = re.compile(
    r"\b(log|logger|logging|_log|console|slog|zap|zerolog|klog|glog|winston|pino"
    r"|Log|LOG|Logger|Rails\.logger)\b\s*\.\s*\w+\s*\("
    r"|\b(fmt\.Print\w*|log\.Print\w*|print|println|printf|puts|warn|die)\s*[\( ]"
    r"|\b(info|warn|error|debug|trace)!\s*\("
)
STRING_RE = re.compile(r'f?"((?:[^"\\]|\\.)*)"|f?\'((?:[^\'\\]|\\.)*)\'|`([^`]*)`')
PLACEHOLDER_RE = re.compile(r"\{[^}]*\}|\$\{[^}]*\}|#\{[^}]*\}|\$\w+|%[-+ #0-9.]*[a-zA-Z]|\\[nt]")
SKIP_FILES_RE = re.compile(r"\.(md|txt|json|ya?ml|toml|lock|csv)$")
MIN_FRAGMENT = 8


def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return r.returncode, r.stdout


def base_ref(cwd, base):
    candidates = [base] if base else []
    code, out = git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if code == 0:
        candidates.append(out.strip())
    candidates += ["origin/main", "origin/master", "main", "master"]
    for ref in candidates:
        if git(cwd, "rev-parse", "--verify", "--quiet", ref)[0] == 0:
            code, out = git(cwd, "merge-base", ref, "HEAD")
            if code == 0:
                return out.strip()
    sys.exit("change_markers: no base branch found; pass --base")


def added_lines(cwd, base):
    """Yield (file, line_no, text) for each added line from base to the working tree."""
    _, diff = git(cwd, "diff", "--unified=0", "--no-color", base)
    path, line_no = None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            path = raw[6:] if raw.startswith("+++ b/") else None
        elif raw.startswith("@@"):
            m = re.search(r"\+(\d+)", raw)
            line_no = int(m.group(1)) if m else 0
        elif raw.startswith("+") and path:
            yield path, line_no, raw[1:]
            line_no += 1


def fragment(line):
    """Longest fixed run of text inside the string literals of a log call."""
    best = ""
    for m in STRING_RE.finditer(line):
        literal = next(g for g in m.groups() if g is not None)
        for piece in PLACEHOLDER_RE.split(literal):
            piece = piece.strip(" :=,-")
            if len(piece) > len(best):
                best = piece
    return best if len(best) >= MIN_FRAGMENT else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-C", dest="cwd", default=".")
    parser.add_argument("--base")
    args = parser.parse_args()

    base = base_ref(args.cwd, args.base)
    seen = set()
    for path, line_no, text in added_lines(args.cwd, base):
        if SKIP_FILES_RE.search(path) or not LOG_CALL_RE.search(text):
            continue
        frag = fragment(text)
        if not frag or frag in seen:
            continue
        seen.add(frag)
        print(json.dumps({"where": f"{path}:{line_no}", "text": frag, "regex": re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", frag)}))


if __name__ == "__main__":
    main()
