#!/usr/bin/env bash
set -e

echo "==> Installing uv (Python package manager and Python installer)"

curl -fsSL https://astral.sh/uv/install.sh | sh

echo "==> uv installed successfully"
