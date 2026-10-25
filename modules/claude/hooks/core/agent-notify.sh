#!/usr/bin/env bash
# Notification and Stop: desktop alert when a Claude session needs you or
# finishes. Alerts that need you (a permission prompt, a background session
# waiting on input) are critical, so Plasma keeps them up until dismissed.
# For a background session (agent view), the alert gets an "Open" button that
# attaches to it in a new terminal. Set CLAUDE_NOTIFY_TERMINAL to change the
# terminal command (default: konsole -e).
#
# In tmux the alert names the tab, and nothing pops up while that tab is in
# front of you. Stop only alerts in tmux, where it can tell; elsewhere
# idle_prompt covers a finished session a minute later.
#
# The icon and the claude-code desktop entry (for per-app settings in System
# Settings > Notifications) come from dotfiles, under ~/.local/share.

input=$(cat)
event=$(jq -r '.hook_event_name // ""' <<<"$input")
type=$(jq -r '.notification_type // ""' <<<"$input")
title=$(jq -r '.title // "Claude Code"' <<<"$input")
msg=$(jq -r '.message // "Needs your attention"' <<<"$input")
session=$(jq -r '.session_id // ""' <<<"$input")
project=$(basename "$(jq -r '.cwd // ""' <<<"$input")")
[[ $project == . ]] && project=""
[[ $event == Stop ]] && type=stop

# A background session also fires permission_prompt and idle_prompt, which
# duplicate the agent view's own alert for the same event.
if [[ $type == permission_prompt || $type == idle_prompt ]]; then
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

# The session's own tmux tab, unless it is in front of you.
tab=""
if [[ -z $states && -n ${TMUX:-} && -n ${TMUX_PANE:-} ]]; then
  # \037 rather than a tab, which read would merge when client_flags is empty.
  IFS=$'\037' read -r active flags tab < <(tmux display -p -t "$TMUX_PANE" \
    $'#{window_active}\037#{client_flags}\037#{window_index}:#{window_name}' 2>/dev/null)
  [[ $active == 1 && $flags == *focused* ]] && exit 0
fi

# Plasma reads the body as markup, so text from Claude is escaped.
escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

urgency=normal
case $type in
  stop)
    # The tab bell and idle_prompt cover a finished session outside tmux.
    [[ -n $tab ]] || exit 0
    title="Claude finished"
    msg=""
    ;;
  idle_prompt)
    # In tmux, Stop already alerted when Claude finished.
    [[ -z $tab ]] || exit 0
    title="Claude is waiting for you"
    ;;
  permission_prompt) title="Claude needs your permission"; urgency=critical ;;
  agent_needs_input) urgency=critical ;;
esac

where=${tab:+tab $tab}
where=${where:-$project}
[[ -n $where ]] && title="$title · $where"
body=$(escape <<<"$msg")
[[ -n $tab && -n $project ]] && body="<b>$(escape <<<"$project")</b>${body:+
$body}"

args=(--app-name="Claude Code" --icon=claude-code --hint=string:desktop-entry:claude-code
  --urgency="$urgency" "$title" "$body")
read -ra term <<<"${CLAUDE_NOTIFY_TERMINAL:-konsole -e}"

# notify-send --wait blocks until the alert is clicked or dismissed, so run it
# detached and let the hook return right away.
if [[ -n $id ]]; then
  setsid -f bash -c '
    [[ $(notify-send --wait -A open=Open "${@:3:$1}") == open ]] \
      && setsid -f "${@:$1+3}" claude attach "$2"
  ' _ "${#args[@]}" "$id" "${args[@]}" "${term[@]}" >/dev/null 2>&1
else
  notify-send "${args[@]}"
fi
exit 0
