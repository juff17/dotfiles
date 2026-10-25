#!/usr/bin/env bash
# dotfiles installer.
#
#   ./install.sh            # full bootstrap: system packages -> link dotfiles -> program installers
#   ./install.sh --links    # only symlink home/ into $HOME (no sudo/apt, no program installers)
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
sudo apt install -y software-properties-common apt-transport-https wget git stow

echo "==> Installing APT packages"
bash "$HERE"/scripts/install_apt_packages.sh

echo "==> Running system installers"
for s in docker postgres gitlfs uv python zsh ohmyposh jetbrains_nf msfonts vscode; do
  bash "$HERE/scripts/install_$s.sh"
done

echo "==> Linking dotfiles"
link_dotfiles

echo "==> Installing programs"
DOTFILES_BACKUP="$BACKUP_ROOT" bash "$HERE"/context_groups/install.sh

echo "==> Done"
