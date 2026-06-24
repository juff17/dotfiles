#!/usr/bin/env bash
# Install context-groups: symlink the cg CLI and the /cg slash command into place.
# Idempotent. Backs up any existing non-symlink targets. Use --copy to copy instead
# of symlinking (symlinks let repo edits take effect immediately; the default).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$REPO_DIR/bin/cg"
CMD_SRC="$REPO_DIR/commands/cg.md"

BIN_DEST="${CG_BIN_DIR:-$HOME/.local/bin}/cg"
CMD_DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands/cg.md"

MODE="symlink"
[ "${1:-}" = "--copy" ] && MODE="copy"

# Backup root, shared with the parent dotfiles installer when invoked from it.
# Standalone default: <repo>/.dotfiles-backup (repo root is two levels up from this script).
DOTFILES_ROOT="$(cd "$REPO_DIR/../.." && pwd)"
BACKUP_ROOT="${DOTFILES_BACKUP:-$DOTFILES_ROOT/.dotfiles-backup/$(date +%Y%m%d%H%M%S)}"

link_or_copy() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  # back up a real file/dir that isn't already our symlink, into the shared backup folder
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    local rel="${dest#"$HOME"/}"
    mkdir -p "$(dirname "$BACKUP_ROOT/$rel")"
    mv "$dest" "$BACKUP_ROOT/$rel"
    echo "  backed up existing $dest -> $BACKUP_ROOT/$rel"
  fi
  rm -f "$dest"
  if [ "$MODE" = "copy" ]; then
    cp "$src" "$dest"
  else
    ln -s "$src" "$dest"
  fi
  echo "  $MODE: $dest -> $src"
}

echo "Installing context-groups ($MODE)..."
chmod +x "$BIN_SRC"
link_or_copy "$BIN_SRC" "$BIN_DEST"
link_or_copy "$CMD_SRC" "$CMD_DEST"

# PATH check
BIN_DIR="$(dirname "$BIN_DEST")"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "  $BIN_DIR is on PATH ✓" ;;
  *) echo "  NOTE: $BIN_DIR is not on PATH. Add this to your shell rc:"
     echo "        export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo "Done. Try:  cg create demo .   &&   cg list"
