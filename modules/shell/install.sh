#!/usr/bin/env bash
set -e

echo "==> Installing Oh My Zsh"

# KEEP_ZSHRC leaves ~/.zshrc alone: this module links its own.
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    RUNZSH=no CHSH=no KEEP_ZSHRC=yes \
        sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
fi

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

# The p10k prompt draws its icons from a Nerd Font.
bash "$(dirname "${BASH_SOURCE[0]}")/nerd-font.sh"

echo "==> Zsh + Oh My Zsh + Powerlevel10k installed!"
echo "You can now start a new terminal to use Zsh, or run 'zsh' to start it immediately."