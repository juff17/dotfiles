#!/usr/bin/env bash
# extras.sh — third-party pieces that setup downloads rather than links:
# the Claude Code plugins and marketplaces named in settings.json, and each
# mod's npm packages. Sourced by setup, which provides DRY_RUN.
#
# Each step installs only what is missing, so re-runs are quick. Uninstall
# leaves all of it in place: plugins may be in use outside jstack, and a mod's
# node_modules lives in this repo, git-ignored.

EXTRAS_FAILED=0

_extras_warn() { echo "  failed  $1" >&2; EXTRAS_FAILED=$((EXTRAS_FAILED + 1)); }

# _settings_lines SETTINGS — "marketplace NAME SOURCE" for each entry in
# extraKnownMarketplaces, then "plugin ID" for each plugin enabledPlugins turns on.
_settings_lines() {
  python3 -I - "$1" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
for name, m in s.get("extraKnownMarketplaces", {}).items():
    src = m.get("source", {})
    where = src.get("repo") or src.get("url") or src.get("path")
    if where:
        print("marketplace", name, where)
for plugin, on in s.get("enabledPlugins", {}).items():
    if on:
        print("plugin", plugin)
PY
}

# _have_lines JSON_KEY — reads a `claude plugin ... --json` array on stdin and
# prints each entry's JSON_KEY, keeping only user-scope entries when they say.
_have_lines() {
  python3 -I -c '
import json, sys
try:
    items = json.load(sys.stdin)
except ValueError:
    items = []
for i in items:
    if i.get("scope", "user") == "user":
        print(i.get(sys.argv[1], ""))
' "$1"
}

# claude_plugins SETTINGS — add the marketplaces and install the plugins that
# SETTINGS names, skipping any already on this machine.
claude_plugins() {
  local settings="$1" kind name where have_mkt have_plugins lines
  [ -f "$settings" ] || return 0
  if ! command -v python3 >/dev/null 2>&1; then
    _extras_warn "plugins  (python3 is needed to read $settings)"
    return 0
  fi
  # Claude Code itself reports a settings.json that is not valid JSON.
  lines="$(_settings_lines "$settings" 2>/dev/null)" || return 0
  [ -n "$lines" ] || return 0
  if ! command -v claude >/dev/null 2>&1; then
    _extras_warn "plugins  (the claude CLI is not on PATH)"
    return 0
  fi
  have_mkt="$(claude plugin marketplace list --json 2>/dev/null | _have_lines name)"
  have_plugins="$(claude plugin list --json 2>/dev/null | _have_lines id)"

  while read -r kind name where; do
    case "$kind" in
      marketplace)
        grep -qxF -- "$name" <<<"$have_mkt" && continue
        if [ "$DRY_RUN" -eq 1 ]; then
          echo "  would add  marketplace/$name"
        elif claude plugin marketplace add "$where" >/dev/null 2>&1; then
          echo "  added  marketplace/$name"
        else
          _extras_warn "marketplace/$name  (claude plugin marketplace add $where)"
        fi ;;
      plugin)
        grep -qxF -- "$name" <<<"$have_plugins" && continue
        if [ "$DRY_RUN" -eq 1 ]; then
          echo "  would install  plugin/$name"
        elif claude plugin install "$name" --scope user >/dev/null 2>&1; then
          echo "  installed  plugin/$name"
        else
          _extras_warn "plugin/$name  (claude plugin install $name)"
        fi ;;
    esac
  done <<<"$lines"
}

# mod_packages MOD — `npm ci` in MOD if it has a lockfile and its node_modules
# is missing or older than that lockfile.
mod_packages() {
  local mod="${1%/}" name
  name="$(basename "$mod")"
  [ -f "$mod/package-lock.json" ] || return 0
  if [ -f "$mod/node_modules/.package-lock.json" ] \
     && ! [ "$mod/package-lock.json" -nt "$mod/node_modules/.package-lock.json" ]; then
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would npm ci  mod/$name"
  elif ! command -v npm >/dev/null 2>&1; then
    _extras_warn "mod/$name  (npm is not on PATH)"
  # Mods render with the system Chrome, so puppeteer's own copy is not needed.
  elif (cd "$mod" && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund >/dev/null 2>&1); then
    echo "  npm ci  mod/$name"
  else
    _extras_warn "mod/$name  (cd $mod && PUPPETEER_SKIP_DOWNLOAD=1 npm ci)"
  fi
}
