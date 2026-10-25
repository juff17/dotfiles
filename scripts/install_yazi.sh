#!/usr/bin/env bash
set -e

# yazi (the Ghostty viewer's Files mode) isn't packaged for apt, so it comes from snap.
echo "==> Installing yazi (snap)"

if snap list yazi >/dev/null 2>&1; then
  echo "==> yazi already installed"
  exit 0
fi

sudo snap install yazi --classic

echo "==> yazi installed"
