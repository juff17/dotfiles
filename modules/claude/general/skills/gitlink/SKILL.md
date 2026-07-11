---
name: gitlink
description: >
  Build shareable, clickable web permalinks to specific lines of code on the
  repo's git host. Use this whenever the user wants to share, link to, or point
  someone at a snippet, function, file, or line range — phrasings like 
  "send me a link to these lines", "get a permalink", "shareable link to this code".
license: MIT
---

# gitlink — shareable permalinks to code

Turn code locations into web links anyone can click. The work splits cleanly:
**you** figure out which file and lines the user means; the bundled script
turns that into a correct URL for whatever host the repo lives on. Let the
script own the fiddly parts (parsing the remote, picking the right URL shape
per host, pinning to a commit) so links are correct and consistent.

## Why permalinks pin to a commit

By default the script links to the current commit SHA, not a branch. A link
like `.../blob/main/app.py#L40-L52` silently rots — as `main` moves, those line
numbers point at different code. A commit-pinned link keeps showing exactly
what the user meant to share. Only use a branch link when the user explicitly
wants "whatever's latest on this branch".

## Steps

### 1. Find the repo and confirm it has a remote

Links are built from the repo's remote, so there must be one. The script reads
it for you, but if the user's code is in a specific repo, point at it with
`-C <dir>`. No remote → the script says so; tell the user the repo needs to be
pushed to a host first.

### 2. Identify the code block(s)

Two cases:

- **The user names them** — "lines 40-88 of src/auth.rb". Use directly as
  `src/auth.rb:40-88`.
- **The user describes them** — "link to the function we just changed", "share
  the retry logic". Find the file and read it to get the **exact** start/end
  line numbers of what they mean (the whole function, the specific block).
  Don't guess line numbers; open the file and confirm them.

Each block becomes one `FILE:START-END` argument (use `FILE:START` for a single
line, or just `FILE` for the whole file). You can pass as many as the user
wants — the script emits one link per block, in order.

### 3. Pick the ref

- Default (recommended): omit `--ref` — the script pins to the current commit.
- "Latest on the branch": pass `--branch`.
- A specific tag/branch/sha the user names: `--ref <thing>`.

**Make sure the ref is actually on the host**, or the link will 404. If you're
linking to local commits, confirm they're pushed — e.g. check
`git branch -r --contains HEAD`. If HEAD isn't pushed, either push it, or use
`--branch`/`--ref` with something that is, and tell the user what you did.

### 4. Build the links

Run the bundled script with every block at once:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/gitlink/scripts/gitlink.py" \
  -C <repo-dir> [--branch | --ref REF] [--markdown] SPEC [SPEC ...]
```

- `--markdown` — emit `[file:lines](url)`, handy for pasting into Markdown,
  PRs, or chat. Plain mode (default) emits one bare URL per line.
- `--json` — structured output if you need to post-process.
- `--host-type github|gitlab` — **only** needed for a self-hosted host whose
  domain doesn't reveal its type (the script auto-detects github/gitlab and
  warns when it has to guess). Look at the remote URL; if it's an internal
  GitLab/GitHub Enterprise, pass the right type.

### 5. Hand back the links

Give the user the link(s) directly. If you made a judgement call (pinned to a
commit, switched refs because HEAD wasn't pushed, guessed a host type), say so
in one line so the link is trustworthy.

## Examples

```bash
# One range, pinned to the current commit
gitlink.py -C ~/proj src/app.py:10-25

# Several blocks at once, as markdown links for a PR comment
gitlink.py -C ~/proj --markdown src/a.py:10-25 src/b.py:3 docs/README.md

# Latest-on-branch link instead of a pinned commit
gitlink.py -C ~/proj --branch src/app.py:10-25

# Self-hosted GitLab whose hostname doesn't contain "gitlab"
gitlink.py -C ~/work/svc --host-type gitlab lib/auth.rb:40-88
```

## Caveats worth surfacing to the user

- **Unpushed code** → the link 404s until the commit/branch is on the host.
- **Uncommitted local edits** → line numbers in your working tree may not match
  the pinned commit. Pin to a commit that actually contains the lines, or note
  the mismatch.
- **Private repos** → the link works, but only for people with access.
