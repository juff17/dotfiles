#!/usr/bin/env bash
set -e

echo "==> Updating system"
sudo apt update
sudo apt install -y software-properties-common apt-transport-https wget git stow

echo "==> Installing APT packages"
bash scripts/install_apt_packages.sh

echo "==> Running installers..."
bash scripts/install_docker.sh
bash scripts/install_postgres.sh
bash scripts/install_gitlfs.sh
bash scripts/install_uv.sh
bash scripts/install_python.sh
bash scripts/install_zsh.sh

echo "==> Done"