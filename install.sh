#!/usr/bin/env bash
# dotfiles installer.
#
#   ./install.sh            # full bootstrap: system packages -> system installers -> link dotfiles
#   ./install.sh --links    # only symlink home/ into $HOME (no sudo/apt, no installers)
#
# Dotfile linking is per-file (home/ mirrors $HOME), so multiple sources can share a directory.
# Conflicts are moved into a timestamped backup folder, preserving their relative path.
#   DOTFILES_TARGET=/path  override the link target (default $HOME) — handy for a dry run
#   DOTFILES_BACKUP=/path  override the backup root  (default <repo>/.dotfiles-backup, gitignored)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/home"
DEST="${DOTFILES_TARGET:-$HOME}"
BACKUP_ROOT="${DOTFILES_BACKUP:-$HERE/.dotfiles-backup}/$(date +%Y%m%d%H%M%S)"

place() {  # place <src-file> <dest-path> <rel-path>
  local src="$1" dest="$2" rel="$3"
  if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
    echo "  ok      ~/$rel"; return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then          # conflict -> backup folder (keep rel path)
    mkdir -p "$(dirname "$BACKUP_ROOT/$rel")"
    mv "$dest" "$BACKUP_ROOT/$rel"
    echo "  backup  ~/$rel -> ${BACKUP_ROOT/#$HOME/\~}/$rel"
  fi
  mkdir -p "$(dirname "$dest")"
  ln -s "$src" "$dest"
  echo "  link    ~/$rel"
}

link_dotfiles() {
  echo "linking dotfiles -> $DEST"
  while IFS= read -r -d '' f; do
    local rel="${f#"$SRC"/}"
    place "$f" "$DEST/$rel" "$rel"
  done < <(find "$SRC" -type f ! -name '.gitkeep' -print0)
  mark_ghostty_windows
}

# The Ghostty layout treats any window it hasn't seen as new and builds its
# tmux layout there, so record the windows already open as existing; only
# windows opened from now on get the layout. Skipped for a dry-run target.
mark_ghostty_windows() {
  [ "$DEST" = "$HOME" ] && pgrep -x ghostty >/dev/null || return 0
  (
    source "$SRC/.config/ghostty/bin/ghostty-lib.sh"
    if state=$(state_dir); then
      windows >>"$state/known"
      echo "  marked open Ghostty windows as existing"
    fi
  )
}

# --- links-only mode -------------------------------------------------------
if [ "${1:-}" = "--links" ]; then
  link_dotfiles
  echo "Done (links only)."
  exit 0
fi

# --- full bootstrap --------------------------------------------------------
echo "==> Updating system"
sudo apt update
sudo apt install -y software-properties-common apt-transport-https wget git

# apt-packages.txt leaves out what kubuntu-desktop already pulls in, so it must be present.
# On a GNOME install apt would stop to ask GDM vs SDDM; preseed SDDM so this runs unattended.
echo "==> Installing KDE (kubuntu-desktop)"
if ! dpkg -s kubuntu-desktop >/dev/null 2>&1; then
  echo "sddm shared/default-x-display-manager select sddm" | sudo debconf-set-selections
  sudo apt install -y kubuntu-desktop
fi

echo "==> Installing APT packages"
bash "$HERE"/scripts/install_apt_packages.sh

echo "==> Running system installers"
for s in docker uv node yazi zsh jetbrains_nf msfonts claude; do
  bash "$HERE/scripts/install_$s.sh"
done

echo "==> Linking dotfiles"
link_dotfiles

echo "==> Done"
