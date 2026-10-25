#!/usr/bin/env bash
set -e

echo "==> Installing Microsoft TrueType Core Fonts (ttf-mscorefonts-installer)"

# Pre-accept the EULA to avoid interactive prompt
echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
  | sudo debconf-set-selections

sudo apt install -y --no-install-recommends ttf-mscorefonts-installer

sudo fc-cache -f -v
echo "==> Microsoft fonts installed successfully"
