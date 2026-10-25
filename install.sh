#!/usr/bin/env bash
# dotfiles installer. Each folder under modules/ is one part of the setup, and may have:
#   packages.txt   apt packages, one per line (# comments allowed)
#   install.sh     other install steps (snap, curl installers, debconf, ...)
#   home/          files symlinked into $HOME at the same relative path
#   after-link.sh  runs after home/ is linked, also with --links
#   requires       modules to install first, one per line
#
#   ./install.sh                     every module, in ORDER
#   ./install.sh ghostty shell       just these, plus the modules they require
#   ./install.sh --links [module...] only symlink home/ (no sudo/apt, no installers)
#   ./install.sh --list              show the modules and what each one has
#
# Linking is per-file, so several modules can share a directory (~/.config). A file
# already in the way is moved into a timestamped backup folder, keeping its relative
# path; a link left from an older layout of this repo is replaced without a backup.
#   DOTFILES_TARGET=/path  override the link target (default $HOME) — handy for a dry run
#   DOTFILES_BACKUP=/path  override the backup root  (default <repo>/.dotfiles-backup, gitignored)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULES="$HERE/modules"
DEST="${DOTFILES_TARGET:-$HOME}"
BACKUP_ROOT="${DOTFILES_BACKUP:-$HERE/.dotfiles-backup}/$(date +%Y%m%d%H%M%S)"
export DEST

# kde goes first: base leaves out what kubuntu-desktop already pulls in.
ORDER=(kde base shell fonts node dev ghostty dolphin claude)

place() {  # place <src-file> <dest-path> <rel-path>
  local src="$1" dest="$2" rel="$3"
  if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
    echo "  ok      ~/$rel"; return
  fi
  if [ -L "$dest" ] && [[ "$(readlink "$dest")" == "$HERE"/* ]]; then
    rm "$dest"                                         # stale link into this repo
  elif [ -e "$dest" ] || [ -L "$dest" ]; then          # conflict -> backup folder (keep rel path)
    mkdir -p "$(dirname "$BACKUP_ROOT/$rel")"
    mv "$dest" "$BACKUP_ROOT/$rel"
    echo "  backup  ~/$rel -> ${BACKUP_ROOT/#$HOME/\~}/$rel"
  fi
  mkdir -p "$(dirname "$dest")"
  ln -s "$src" "$dest"
  echo "  link    ~/$rel"
}

link_module() {
  local dir="$MODULES/$1"
  if [ -d "$dir/home" ]; then
    while IFS= read -r -d '' f; do
      local rel="${f#"$dir/home"/}"
      place "$f" "$DEST/$rel" "$rel"
    done < <(find "$dir/home" -type f ! -name '.gitkeep' -print0)
  fi
  if [ -f "$dir/after-link.sh" ]; then
    bash "$dir/after-link.sh"
  fi
}

install_module() {
  local dir="$MODULES/$1"
  if [ -f "$dir/packages.txt" ]; then
    grep -vE '^\s*(#|$)' "$dir/packages.txt" | xargs -r sudo apt install -y
  fi
  if [ -f "$dir/install.sh" ]; then
    bash "$dir/install.sh"
  fi
  link_module "$1"
}

list_modules() {
  local m dir parts
  for dir in "$MODULES"/*/; do
    m=$(basename "$dir"); parts=()
    [ -f "$dir/packages.txt" ] && parts+=("apt: $(grep -vE '^\s*(#|$)' "$dir/packages.txt" | paste -sd' ')")
    [ -f "$dir/install.sh" ] && parts+=("install.sh")
    [ -d "$dir/home" ] && parts+=("linked files: $(find "$dir/home" -type f | wc -l)")
    [ -f "$dir/after-link.sh" ] && parts+=("after-link.sh")
    [ -f "$dir/requires" ] && parts+=("requires: $(paste -sd' ' "$dir/requires")")
    [[ " ${ORDER[*]} " == *" $m "* ]] || parts+=("(not in the full install)")
    printf '  %-9s %s\n' "$m" "$(IFS='|'; echo "${parts[*]}" | sed 's/|/ · /g')"
  done
}

# Adds <module> to SELECTED after the modules it requires.
SELECTED=()
select_module() {
  local m=$1 r
  [ -d "$MODULES/$m" ] || { echo "unknown module: $m (see ./install.sh --list)" >&2; exit 1; }
  [[ " ${SELECTED[*]} " == *" $m "* ]] && return 0
  if [ -f "$MODULES/$m/requires" ]; then
    while read -r r; do [ -n "$r" ] && select_module "$r"; done <"$MODULES/$m/requires"
  fi
  SELECTED+=("$m")
}

mode=install; args=()
for a in "$@"; do
  case "$a" in
    --links) mode=links ;;
    --list) list_modules; exit 0 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $a" >&2; exit 1 ;;
    *) args+=("$a") ;;
  esac
done
[ ${#args[@]} -gt 0 ] || args=("${ORDER[@]}")
for m in "${args[@]}"; do select_module "$m"; done

if [ "$mode" = links ]; then
  echo "linking -> $DEST"
  for m in "${SELECTED[@]}"; do echo "[$m]"; link_module "$m"; done
  echo "Done (links only)."
  exit 0
fi

echo "==> Modules: ${SELECTED[*]}"
sudo apt update
sudo apt install -y curl wget git gpg
for m in "${SELECTED[@]}"; do
  echo "==> [$m]"
  install_module "$m"
done
echo "==> Done"
