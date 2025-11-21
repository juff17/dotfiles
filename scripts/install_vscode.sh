#!/usr/bin/env bash
set -e

echo "==> Adding Microsoft GPG key for VS Code"

sudo wget -qO /usr/share/keyrings/microsoft.gpg \
    https://packages.microsoft.com/keys/microsoft.asc

echo "==> Adding VS Code repository"

echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] \
https://packages.microsoft.com/repos/code stable main" \
| sudo tee /etc/apt/sources.list.d/vscode.list

sudo apt update
sudo apt install -y code
