#!/usr/bin/env bash
# context-groups installer — delegates to the Claude Code installer.
#
#   ./install.sh           # install the cg CLI + /cg slash command
#   ./install.sh --copy    # copy instead of symlink
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SUB="$HERE/claude/install.sh"
[ -x "$SUB" ] || { echo "missing installer: $SUB" >&2; exit 1; }
exec "$SUB" "$@"
