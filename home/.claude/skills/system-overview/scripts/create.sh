#!/usr/bin/env bash
# Create the docs/system-overview/ folder for the system-overview skill.
#
# Ensures <target-dir>/docs/system-overview/ exists and prints its absolute path
# to stdout. The main agent captures this and writes its markdown into it.
# Idempotent — re-running over an existing folder is fine; the agent's writes
# overwrite individual files.
#
# The folder is intentionally a fixed, tracked path (not gitignored): the
# generated wiki is meant to live alongside the codebase.
#
# Usage:
#     bash <skill-dir>/scripts/create.sh <target-dir>
#
#     Where <skill-dir> is one of:
#       ~/.claude/skills/system-overview     (Claude Code, global)
#       ~/.cursor/skills/system-overview     (Cursor, global)
#       .cursor/skills/system-overview       (Cursor, project)
#       .claude/skills/system-overview       (Claude Code, project)

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: create.sh <target-dir>" >&2
  exit 2
fi

target_dir="$1"
if [ ! -d "$target_dir" ]; then
  echo "error: $target_dir is not a directory" >&2
  exit 1
fi

# Resolve to an absolute path so the printed location is unambiguous wherever it's used.
folder="$(cd "$target_dir" && pwd)/docs/system-overview"
mkdir -p "$folder"
printf '%s\n' "$folder"
