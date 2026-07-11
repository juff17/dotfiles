#!/usr/bin/env python3
"""gitlink — build shareable web permalinks to lines of code on a repo's host.

Given one or more code blocks (FILE:START[-END]), emit a clickable link for each
that points at those lines on the remote host (GitHub, GitLab, or a self-hosted
instance). Handles N blocks in one call, so you can share several snippets at
once.

By default links pin to the current commit SHA, so they keep pointing at the
same lines even after the branch moves on. Pass --branch (or --ref) for a
"latest on this branch" link instead.

Usage:
  gitlink.py [options] SPEC [SPEC ...]

  SPEC is  FILE[:START[-END]]
    FILE        path to the file (absolute, relative to cwd, or repo-relative)
    START-END   line range; END optional for a single line; omit for whole file

Options:
  -C, --repo DIR     repo directory (default: current directory)
  --ref REF          branch/tag/sha to link to (default: current HEAD sha)
  --branch           link to the current branch name instead of the commit sha
  --remote NAME      remote to use (default: origin, else the first remote)
  --host-type TYPE   github|gitlab — override auto-detection, needed for
                     self-hosted hosts whose name doesn't reveal the type
  --markdown         emit markdown links: [FILE:START-END](url)
  --json             emit a JSON array of {spec, url, file, start, end}

Examples:
  gitlink.py src/app.py:10-25
  gitlink.py --markdown src/a.py:10-25 src/b.py:3 README.md
  gitlink.py --ref main src/app.py:10-25
  gitlink.py --host-type gitlab -C ~/work/internal lib/auth.rb:40-88
"""
import argparse
import json
import os
import re
import subprocess
import sys

# ---------------------------------------------------------------------------
# Provider registry — all provider-specific knowledge lives here.
#
# To add a provider, add an entry with its URL shapes:
#   blob    path after the https://host/owner/repo prefix for a file at a ref
#   line    fragment that highlights a single line
#   range   fragment that highlights a line range
# The entry's key doubles as its --host-type value, and any hostname
# containing the key auto-detects to it. If a provider runs public instances
# whose domain doesn't contain its name, add those to HOST_PATTERNS.
# Nothing outside this section branches on the host type.
# ---------------------------------------------------------------------------
PROVIDERS = {
    "github": {
        "blob": "blob/{ref}/{path}",
        "line": "#L{start}",
        "range": "#L{start}-L{end}",
    },
    "gitlab": {
        "blob": "-/blob/{ref}/{path}",
        "line": "#L{start}",
        "range": "#L{start}-{end}",
    },
}

# Extra hostname-substring -> provider mappings for domains that don't contain
# the provider's name (e.g. "codeberg.org": "gitea").
HOST_PATTERNS = {}

# Unknown self-hosted hosts fall back to this provider's shapes: github-style
# is the most common and also what GitHub Enterprise uses.
DEFAULT_PROVIDER = "github"
# --------------------------- end provider registry -------------------------


def die(msg):
    print(f"gitlink: {msg}", file=sys.stderr)
    sys.exit(1)


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    return r.stdout.strip()


def parse_remote(url):
    """Return (host, owner/repo-path) from any common remote URL form."""
    url = url.strip()
    # scp-like SSH: git@github.com:owner/repo.git
    m = re.match(r"^[\w.+-]+@([^:/]+):(.+)$", url)
    if not m:
        # ssh://git@host[:port]/path  or  https://host[:port]/path
        m = re.match(r"^[a-zA-Z][\w+.-]*://(?:[^@/]+@)?([^:/]+)(?::\d+)?/(.+)$", url)
    if not m:
        die(f"could not parse remote URL: {url!r}")
    host, path = m.group(1), m.group(2)
    path = re.sub(r"\.git/?$", "", path).strip("/")
    return host, path


def detect_host_type(host, override):
    if override:
        return override
    h = host.lower()
    for name in PROVIDERS:
        if name in h:
            return name
    for pattern, name in HOST_PATTERNS.items():
        if pattern in h:
            return name
    print(f"gitlink: unknown host {host!r}; assuming {DEFAULT_PROVIDER}-style "
          f"URLs (pass --host-type to override)", file=sys.stderr)
    return DEFAULT_PROVIDER


