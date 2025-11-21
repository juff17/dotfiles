#!/usr/bin/env bash
set -euo pipefail

# install-oh-my-posh.sh
# Installs Oh My Posh and the full theme pack on Ubuntu (user-local).

# -------------------------------
# Helpers
# -------------------------------
need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command '$1' not found." >&2
    return 1
  fi
}

download() {
  local url="$1"
  local dest="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$dest"
  else
    echo "Error: need either curl or wget to download $url" >&2
    exit 1
  fi
}

ensure_unzip() {
  if command -v unzip >/dev/null 2>&1; then
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    echo "Installing 'unzip' via apt-get (requires sudo)..."
    sudo apt-get update -y
    sudo apt-get install -y unzip
  else
    echo "Error: 'unzip' is not installed and apt-get is not available." >&2
    exit 1
  fi
}

# -------------------------------
# Detect architecture
# -------------------------------
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)
    OMP_ASSET="posh-linux-amd64"
    ;;
  aarch64|arm64)
    OMP_ASSET="posh-linux-arm64"
    ;;
  armv7l|armv7hf)
    OMP_ASSET="posh-linux-arm"
    ;;
  *)
    echo "Error: unsupported architecture '$arch' for Oh My Posh." >&2
    exit 1
    ;;
esac

# -------------------------------
# Paths and URLs
# -------------------------------
BIN_DIR="${HOME}/.local/bin"
THEMES_DIR="${HOME}/.poshthemes"

OMP_URL="https://github.com/JanDeDobbeleer/oh-my-posh/releases/latest/download/${OMP_ASSET}"
THEMES_URL="https://github.com/JanDeDobbeleer/oh-my-posh/releases/latest/download/themes.zip"

mkdir -p "$BIN_DIR" "$THEMES_DIR"

# -------------------------------
# Install Oh My Posh binary
# -------------------------------
echo "Installing Oh My Posh binary to: $BIN_DIR"

download "$OMP_URL" "${BIN_DIR}/oh-my-posh"
chmod +x "${BIN_DIR}/oh-my-posh"

echo "Oh My Posh version: $("${BIN_DIR}/oh-my-posh" --version || true)"

# -------------------------------
# Install theme pack
# -------------------------------
echo "Installing Oh My Posh themes to: $THEMES_DIR"

ensure_unzip

TMP_ZIP="${THEMES_DIR}/themes.zip"
download "$THEMES_URL" "$TMP_ZIP"

unzip -o "$TMP_ZIP" -d "$THEMES_DIR"
chmod u+rw "${THEMES_DIR}"/*.omp.* 2>/dev/null || true
rm -f "$TMP_ZIP"

# -------------------------------
# Final notes
# -------------------------------
echo
echo "✓ Oh My Posh installed at: ${BIN_DIR}/oh-my-posh"
echo "✓ Themes installed in:      ${THEMES_DIR}"
echo

# Check PATH
case ":$PATH:" in
  *:"$BIN_DIR":*)
    ;;
  *)
    echo "⚠️  '$BIN_DIR' is not in your PATH."
    echo "   Add this to your shell config (e.g. ~/.bashrc or ~/.zshrc):"
    echo "     export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo
    ;;
esac

cat <<'EOF'
To enable Oh My Posh for bash, add something like this to your ~/.bashrc:

  eval "$(oh-my-posh init bash --config ~/.poshthemes/jandedobbeleer.omp.json)"

Then restart your terminal or run:

  source ~/.bashrc

EOF
