#!/usr/bin/env bash
# PreToolUse(Bash): let `rm` through without a prompt when every target is inside
# Claude's scratchpad (/tmp/claude-<uid>/...); ask for any other rm.
# Anything that isn't a plain single rm (pipes, chaining, expansion, ..) gets asked.

cmd=$(jq -r '.tool_input.command // empty')

# Not an rm anywhere in the command: no opinion.
grep -qE '(^|[^[:alnum:]_-])rm([[:space:]]|$)' <<<"$cmd" || exit 0

decide() {
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
  exit 0
}

scratch="/tmp/claude-$(id -u)/"

# Reject anything a shell could expand or chain.
if [[ $cmd == *$'\n'* || $cmd =~ [\;\&\|\<\>\`\$\(\)\{\}\*\?\~\"\'\\] || $cmd == *..* ]]; then
  decide ask "rm outside a plain scratchpad-only form"
fi

read -ra words <<<"$cmd"
[[ ${words[0]} == rm ]] || decide ask "rm inside a compound command"

targets=0
for w in "${words[@]:1}"; do
  [[ $w == -* ]] && continue
  [[ $w == "$scratch"?* ]] || decide ask "rm target outside Claude's scratchpad: $w"
  targets=$((targets + 1))
done

((targets > 0)) || decide ask "rm with no targets"
decide allow "rm limited to Claude's scratchpad"
