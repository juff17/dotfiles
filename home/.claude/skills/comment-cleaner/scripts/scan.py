#!/usr/bin/env python3
"""
scan.py — AI-authored / low-value comment scanner (multi-language)
------------------------------------------------------------------
Scans a git repo's source comments for two things:
  1. Prompt/ticket LEAKAGE  — artifacts of the prompt/ticket that drove the
     work, with no business in source: "AC#4", "confirm against APP-1234",
     "Step 1:", "you may want to ...", "in real implementation...".
  2. Low-value NARRATION    — comments that restate what the next line of
     code already says, instead of explaining why.

Languages: JS/TS(X), CSS/SCSS/Sass/Less, PHP, Python, Go, Shell, Terraform/HCL,
YAML. A single
dependency-free tokenizer (keyed by extension) extracts comments while tracking
string state, so `//` or `#` inside a string is never mistaken for a comment.
(One accepted gap: `//` inside a JS regex literal — rare.)

The script does the deterministic work and writes the findings to disk as JSON.
It is intentionally CONSERVATIVE about
"high-confidence": anything needing WHAT-vs-WHY judgment is emitted as a "review"
candidate WITH the line of code it sits above.

Usage:
  python3 scan.py <branch|full> [repoRoot] [--out <basePath>]

  branch (default) — files changed vs the merge-base with the default branch,
                     and only comments on lines this branch added/changed.
  full             — every git-tracked source file in supported languages.

Gitignored files, node_modules/dist/build (git doesn't track them) and common
vendored dirs are skipped automatically. Needs only Python 3 and git.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict


# ============================================================================
# Language table
# ============================================================================
# Each language spec: {line[], block[], strings[]}
#   line:    {t, boundary?, notFollowedBy?}  ('#' that must follow whitespace; PHP '#' not before '[')
#   block:   {open, close}
#   strings: {open, close, esc?, multiline?, raw?, emitAsDoc?}
#            emitAsDoc => the string is captured as a doc-comment (Python docstrings)

C_STRINGS = [
    {"open": "`", "close": "`", "esc": "\\", "multiline": True},
    {"open": '"', "close": '"', "esc": "\\"},
    {"open": "'", "close": "'", "esc": "\\"},
]


JS = {
    "line": [{"t": "//"}],
    "block": [{"open": "/*", "close": "*/"}],
    "strings": C_STRINGS,
}
GO = {
    "line": [{"t": "//"}],
    "block": [{"open": "/*", "close": "*/"}],
    "strings": [
        {"open": "`", "close": "`", "multiline": True, "raw": True},
        {"open": '"', "close": '"', "esc": "\\"},
        {"open": "'", "close": "'", "esc": "\\"},
    ],
}
PHP = {
    "line": [{"t": "//"}, {"t": "#", "notFollowedBy": "["}],
    "block": [{"open": "/*", "close": "*/"}],
    "strings": [{"open": '"', "close": '"', "esc": "\\"}, {"open": "'", "close": "'", "esc": "\\"}],
}
PY = {
    "line": [{"t": "#"}],
    "block": [],
    "strings": [
        {"open": '"""', "close": '"""', "esc": "\\", "multiline": True, "emitAsDoc": True},
        {"open": "'''", "close": "'''", "esc": "\\", "multiline": True, "emitAsDoc": True},
        {"open": '"', "close": '"', "esc": "\\"},
        {"open": "'", "close": "'", "esc": "\\"},
    ],
}
SHELL = {
    "line": [{"t": "#", "boundary": True}],
    "block": [],
    "strings": [{"open": "'", "close": "'", "raw": True}, {"open": '"', "close": '"', "esc": "\\"}],
}
YAML = {
    "line": [{"t": "#", "boundary": True}],
    "block": [],
    "strings": [{"open": "'", "close": "'", "raw": True}, {"open": '"', "close": '"', "esc": "\\"}],
}
HCL = {
    "line": [{"t": "#"}, {"t": "//"}],
    "block": [{"open": "/*", "close": "*/"}],
    "strings": [{"open": '"', "close": '"', "esc": "\\"}],
}
# Plain CSS has no line comments; SCSS/Sass/Less add `//`.
CSS = {
    "line": [],
    "block": [{"open": "/*", "close": "*/"}],
    "strings": [{"open": '"', "close": '"', "esc": "\\"}, {"open": "'", "close": "'", "esc": "\\"}],
}
SCSS = {
    "line": [{"t": "//"}],
    "block": [{"open": "/*", "close": "*/"}],
    "strings": [{"open": '"', "close": '"', "esc": "\\"}, {"open": "'", "close": "'", "esc": "\\"}],
}

LANG_BY_EXT = {
    ".js": JS, ".jsx": JS, ".mjs": JS, ".cjs": JS,
    ".ts": JS, ".tsx": JS, ".mts": JS, ".cts": JS,
    ".go": GO, ".php": PHP, ".py": PY,
    ".sh": SHELL, ".bash": SHELL, ".zsh": SHELL,
    ".yml": YAML, ".yaml": YAML, ".tf": HCL, ".hcl": HCL,
    ".css": CSS, ".scss": SCSS, ".sass": SCSS, ".less": SCSS,
}
SOURCE_EXT = list(LANG_BY_EXT.keys())

# Conventional dependency/vendor dirs (mirror how git hides node_modules).
VENDOR_DIR = re.compile(r"(^|/)(vendor|third_party|third-party|Pods|bower_components|Carthage|\.terraform)(/|$)")


# ============================================================================
# Detection patterns
# ============================================================================
STOPWORDS = set((
    "the a an to of for and or if is are be this that with from in on it its as we us our will would can "
    "could should may might also then now into out up value values default new const let var func function "
    "def return type interface so but not no yes set get all each any here there when where which what"
).split(" "))

TICKET_RE = re.compile(r"\b([A-Z][A-Z0-9]+)-(\d+)\b")
# Jira projects whose LABEL-N refs are real tickets. Any other prefix is ignored.
KNOWN_TICKET_PREFIXES = {"APP", "DEVOPS", "TRD", "ARD"}

LEAK_PHRASING = re.compile(
    r"\b(provisional|confirm against|reconcile against|as per|per the|per spec|contract|tracked in|tracked by|"
    r"see ticket|todo per|will be done in|cleanup in|remove in|implements?\b.*\b(ticket|story|ac\b)|fixes \w+-\d)\b",
    re.I)

NARRATION_VERBS = re.compile(
    r"^(defines?|creates?|sets?|gets?|stores?|updates?|checks?|returns?|initializ(e|es)|handles?|maps?|filters?|"
    r"loops?|iterates?|builds?|adds?|removes?|renders?|declares?|calls?|converts?|parses?|extracts?|fetch(es)?|"
    r"loads?|saves?|generates?|validates?|formats?|comput(e|es)|calculat(e|es)|finds?|grabs?|setups?|cleans?|"
    r"clears?|resets?|toggles?|wraps?|pushes?|appends?|assigns?)\s+(the|a|an|this|that|it|if|whether|all|each|our|its|to|into|from)\b",
    re.I)

THIS_NARRATION = re.compile(
    r"^this (is|function|method|component|hook|class|will|handles|returns|creates|sets|gets|maps|filters|holds|contains|represents)\b",
    re.I)

# Agent/assistant tool markers left in committed source — e.g. `// ponytail: …`,
# `# caveman: …`, an "AI-generated" tag. Anchored to the comment start so prose
# like "ask claude:" or the CSS `cursor:` property don't trip it.
AI_TOOL_MARKER = re.compile(
    r"^\s*(ponytail|caveman|claude|copilot|chatgpt|codeium)\b\s*[:\-]"
    r"|\bai[- ]generated\b|\bgenerated by (ai|claude|chatgpt|copilot|cursor)\b",
    re.I)


# ============================================================================
# Small helpers
# ============================================================================
def run_git(repo_root, args):
    """Run a git command in `repo_root` and return stdout. Raises on failure."""
    return subprocess.run(
        ["git", *args], cwd=repo_root, capture_output=True, text=True, check=True
    ).stdout


def lang_for(rel_path):
    """Return the language spec for a path, or None if unsupported."""
    return LANG_BY_EXT.get(os.path.splitext(rel_path)[1])


def words(text):
    """Significant lowercase word tokens (camelCase-split, stopwords removed)."""
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"[_\-]", " ", text).lower()
    return [w for w in re.split(r"[^a-z0-9]+", text) if len(w) >= 3 and w not in STOPWORDS]


def inner_text(comment):
    """Strip comment delimiters (any language) down to the prose inside."""
    t = comment["text"]
    t = re.sub(r"^\s*/\*+", "", t)
    t = re.sub(r"\*+/\s*$", "", t)
    t = re.sub("^(\"\"\"|''')", "", t)
    t = re.sub("(\"\"\"|''')\\s*$", "", t)
    lines = [re.sub(r"^\s*(//+|#+|\*\s?)", "", line) for line in t.split("\n")]
    return "\n".join(lines).strip()


# ============================================================================
# Git scoping
# ============================================================================
def resolve_repo_root(repo_root_arg):
    if repo_root_arg:
        return os.path.abspath(repo_root_arg)
    try:
        return subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        print("Not inside a git repository (git rev-parse failed).", file=sys.stderr)
        sys.exit(2)


def default_base_ref(repo_root):
    """The branch to diff against: origin/HEAD's target, else main/master."""
    candidates = []
    try:
        head = run_git(repo_root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
        head = head.strip().replace("refs/remotes/", "")
        if head:
            candidates.append(head)
    except subprocess.CalledProcessError:
        pass
    candidates += ["origin/main", "origin/master", "main", "master"]
    for ref in candidates:
        try:
            run_git(repo_root, ["rev-parse", "--verify", "--quiet", ref])
            return ref
        except subprocess.CalledProcessError:
            continue
    return None


def parse_added_lines(diff):
    """Map each file to the set of line numbers it added/changed (from `git diff -U0`)."""
    by_file = defaultdict(set)
    current = None
    for line in diff.split("\n"):
        if line.startswith("+++ "):
            path = line[4:].strip()
            current = None if path == "/dev/null" else re.sub(r"^b/", "", path)
        elif line.startswith("@@") and current:
            hunk = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if hunk:
                start = int(hunk.group(1))
                count = 1 if hunk.group(2) is None else int(hunk.group(2))
                by_file[current].update(range(start, start + count))
    return by_file


def scope_files(repo_root, mode):
    """Return (files, added_lines, base_label) for the chosen mode."""
    globs = ["*" + ext for ext in SOURCE_EXT]
    added_lines = None
    base_label = None

    if mode == "full":
        files = [f for f in run_git(repo_root, ["ls-files", "--", *globs]).split("\n") if f]
    else:
        base_ref = default_base_ref(repo_root)
        diff_base = "HEAD"
        if base_ref:
            try:
                diff_base = run_git(repo_root, ["merge-base", "HEAD", base_ref]).strip()
            except subprocess.CalledProcessError:
                pass
        names = run_git(repo_root, ["diff", "--name-only", "--diff-filter=d", diff_base, "--", *globs])
        files = [f for f in names.split("\n") if f]
        added_lines = parse_added_lines(run_git(repo_root, ["diff", "--unified=0", diff_base, "--", *globs]))
        base_label = f"{base_ref} (merge-base)" if base_ref else "HEAD (uncommitted only)"

    files = [f for f in files
             if lang_for(f) and not VENDOR_DIR.search(f) and not re.search(r"\.min\.(js|ts)$", f)]
    return files, added_lines, base_label


# ============================================================================
# Comment extraction (generic tokenizer)
# ============================================================================
def extract_comments(text, lang):
    """Tokenize `text` for `lang`, returning comment records with the next code line."""
    n = len(text)
    strings = sorted(lang["strings"], key=lambda s: len(s["open"]), reverse=True)
    raw_comments = []
    i = 0
    while i < n:
        token = _read_block(text, i, lang["block"])
        if token is None:
            token = _read_line_comment(text, i, lang["line"], n)
        if token is None:
            token = _read_string(text, i, strings, n)
        if token is None:
            i += 1
            continue
        if token.get("emit"):
            raw_comments.append({"raw": token["raw"], "kind": token["kind"], "start": token["start"]})
        i = token["next"]

    return _finalize_comments(raw_comments, text, lang)


def _read_block(text, i, blocks):
    """Consume a /* ... */ block comment at i, or return None."""
    for b in blocks:
        if text.startswith(b["open"], i):
            close = text.find(b["close"], i + len(b["open"]))
            end = len(text) if close == -1 else close + len(b["close"])
            return {"emit": True, "raw": text[i:end], "kind": "block", "start": i, "next": end}
    return None


def _read_line_comment(text, i, line_specs, n):
    """Consume a // or # line comment at i, or return None."""
    for lc in line_specs:
        if not text.startswith(lc["t"], i):
            continue
        if lc.get("boundary"):
            prev = text[i - 1] if i > 0 else "\n"
            if not (prev == "\n" or prev.isspace()):
                continue
        if lc.get("notFollowedBy"):
            nxt = i + len(lc["t"])
            if nxt < n and text[nxt] == lc["notFollowedBy"]:
                continue
        nl = text.find("\n", i)
        end = n if nl == -1 else nl
        return {"emit": True, "raw": text[i:end], "kind": "line", "start": i, "next": end}
    return None


def _read_string(text, i, strings, n):
    """Consume a string literal at i (tracking escapes), or return None.

    Emits a comment only for `emitAsDoc` strings (Python docstrings); other
    strings are consumed silently so their contents can't be mistaken for code.
    """
    for s in strings:
        if not text.startswith(s["open"], i):
            continue
        j = i + len(s["open"])
        while j < n:
            if not s.get("raw") and s.get("esc") and text[j] == s["esc"]:
                j += 2
                continue
            if text.startswith(s["close"], j):
                j += len(s["close"])
                break
            if text[j] == "\n" and not s.get("multiline"):
                break  # unterminated single-line string; bail
            j += 1
        return {"emit": bool(s.get("emitAsDoc")), "raw": text[i:j], "kind": "doc", "start": i, "next": j}
    return None


def _finalize_comments(raw_comments, text, lang):
    """Attach line numbers, doc-status, and the next real line of code."""
    lines = text.split("\n")

    def is_comment_line(stripped):
        return (any(stripped.startswith(lc["t"]) for lc in lang["line"])
                or any(stripped.startswith(b["open"]) for b in lang["block"])
                or stripped.startswith("*"))

    results = []
    for c in raw_comments:
        start = c["start"]
        end = start + len(c["raw"])
        start_line = text.count("\n", 0, start) + 1
        end_line = text.count("\n", 0, max(start, end - 1)) + 1
        next_code = ""
        for ln in range(end_line, len(lines)):
            stripped = lines[ln].strip()
            if not stripped or is_comment_line(stripped):
                continue
            next_code = stripped
            break
        # A block comment opening with `/**` is a doc-comment (JSDoc/PHP docblock);
        # Python docstrings already arrive tagged "doc".
        kind = c["kind"]
        if kind == "block" and re.match(r"/\*\*[^*]", c["raw"] + " "):
            kind = "doc"
        results.append({
            "kind": kind,
            "startLine": start_line,
            "endLine": end_line,
            "text": c["raw"],
            "nextCode": next_code,
        })
    results.sort(key=lambda r: r["startLine"])
    return results


# ============================================================================
# Ticket prefixes
# ============================================================================
def ticket_ids(text):
    """LABEL-N matches whose prefix is a known ticket project; others are ignored."""
    return [m.group(0) for m in TICKET_RE.finditer(text) if m.group(1) in KNOWN_TICKET_PREFIXES]


# ============================================================================
# Detection
# ============================================================================
def classify(comment, it, sequential_context=False):
    """Return a list of {signal, tier[, narration]} findings for one comment."""
    findings = []

    # ---- LEAK (high confidence) ----
    if re.search(r"\bAC\s*#?\s*\d+\b|acceptance criteria", it, re.I):
        findings.append({"signal": "acceptance-criteria reference", "tier": "leak"})

    if re.search(r"^\s*step\s*\d+\b", it, re.I):
        findings.append({
            "signal": ('numbered "Step N" narration (sequential-context file — may be intentional)'
                       if sequential_context else 'numbered "Step N" narration'),
            "tier": "review" if sequential_context else "leak",
        })

    if (re.search(r"\byou (can|may|might|should|could|will)\b.*\b(want|need|change|adjust|set|use|remove|add)\b", it, re.I)
            or re.search(r"\bfeel free\b|\bif you (want|like|prefer|need)\b|\bas you (requested|asked|mentioned|wanted)\b", it, re.I)):
        findings.append({"signal": "addresses the reader (prompt leak)", "tier": "leak"})

    if re.search(r"\bin (a |the )?real implementation\b|\btodo[:\s].*\bimplement\b|\bimplement (this|the actual)\b", it, re.I):
        findings.append({"signal": 'placeholder "implement this" leak', "tier": "leak"})

    if AI_TOOL_MARKER.search(it):
        findings.append({"signal": "agent/assistant tool marker", "tier": "leak"})

    tickets = ticket_ids(it)
    if tickets and LEAK_PHRASING.search(it):
        findings.append({"signal": "ticket as source-of-truth (%s)" % ", ".join(tickets), "tier": "leak"})

    # ---- REVIEW (needs judgment) ----
    if tickets and not LEAK_PHRASING.search(it):
        findings.append({"signal": "ticket reference (%s) — keep if it's a regression/cleanup/link pointer"
                                   % ", ".join(tickets), "tier": "review"})

    if re.search(r"atlassian\.net/wiki|\bconfluence\b|figma\.com|\bfigma\b", it, re.I):
        findings.append({"signal": "design-doc / wiki / Figma link", "tier": "review"})

    if re.search(r"^\s*\d+\.\s", it) and not re.search(r"^\s*step", it, re.I):
        findings.append({"signal": 'numbered-step prefix "N."', "tier": "review"})

    # Narration is a smell for line comments only; doc-comments/blocks get a pass.
    if comment["kind"] == "line":
        cw = words(it)
        code_words = set(words(comment.get("nextCode") or ""))
        overlap = (sum(1 for w in cw if w in code_words) / len(cw)) if cw else 0
        redundant = 2 <= len(cw) <= 8 and overlap >= 0.6
        if redundant or NARRATION_VERBS.search(it) or THIS_NARRATION.search(it):
            findings.append({
                "signal": ("restates the code (%d%% word overlap with next line)" % int(overlap * 100 + 0.5)
                           if redundant else "narrates what the next line does"),
                "tier": "review",
                "narration": True,
            })

    return findings


def _make_record(rel, comment, finding):
    text = comment["text"]
    text = (text[:220] + " …") if len(text) > 220 else text
    return {
        "file": rel,
        "line": comment["startLine"],
        "kind": comment["kind"],
        "signal": finding["signal"],
        "comment": text.replace("\n", "\\n"),
        "nextCode": comment["nextCode"] if finding["tier"] == "review" else None,
    }


def scan_one_file(rel, comments, added_lines):
    """Classify every (in-scope) comment in one file. Returns (leaks, reviews, stat)."""
    leaks, reviews = [], []
    stat = {"lineComments": 0, "narration": 0}
    sequential_context = re.search(r"\.example\.|(^|/)migrations?/", rel, re.I) is not None

    for c in comments:
        if added_lines is not None:
            touched = added_lines.get(rel)
            if not touched or touched.isdisjoint(range(c["startLine"], c["endLine"] + 1)):
                continue
        if c["kind"] == "line":
            stat["lineComments"] += 1

        it = inner_text(c)
        for finding in classify(c, it, sequential_context):
            (leaks if finding["tier"] == "leak" else reviews).append(_make_record(rel, c, finding))
            if finding.get("narration"):
                stat["narration"] += 1

    return leaks, reviews, stat


def _dense_files(per_file):
    """Files where >=5 line comments narrate code and that's >=50% of them."""
    dense = []
    for rel, s in per_file.items():
        ratio = s["narration"] / s["lineComments"]
        if s["narration"] >= 5 and ratio >= 0.5:
            dense.append({"file": rel, "ratio": ratio, **s})
    dense.sort(key=lambda f: f["narration"], reverse=True)
    return dense


def scan_repo(repo_root, mode):
    """Scan the repo and return (payload, lang_counts)."""
    files, added_lines, base_label = scope_files(repo_root, mode)
    leaks, reviews, per_file, lang_counts = [], [], {}, {}
    scanned = 0

    for rel in files:
        try:
            with open(os.path.join(repo_root, rel), encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        try:
            comments = extract_comments(text, lang_for(rel))
        except Exception:
            continue  # never let one pathological file abort the sweep

        scanned += 1
        ext = os.path.splitext(rel)[1]
        lang_counts[ext] = lang_counts.get(ext, 0) + 1

        file_leaks, file_reviews, stat = scan_one_file(rel, comments, added_lines)
        leaks.extend(file_leaks)
        reviews.extend(file_reviews)
        if stat["lineComments"]:
            per_file[rel] = stat

    dense = _dense_files(per_file)
    payload = {
        "mode": mode,
        "repo": repo_root,
        "base": base_label,
        "filesScanned": scanned,
        "totals": {"flagged": len(leaks) + len(reviews), "leaks": len(leaks),
                   "review": len(reviews), "denseFiles": len(dense)},
        "leaks": leaks,
        "reviews": reviews,
        "denseFiles": dense,
    }
    return payload, lang_counts


# ============================================================================
# Reporting
# ============================================================================
def write_outputs(out_base, payload):
    json_path = out_base + ".json"
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    return json_path


def print_summary(payload, lang_counts, json_path):
    totals = payload["totals"]
    langs = " ".join("%s:%d" % (ext, n) for ext, n in lang_counts.items())
    print()
    print("comment-cleaner (%s) — %s" % (payload["mode"], payload["repo"]))
    if payload["base"]:
        print("  comparing against: %s" % payload["base"])
    print("  files scanned: %d  [%s]" % (payload["filesScanned"], langs))
    print()
    print("  FLAGGED: %d   (leaks: %d, review: %d, dense files: %d)"
          % (totals["flagged"], totals["leaks"], totals["review"], totals["denseFiles"]))
    print()
    print("  data (json): %s" % json_path)
    print()


# ============================================================================
# CLI
# ============================================================================
def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="scan.py",
        description="Scan a git repo's comments for AI/prompt leakage and low-value narration.")
    parser.add_argument("mode", nargs="?", default="branch", choices=["branch", "full"],
                        help="branch (default): only changed lines on this branch; full: whole repo")
    parser.add_argument("repo_root", nargs="?",
                        help="repo path (defaults to the enclosing git repo)")
    parser.add_argument("--out", metavar="BASEPATH",
                        help="output base path; writes <out>.json "
                             "(default: a temp file named after the repo)")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    repo_root = resolve_repo_root(args.repo_root)
    payload, lang_counts = scan_repo(repo_root, args.mode)
    out_base = args.out or os.path.join(tempfile.gettempdir(), "comment-cleaner-%s" % os.path.basename(repo_root))
    json_path = write_outputs(out_base, payload)
    print_summary(payload, lang_counts, json_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
