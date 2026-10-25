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

echo "==> Installing Powerlevel10k theme"
P10K_DIR="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k"
if [ ! -d "$P10K_DIR" ]; then
    git clone --depth=1 https://github.com/romkatv/powerlevel10k.git "$P10K_DIR"
fi

# Make sure default shell is zsh
if [ "$SHELL" != "$(which zsh)" ]; then
    echo "Changing default shell to zsh"
    chsh -s "$(which zsh)"
fi

echo "==> Zsh + Oh My Zsh + Powerlevel10k installed!"
echo "You can now start a new terminal to use Zsh, or run 'zsh' to start it immediately."