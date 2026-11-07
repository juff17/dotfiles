#!/usr/bin/env bash
set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The native install updates itself, so only install when it's missing.
if [ -x "$HOME/.local/bin/claude" ]; then
  echo "==> Claude Code already installed ($("$HOME/.local/bin/claude" --version))"
else
  echo "==> Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  echo "==> Claude Code installed"
fi

# setup needs the claude CLI on PATH to install plugins.
PATH="$HOME/.local/bin:$PATH" "$HERE/setup" --host claude
