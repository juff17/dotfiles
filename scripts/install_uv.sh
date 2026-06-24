#!/usr/bin/env bash
set -e

echo "==> Installing uv (Python package manager and Python installer)"

curl -fsSL https://astral.sh/uv/install.sh | sh

# Add uv to PATH (if not already present)
if ! grep -q "~/.local/bin" ~/.bashrc; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi

echo "==> uv installed successfully"
