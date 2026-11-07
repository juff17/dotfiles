#!/usr/bin/env bash
# Desktop alert for a babysit event that needs the user.
# Usage: notify.sh TITLE MESSAGE
# Skipped while the Agents panel widget runs (dotfiles' ghostty module): it
# shows the babysit's monitor events itself, and touches clients/tray every
# few seconds while it does.

tray=${XDG_RUNTIME_DIR:-/tmp}/agent-hub/clients/tray
if [[ -f $tray ]] && (($(date +%s) - $(stat -c %Y "$tray") < 15)); then
  exit 0
fi

title=${1:-PR babysit}
msg=${2:-Needs your attention}

if command -v notify-send >/dev/null; then
  notify-send --app-name="Claude Code" "$title" "$msg"
elif command -v osascript >/dev/null; then
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
    -e 'end run' "$title" "$msg"
else
  printf '\a'
fi
exit 0
