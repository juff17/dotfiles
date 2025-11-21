#!/usr/bin/env bash
set -e

echo "==> Installing Zsh"
sudo apt update
sudo apt install -y zsh curl git

echo "==> Installing Oh My Zsh"

# Backup existing .zshrc if present
if [ -f "$HOME/.zshrc" ]; then
    echo "Backing up existing .zshrc to .zshrc.pre-oh-my-zsh"
    cp "$HOME/.zshrc" "$HOME/.zshrc.pre-oh-my-zsh"
fi

# Install Oh My Zsh non-interactively
export RUNZSH=no
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

# Make sure default shell is zsh
if [ "$SHELL" != "$(which zsh)" ]; then
    echo "Changing default shell to zsh"
    chsh -s "$(which zsh)"
fi

echo "==> Zsh + Oh My Zsh installed!"
echo "You can now start a new terminal to use Zsh, or run 'zsh' to start it immediately."