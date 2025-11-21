#!/usr/bin/env bash
set -e

echo "==> Installing Python via uv"

# Ensure uv is in PATH for this script run
export PATH="$HOME/.local/bin:$PATH"

# Choose your preferred Python versions
PYTHON_VERSION="3.12"

uv python install $PYTHON_VERSION

# Set it as global default
uv python pin $PYTHON_VERSION

echo "==> Python $PYTHON_VERSION installed and set as default"