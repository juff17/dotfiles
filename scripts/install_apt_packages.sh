#!/usr/bin/env bash
set -e

echo "==> Installing packages from apt-packages.txt"

LIST="$(dirname "${BASH_SOURCE[0]}")/../apt-packages.txt"
grep -vE '^\s*(#|$)' "$LIST" | xargs sudo apt install -y
