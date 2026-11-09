#!/usr/bin/env bash
# Runs every test suite in the repo. Each suite still runs when an earlier one fails,
# and the exit code is non-zero if any did.
#   ./test.sh            all suites
#   ./test.sh ghostty    just these: ghostty, claude, mods
set -uo pipefail

cd "$(dirname "$0")" || exit 1
ROOT=$PWD
# A git hook (pre-commit) runs with GIT_DIR and friends set to this repo, and
# tests that make folders of their own would then see this repo in them.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
GHOSTTY=modules/ghostty/home/.config/ghostty

suite_ghostty() { node --test "$GHOSTTY"/viewer/*.test.mjs "$GHOSTTY"/hub/*.test.mjs; }
suite_claude() { (cd modules/claude && python3 -m unittest discover -s tests); }
suite_mods() {
  # Mods are tested by Claude Code's own runner; skip them quietly where it isn't installed.
  if ! command -v claude >/dev/null; then
    echo "skip: claude CLI not found"
    return 0
  fi
  local status=0 dir
  for dir in "$ROOT"/modules/claude/mods/*/*/; do
    compgen -G "$dir/hooks/*.test.tsx" >/dev/null || continue
    (cd "$dir" && claude plugin test .) || status=1
  done
  return $status
}

suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(ghostty claude mods)

failed=()
for suite in "${suites[@]}"; do
  case $suite in
    ghostty | claude | mods) ;;
    *) echo "unknown suite: $suite (ghostty, claude, mods)" >&2; exit 2 ;;
  esac
  echo "== $suite"
  "suite_$suite" || failed+=("$suite")
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "all passed: ${suites[*]}"
