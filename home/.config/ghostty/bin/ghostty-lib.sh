# Shared helpers for the layout scripts. Sourced, not run.
#
# Each Ghostty window runs an outer tmux (layout.conf) that lays the window
# out: btop on top, the viewer on the left and the tab session on the right.
# The tab session is a second tmux (tmux.conf) inside that pane. tmux sizes
# panes exactly; Ghostty's own splits can't be sized from a script, since its
# global keybinds act on every split of every window.

GHOSTTY_CONF="$(dirname "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")")"
LAYOUT_SOCKET=ghostty-layout
TABS_SOCKET=ghostty

layout() {
  tmux -L "$LAYOUT_SOCKET" -f "$GHOSTTY_CONF/layout.conf" "$@"
}

# One state folder per Ghostty process, so a restart starts clean.
state_dir() {
  local pid
  pid=$(pgrep -o -x ghostty) || return 1
  local dir="${XDG_RUNTIME_DIR:-/tmp}/ghostty-layout/$pid"
  mkdir -p "$dir" && echo "$dir"
}

# yazi's client id in window <win>'s viewer, which `ya emit-to` sends actions
# to. Window numbers are unique within the Ghostty process.
viewer_id() {
  echo $((4200000 + $1))
}

# The folder Files shows next in window <win>'s viewer, for when yazi isn't
# running to be told now.
viewer_dir_file() {
  echo "${XDG_RUNTIME_DIR:-/tmp}/ghostty-layout/viewer-$(viewer_id "$1").dir"
}

# Opens window <win>'s viewer left of the tab session, in Files at <dir>.
# yazi asks Ghostty about the terminal through tmux, and tmux hands Ghostty's
# answers to whichever pane has focus; in a Claude pane one reads as Alt+P
# (the model picker). So the viewer holds focus while yazi starts. yazi sets
# allow-passthrough on its pane between its first round of questions, which
# tmux answers, and its second, which Ghostty answers a moment later.
open_viewer() {
  local win=$1 dir=$2 tabs viewer i
  tabs=$(layout show -t "layout-$win" -v @tabs 2>/dev/null) || return
  # DV_TABS tells Diagrams and Diff whose active tab to follow.
  viewer=$(layout split-window -d -h -b -l "${GHOSTTY_VIEWER_SHARE:-40}%" \
    -t "$tabs" -P -F '#{pane_id}' -c "$dir" \
    -e "DV_TABS=$TABS_SOCKET:ghostty-$win" -e "VIEWER_ID=$(viewer_id "$win")" \
    "$GHOSTTY_CONF/bin/ghostty-viewer" "$dir" 2>/dev/null) || return
  command -v yazi >/dev/null || return 0
  layout select-pane -t "$viewer"
  for ((i = 0; i < 40; i++)); do
    [[ $(layout show -p -t "$viewer" -v allow-passthrough) == all ]] && break
    sleep 0.05
  done
  sleep 1
  layout select-pane -t "$tabs"
}

windows() {
  gdbus introspect --session --dest com.mitchellh.ghostty \
    --object-path /com/mitchellh/ghostty/window 2>/dev/null |
    sed -n 's/^ *node \([0-9][0-9]*\) .*/\1/p' | sort -n
}
