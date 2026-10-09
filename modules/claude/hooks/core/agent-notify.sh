#!/usr/bin/env bash
# Notification: desktop alert when a Claude session needs you or finishes.
# For a background session (agent view), the alert gets an "Open" button that
# attaches to it in a new terminal. Set CLAUDE_NOTIFY_TERMINAL to change the
# terminal command (default: konsole -e).

input=$(cat)
type=$(jq -r '.notification_type // ""' <<<"$input")
title=$(jq -r '.title // "Claude Code"' <<<"$input")
msg=$(jq -r '.message // "Needs your attention"' <<<"$input")
project=$(basename "$(jq -r '.cwd // ""' <<<"$input")")

# A background session also fires permission_prompt and idle_prompt, which
# duplicate the agent view's own alert for the same event.
if [[ $type == permission_prompt || $type == idle_prompt ]]; then
  session=$(jq -r '.session_id // ""' <<<"$input")
  claude agents --json --all 2>/dev/null | jq -e --arg s "$session" \
    'any(.[]; .kind == "background" and .sessionId == $s)' >/dev/null && exit 0
fi

# agent_needs_input and agent_completed fire in the agent view process, so the
# hook input does not identify the background session. Look it up instead: the
# session whose name is in the message, else the only one in the matching state.
id=""
case $type in
  agent_needs_input) states='["blocked"]' ;;
  agent_completed) states='["done","failed"]' ;;
  *) states='' ;;
esac
if [[ -n $states ]]; then
  id=$(claude agents --json --all 2>/dev/null | jq -r --arg msg "$msg" --argjson states "$states" '
    [.[] | select(.kind == "background" and (.state as $s | $states | index($s)))] as $c
    | ([$c[] | select(.name as $n | $n != null and ($msg | contains($n)))] | first // empty).id
      // (if ($c | length) == 1 then $c[0].id else empty end)')
fi

[[ -n $project && $project != . ]] && title="$title ($project)"
read -ra term <<<"${CLAUDE_NOTIFY_TERMINAL:-konsole -e}"

# notify-send --wait blocks until the alert is clicked or dismissed, so run it
# detached and let the hook return right away.
if [[ -n $id ]]; then
  setsid -f bash -c '
    [[ $(notify-send --app-name="Claude Code" --wait -A open=Open "$1" "$2") == open ]] \
      && setsid -f "${@:4}" claude attach "$3"
  ' _ "$title" "$msg" "$id" "${term[@]}" >/dev/null 2>&1
else
  notify-send --app-name="Claude Code" "$title" "$msg"
fi
exit 0
