#!/usr/bin/env bash
# install-jetbrains-mono-nerd-font.sh
# Install JetBrainsMono Nerd Font for the current user on Linux (Ubuntu-friendly).

set -euo pipefail

FONT_NAME="JetBrainsMono"
NF_REPO="ryanoasis/nerd-fonts"
DOWNLOAD_URL="https://github.com/${NF_REPO}/releases/latest/download/${FONT_NAME}.tar.xz"

# User font directory (no root needed)
FONT_DIR="${HOME}/.local/share/fonts/NerdFonts/${FONT_NAME}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "==> Installing ${FONT_NAME} Nerd Font"
echo "    Target directory: ${FONT_DIR}"
echo "    Download URL:     ${DOWNLOAD_URL}"
echo

# Ensure required tools exist
for cmd in curl tar fc-cache; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: required command '${cmd}' not found in PATH." >&2
    echo "       Install it and re-run this script." >&2
    exit 1
  fi
done

mkdir -p "${FONT_DIR}"

echo "==> Downloading archive..."
curl -L "${DOWNLOAD_URL}" -o "${TMP_DIR}/${FONT_NAME}.tar.xz"

echo "==> Extracting fonts..."
tar -xJf "${TMP_DIR}/${FONT_NAME}.tar.xz" -C "${TMP_DIR}"

echo "==> Copying .ttf/.otf files into ${FONT_DIR}..."
find "${TMP_DIR}" -type f \( -name '*.ttf' -o -name '*.otf' \) -print -exec cp -f {} "${FONT_DIR}/" \;

echo "==> Refreshing font cache..."
fc-cache -f "${FONT_DIR}"

echo
echo "✔ JetBrainsMono Nerd Font installed for user: ${USER}"
echo "  Fonts were placed in: ${FONT_DIR}"
echo
echo "You can now set the font in your terminal/editor to something like:"
echo "  'JetBrainsMono Nerd Font', 'JetBrainsMonoNerdFont', or similar"
echo "(exact name depends on how your terminal/editor lists it)."
