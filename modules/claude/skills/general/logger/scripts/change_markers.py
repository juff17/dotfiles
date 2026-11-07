#!/usr/bin/env python3
"""change_markers: find log messages added on this branch, as regexes to watch for.

Scans lines added since the merge base with the base branch (committed,
uncommitted, and in new untracked files that are not ignored) for logging calls, then keeps the longest fixed text of each
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
from pathlib import Path

LOG_CALL_RE = re.compile(
    r"\b(log|logger|logging|_log|console|slog|zap|zerolog|klog|glog|winston|pino"
    r"|Log|LOG|Logger|Rails\.logger)\b\s*\.\s*\w+(\s*\(|\s+[\"'`])"  # Ruby may drop the ()
    r"|\b(fmt\.Print\w*|log\.Print\w*|print|println|printf|puts|warn|die)\s*[\( ]"
    r"|\b(info|warn|error|debug|trace)!\s*\("
)
STRING_RE = re.compile(r'f?"((?:[^"\\]|\\.)*)"|f?\'((?:[^\'\\]|\\.)*)\'|`([^`]*)`')
PLACEHOLDER_RE = re.compile(r"\{[^}]*\}|\$\{[^}]*\}|#\{[^}]*\}|\$\w+|%[-+ #0-9.]*[a-zA-Z]|\\[nt]")
SKIP_FILES_RE = re.compile(r"\.(md|txt|json|ya?ml|toml|lock|csv)$")
MIN_FRAGMENT = 8
MAX_CALL_LINES = 6


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
    # Explicit options so the user's diff settings (noprefix, mnemonicPrefix,
    # relative, color, external tools) cannot change the output parsed below.
    _, diff = git(cwd, "-c", "core.quotePath=false", "diff", "--unified=0", "--no-color",
                  "--no-ext-diff", "--no-textconv", "--no-relative",
                  "--src-prefix=a/", "--dst-prefix=b/", base)
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
    yield from untracked_lines(cwd)


def untracked_lines(cwd):
    """Yield (file, line_no, text) for every line of new files git does not track yet."""
    code, top = git(cwd, "rev-parse", "--show-toplevel")
    if code:
        return
    _, out = git(cwd, "ls-files", "--others", "--exclude-standard", "--full-name", "-z", ":/")
    for path in filter(None, out.split("\0")):
        try:
            data = (Path(top.strip()) / path).read_bytes()
        except OSError:
            continue
        if b"\0" in data:
            continue  # binary
        for line_no, text in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            yield path, line_no, text


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


def call_text(lines, i):
    """The log call starting at lines[i], joined with the added lines after it
    while its parentheses are still open (a call wrapped over several lines)."""
    path, line_no, text = lines[i]
    call = text
    for next_path, next_no, next_text in lines[i + 1:i + MAX_CALL_LINES]:
        if fragment(call) or not open_parens(call) or (next_path, next_no) != (path, line_no + 1):
            break
        call += " " + next_text.strip()
        line_no = next_no
    return call


def open_parens(text):
    code = STRING_RE.sub('""', text)
    return code.count("(") > code.count(")")


def markers(lines):
    """Yield one marker dict per distinct log message in (file, line_no, text) lines."""
    lines = list(lines)
    seen = set()
    for i, (path, line_no, text) in enumerate(lines):
        if SKIP_FILES_RE.search(path) or not LOG_CALL_RE.search(text):
            continue
        frag = fragment(call_text(lines, i))
        if not frag or frag in seen:
            continue
        seen.add(frag)
        yield {"where": f"{path}:{line_no}", "text": frag, "regex": re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", frag)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-C", dest="cwd", default=".")
    parser.add_argument("--base")
    args = parser.parse_args()

    base = base_ref(args.cwd, args.base)
    for marker in markers(added_lines(args.cwd, base)):
        print(json.dumps(marker))


if __name__ == "__main__":
    main()
