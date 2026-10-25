#!/usr/bin/env bash
# The layout treats any window it hasn't seen as new and builds its tmux layout
# there, so record the windows already open as existing; only windows opened
# from now on get the layout. Skipped for a dry-run target.
set -e

[ "$DEST" = "$HOME" ] && pgrep -x ghostty >/dev/null || exit 0

source "$(dirname "${BASH_SOURCE[0]}")/home/.config/ghostty/bin/ghostty-lib.sh"
if state=$(state_dir); then
  windows >>"$state/known"
  echo "  marked open Ghostty windows as existing"
fi
