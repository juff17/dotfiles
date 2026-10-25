#!/usr/bin/env bash
set -e

# Every other module assumes kubuntu-desktop: base leaves out what it already pulls in.
# On a GNOME install apt would stop to ask GDM vs SDDM; preseed SDDM so this runs unattended.
echo "==> Installing KDE (kubuntu-desktop)"

if dpkg -s kubuntu-desktop >/dev/null 2>&1; then
  echo "==> kubuntu-desktop already installed"
  exit 0
fi

echo "sddm shared/default-x-display-manager select sddm" | sudo debconf-set-selections
sudo apt install -y kubuntu-desktop
