#!/usr/bin/env bash
# PreToolUse(Bash): let `rm` and `git rm` through without a prompt when every
# target is inside Claude's scratchpad (/tmp/claude-<uid>/...) or inside a linked
# git worktree (including Claude's .claude/worktrees/*); ask for any other rm.
# Anything that isn't a plain single command (pipes, chaining, expansion, ..) gets asked.

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
[[ -n $cwd ]] || cwd=$PWD

# Not an rm anywhere in the command: no opinion.
grep -qE '(^|[^[:alnum:]_-])rm([[:space:]]|$)' <<<"$cmd" || exit 0

decide() {
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
  exit 0
}

scratch="/tmp/claude-$(id -u)/"

# rm acts on the last path component itself, so only its parent's symlinks are
# resolved; a trailing slash makes rm follow the final component too.
resolve() {
  local p=$1
  [[ $p == /* ]] || p="$cwd/$p"
  if [[ $p == */ ]]; then
    realpath -m -- "$p"
  else
    local parent
    parent=$(realpath -m -- "$(dirname -- "$p")") || return 1
    printf '%s/%s\n' "${parent%/}" "$(basename -- "$p")"
  fi
}

# True when $1 is strictly below the top of a linked worktree. A linked
# worktree's git dir differs from the common dir; the main checkout's does not.
in_worktree() {
  local dir top gitdir common
  dir=$(dirname -- "$1")
  while [[ ! -d $dir ]]; do dir=$(dirname -- "$dir"); done
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  gitdir=$(git -C "$dir" rev-parse --path-format=absolute --git-dir) || return 1
  common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir) || return 1
  [[ $gitdir != "$common" && $1 == "$top"/?* ]]
}

# Reject anything a shell could expand or chain.
if [[ $cmd == *$'\n'* || $cmd =~ [\;\&\|\<\>\`\$\(\)\{\}\*\?\~\"\'\\] ]]; then
  decide ask "rm outside a plain single-command form"
fi

read -ra words <<<"$cmd"
if [[ ${words[0]} == rm ]]; then
  args=("${words[@]:1}")
elif [[ ${words[0]} == git && ${words[1]} == rm ]]; then
  args=("${words[@]:2}")
else
  decide ask "rm inside a compound command"
fi

targets=0
opts_done=0
for w in "${args[@]}"; do
  if ((!opts_done)); then
    [[ $w == -- ]] && { opts_done=1; continue; }
    [[ $w == --pathspec-from-file* ]] && decide ask "git rm reading paths from a file"
    [[ $w == -* ]] && continue
  fi
  [[ $w =~ (^|/)\.\.?/*$ ]] && decide ask "rm target ends in . or ..: $w"
  p=$(resolve "$w") || decide ask "could not resolve rm target: $w"
  if [[ $p == "$scratch"?* ]] || in_worktree "$p"; then
    targets=$((targets + 1))
  else
    decide ask "rm target outside a worktree or Claude's scratchpad: $w"
  fi
done

((targets > 0)) || decide ask "rm with no targets"
decide allow "rm limited to worktrees or Claude's scratchpad"
