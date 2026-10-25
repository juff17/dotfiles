#!/usr/bin/env bash
set -e

# Node.js through fnm. The Ghostty viewer's Diff and Diagrams modes run on it.
# .zshrc already loads fnm from this folder, so the installer must not edit it.
echo "==> Installing fnm + Node.js LTS"

FNM_PATH="$HOME/.local/share/fnm"

if [ ! -x "$FNM_PATH/fnm" ]; then
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$FNM_PATH" --skip-shell
fi

# The first version installed becomes fnm's default.
if "$FNM_PATH/fnm" list | grep -q '^\* v'; then
  echo "==> Node.js already installed ($("$FNM_PATH/fnm" list | grep -m1 default))"
else
  "$FNM_PATH/fnm" install --lts
fi

echo "==> fnm + Node.js installed"
