#!/usr/bin/env bash
set -e

echo "==> Installing git-lfs"

sudo apt install -y git-lfs

# Enable git-lfs globally
sudo git lfs install --system

echo "==> git-lfs installed and initialized"