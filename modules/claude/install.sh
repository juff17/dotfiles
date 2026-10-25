#!/usr/bin/env bash
set -e

echo "==> Installing Claude Code"

# The native install updates itself, so only install when it's missing.
if [ -x "$HOME/.local/bin/claude" ]; then
  echo "==> Claude Code already installed ($("$HOME/.local/bin/claude" --version))"
  exit 0
fi

curl -fsSL https://claude.ai/install.sh | bash

echo "==> Claude Code installed"
