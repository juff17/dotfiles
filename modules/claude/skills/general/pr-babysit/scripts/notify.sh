#!/usr/bin/env bash
# Puts a babysit event that needs the user in the Agents tray (the panel
# widget in dotfiles' ghostty module), as a ▲ item whose Go button opens this
# session. No desktop pop-up.
# Usage: notify.sh TITLE MESSAGE
#   TITLE    what it's about, e.g. "jstack !123"
#   MESSAGE  one line: what needs them
#
# A note is one JSON file in $XDG_RUNTIME_DIR/agent-hub/notes/, read by the
# tray (hub/tray.mjs). It names this session, so Go can find it, and leaves
# once the user goes to it or dismisses it.

title=${1:-PR babysit}
msg=${2:-Needs your attention}

dir=${XDG_RUNTIME_DIR:-/tmp}/agent-hub/notes
mkdir -p "$dir"
name=$(date +%s%N)-$$
jq -n --arg title "$title" --arg message "$msg" \
  --arg session "${CLAUDE_CODE_SESSION_ID:-}" --arg pane "${TMUX_PANE:-}" \
  --argjson at "$(date +%s%3N)" \
  '{title: $title, message: $message, session: $session, pane: $pane, at: $at}' >"$dir/.$name"
# Renamed into place, so the tray never reads half a note.
mv "$dir/.$name" "$dir/$name.json"
exit 0
