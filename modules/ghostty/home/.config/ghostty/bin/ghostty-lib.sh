# Shared helpers for the layout scripts. Sourced, not run.
#
# Each Ghostty window runs an outer tmux (layout.conf) that lays the window
# out: btop on top, the viewer on the left and the tab session on the right.
# The tab session is a second tmux (tmux.conf) inside that pane. tmux sizes
# panes exactly; Ghostty's own splits can't be sized from a script, since its
# global keybinds act on every split of every window.

GHOSTTY_CONF="$(dirname "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")")"
# The sockets can be moved for tests, which then never touch the real servers.
LAYOUT_SOCKET=${GHOSTTY_LAYOUT_SOCKET:-ghostty-layout}
TABS_SOCKET=${AGENT_HUB_TABS_SOCKET:-ghostty}

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

# Adds the agent hub to window <win>'s outer session: the rail down the left
# of the workspace, and a second tmux window, hub, with its own rail and the
# hub itself. The rail's work and hub buttons, and Ctrl+Shift+A, switch
# between the two (layout.conf). GHOSTTY_RAIL=0 leaves it all out.
add_hub() {
  local win=$1 session="layout-$1" cols=${GHOSTTY_RAIL_COLS:-6} tabs top rail hub hub_rail
  [[ ${GHOSTTY_RAIL:-1} == 0 ]] && return 0
  [[ -n $(layout show -t "$session" -v @hub 2>/dev/null) ]] && return 0
  tabs=$(layout show -t "$session" -v @tabs 2>/dev/null) || return
  local bin="$GHOSTTY_CONF/bin/ghostty-hub"
  layout rename-window -t "$tabs" work
  rail=$(layout split-window -d -h -b -f -l "$cols" -t "$tabs" -P -F '#{pane_id}' \
    "$bin rail $win work") || return
  layout set -p -t "$rail" @rail 1
  hub=$(layout new-window -d -t "$session:" -n hub -P -F '#{pane_id}' "$bin hub $win") || return
  layout set -p -t "$hub" @hub 1
  hub_rail=$(layout split-window -d -h -b -f -l "$cols" -t "$hub" -P -F '#{pane_id}' \
    "$bin rail $win hub") || return
  layout set -p -t "$hub_rail" @rail 1
  layout set -t "$session" @hub "$hub"
  # tmux shares a resize out between the panes; this puts btop's height and
  # the rails' width back after one.
  top=$(layout list-panes -s -t "$session" -F '#{pane_id} #{@top}' | awk '$2 == 1 { print $1; exit }')
  layout set-hook -t "$session" window-resized \
    "${top:+resize-pane -t $top -y ${GHOSTTY_TOP_ROWS:-10} ; }resize-pane -t $rail -x $cols ; resize-pane -t $hub_rail -x $cols"
}

windows() {
  gdbus introspect --session --dest com.mitchellh.ghostty \
    --object-path /com/mitchellh/ghostty/window 2>/dev/null |
    sed -n 's/^ *node \([0-9][0-9]*\) .*/\1/p' | sort -n
}
