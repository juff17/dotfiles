#!/usr/bin/env bash
# SessionStart hook: ensure Claude worktrees + orchestration artifacts are ignored in this repo.
# Writes to the repo-local, UNtracked .git/info/exclude (no commit, no tracked-file changes).
# Idempotent; a no-op outside a git repo. Applies to ANY repo you open with Claude Code.
set -euo pipefail

git rev-parse --git-common-dir >/dev/null 2>&1 || exit 0
exclude="$(git rev-parse --git-common-dir)/info/exclude"

for pattern in '.claude/worktrees/' 'GOAL.md' 'decision-log.jsonl' 'rebase-transcript.md'; do
  grep -qxF "$pattern" "$exclude" 2>/dev/null || printf '%s\n' "$pattern" >> "$exclude"
done

exit 0
