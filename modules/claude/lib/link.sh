#!/usr/bin/env bash
# link.sh — symlink-or-copy helper shared by setup.
#
# On macOS/Linux: create a symlink, so edits in the repo are live and a
# `git pull` refreshes every install at once.
# On Windows (MSYS2 / Git Bash without Developer Mode): `ln -snf` silently
# produces a frozen copy that never refreshes. We make that explicit with a
# real `cp` so the staleness is at least re-runnable (re-run ./setup after a
# pull). Set JSTACK_FORCE_COPY=1 to force copy behavior on any platform.

_IS_WINDOWS=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) _IS_WINDOWS=1 ;;
esac

# _link_or_copy SRC DST — link (or copy) SRC to DST, replacing whatever is there.
# Auto-detects file vs directory. No-op if SRC does not exist.
_link_or_copy() {
  local src="$1" dst="$2"
  [ -e "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  if [ "$_IS_WINDOWS" -eq 1 ] || [ "${JSTACK_FORCE_COPY:-0}" -eq 1 ]; then
    if [ -d "$src" ]; then cp -R "$src" "$dst"; else cp -f "$src" "$dst"; fi
  else
    ln -snf "$src" "$dst"
  fi
}
