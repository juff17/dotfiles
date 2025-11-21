#!/usr/bin/env bash
set -e

echo "==> Installing packages from apt-packages.txt"

xargs -a apt-packages.txt sudo apt install -y
