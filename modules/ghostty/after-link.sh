#!/usr/bin/env bash
# Links the Agents widget, copies the agent instructions' examples, and, as
# the layout treats any window it hasn't seen as new and builds its tmux
# layout there, records the windows already open as existing; only windows
# opened from now on get the layout. That last part is skipped for a dry-run
# target.
set -e

# The Agents panel widget is linked as one folder, not file by file like
# home/: Plasma refuses a widget whose files are links that lead outside its
# folder ("path traversal"), and then says the package doesn't exist.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
widgets="$DEST/.local/share/plasma/plasmoids"
widget="$widgets/dev.dotfiles.agents"
mkdir -p "$widgets"
if [ -d "$widget" ] && [ ! -L "$widget" ]; then
  # A folder of per-file links into this repo, from before, is replaced;
  # anything else is kept aside.
  if [ -z "$(find "$widget" ! -type d ! -lname "$repo/*" -print -quit)" ]; then
    rm -r "$widget"
  else
    mv "$widget" "$widget.dotfiles-backup"
  fi
fi
ln -sfn "$here/plasmoid/dev.dotfiles.agents" "$widget"
echo "  link    ~/.local/share/plasma/plasmoids/dev.dotfiles.agents (the folder)"

source "$(dirname "${BASH_SOURCE[0]}")/home/.config/ghostty/bin/ghostty-lib.sh"

# Your instructions for agents, from the examples the repo keeps.
copy_prompt_examples
echo "  copied  any missing prompts/*.md from their .example"

[ "$DEST" = "$HOME" ] && pgrep -x ghostty >/dev/null || exit 0

if state=$(state_dir); then
  windows >>"$state/known"
  echo "  marked open Ghostty windows as existing"
fi
