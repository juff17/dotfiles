#!/usr/bin/env bash
# Decide whether system-overview should CREATE or UPDATE for a target directory.
#
# Routing is decided solely by whether <target-dir>/docs/system-overview/ already exists:
#     exists  -> update
#     missing -> create
# The user's create/update keyword is intentionally NOT an input — existence always wins.
# The SL_SYSTEM_OVERVIEW_ROUTE= line below is the sole authority the skill obeys; its prefix
# is deliberately long and unique so nothing the user typed can be mistaken for it.
#
# Usage:
#     bash <skill-dir>/scripts/route.sh <target-dir>
#
# Prints two lines to stdout:
#     SL_SYSTEM_OVERVIEW_ROUTE=<create|update>
#     SL_SYSTEM_OVERVIEW_DOCS_DIR=<absolute path to docs/system-overview>

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: route.sh <target-dir>" >&2
  exit 2
fi

target_dir="$1"
if [ ! -d "$target_dir" ]; then
  echo "error: $target_dir is not a directory" >&2
  exit 1
fi

docs_dir="$(cd "$target_dir" && pwd)/docs/system-overview"

if [ -d "$docs_dir" ]; then
  route="update"
else
  route="create"
fi

printf 'SL_SYSTEM_OVERVIEW_ROUTE=%s\n' "$route"
printf 'SL_SYSTEM_OVERVIEW_DOCS_DIR=%s\n' "$docs_dir"
