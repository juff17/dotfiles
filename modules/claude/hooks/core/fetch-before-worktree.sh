#!/usr/bin/env bash
# PreToolUse hook (EnterWorktree, Bash): fetches before a new worktree is made,
# since EnterWorktree branches from origin/<default> and would otherwise start
# from whatever was last fetched. It never blocks: a failed fetch only leaves
# a note. Settings › New agent › Fetch before a worktree turns it off.

input=$(cat)

settings=${AGENT_HUB_SETTINGS:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub/settings.json}
on=$(jq -r 'if has("worktree.fetch") then ."worktree.fetch" else true end' "$settings" 2>/dev/null)
[[ $on == false ]] && exit 0

tool=$(jq -r '.tool_name // ""' <<<"$input")
cwd=$(jq -r '.cwd // ""' <<<"$input")
case $tool in
  # Entering an existing worktree by path makes nothing new.
  EnterWorktree) [[ $(jq -r '.tool_input.path // ""' <<<"$input") ]] && exit 0 ;;
  Bash) jq -r '.tool_input.command // ""' <<<"$input" | grep -qE '\bgit\b[^;&|]*\bworktree[[:space:]]+add\b' || exit 0 ;;
  *) exit 0 ;;
esac

[[ -d $cwd ]] && cd "$cwd" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# origin, else the only remote there is; a repo with none has nothing to fetch.
remotes=$(git remote)
if grep -qxF origin <<<"$remotes"; then
  remote=origin
elif [[ $(wc -l <<<"$remotes") -eq 1 && -n $remotes ]]; then
  remote=$remotes
else
  exit 0
fi

if ! err=$(GIT_TERMINAL_PROMPT=0 timeout 30 git fetch --quiet "$remote" </dev/null 2>&1); then
  msg="git fetch $remote failed before making the worktree, so it starts from the last fetch: ${err:-timed out}"
  jq -n --arg m "$msg" '{systemMessage: $m}'
fi
exit 0