def build_url(host, repo_path, host_type, ref, path, start, end):
    shapes = PROVIDERS[host_type]
    blob = shapes["blob"].format(ref=ref, path=path)
    if start is None:
        frag = ""
    elif end is None:
        frag = shapes["line"].format(start=start)
    else:
        frag = shapes["range"].format(start=start, end=end)
    return f"https://{host}/{repo_path}/{blob}{frag}"


def parse_spec(spec):
    """FILE[:START[-END]] -> (file, start, end)."""
    if ":" in spec:
        left, right = spec.rsplit(":", 1)
        m = re.match(r"^(\d+)(?:-(\d+))?$", right)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else None
            if end is not None and end < start:
                start, end = end, start
            return left, start, end
    return spec, None, None


def repo_relative(root, file):
    """Resolve a user-supplied path to a repo-root-relative POSIX path.

    A path may be given relative to cwd or to the repo root. We only accept a
    resolved path that actually lives *inside* the repo — otherwise a same-named
    file in cwd (when cwd is a different repo) would hijack the link and the
    path would escape the root with '..'.
    """
    root = os.path.abspath(root)
    for cand in (os.path.abspath(file), os.path.join(root, file)):
        cand = os.path.abspath(cand)
        if os.path.exists(cand):
            rel = os.path.relpath(cand, root)
            if not rel.startswith(".."):
                return rel.replace(os.sep, "/")
    # Not found on disk — treat as already repo-relative, but never escape root.
    rel = os.path.normpath(file).replace(os.sep, "/").lstrip("/")
    if rel.startswith(".."):
        die(f"path escapes repo root: {file!r}")
    return rel


def main():
    ap = argparse.ArgumentParser(add_help=True, description="Build code permalinks.")
    ap.add_argument("specs", nargs="*", metavar="SPEC")
    ap.add_argument("-C", "--repo", default=".")
    ap.add_argument("--ref")
    ap.add_argument("--branch", action="store_true")
    ap.add_argument("--remote")
    ap.add_argument("--host-type", choices=sorted(PROVIDERS))
    ap.add_argument("--markdown", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not args.specs:
        die("no code blocks given. Try: gitlink.py FILE:START-END [...]")

    root = git(args.repo, "rev-parse", "--show-toplevel")
    if not root:
        die(f"{args.repo!r} is not a git repository")

    # Pick the remote.
    remotes = (git(root, "remote") or "").split()
    if not remotes:
        die("repo has no remote — push it to a host first, then retry")
    remote = args.remote or ("origin" if "origin" in remotes else remotes[0])
    if remote not in remotes:
        die(f"remote {remote!r} not found; available: {', '.join(remotes)}")
    remote_url = git(root, "remote", "get-url", remote)
    host, repo_path = parse_remote(remote_url)
    host_type = detect_host_type(host, args.host_type)

    # Resolve the ref.
    if args.ref:
        ref = args.ref
    elif args.branch:
        ref = git(root, "rev-parse", "--abbrev-ref", "HEAD")
        if not ref or ref == "HEAD":
            die("not on a branch (detached HEAD); pass --ref explicitly")
    else:
        ref = git(root, "rev-parse", "HEAD")
        if not ref:
            die("no commits yet — make a commit (and push) before linking")

    results = []
    for spec in args.specs:
        file, start, end = parse_spec(spec)
        rel = repo_relative(root, file)
        url = build_url(host, repo_path, host_type, ref, rel, start, end)
        results.append({"spec": spec, "url": url, "file": rel,
                        "start": start, "end": end})

    if args.json:
        print(json.dumps(results, indent=2))
    elif args.markdown:
        for r in results:
            rng = "" if r["start"] is None else \
                  f":{r['start']}" + (f"-{r['end']}" if r["end"] else "")
            print(f"[{r['file']}{rng}]({r['url']})")
    else:
        for r in results:
            print(r["url"])


if __name__ == "__main__":
    main()
