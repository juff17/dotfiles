#!/usr/bin/env bash
# targets.sh — the ONLY vendor-specific knowledge in jstack.
#
# For each vendor and tool type, where does the tool install? An empty result
# means "this vendor has no equivalent" and that type is skipped for it — this
# is how agents degrade gracefully off Claude.
#
# Adding a new agent = add a case here. Nothing in setup needs to change.
#
# NOTE: Claude is wired fully and verified. Codex/OpenCode paths for commands
# and agents are left empty until confirmed against those tools — only their
# skills dirs are trusted today. Fill them in when you actually run them.

# Known vendors, in preferred order. Used by --host auto detection.
JSTACK_VENDORS="claude codex opencode"

# jstack_target VENDOR TYPE — prints the absolute install dir, or "" if the
# vendor has no home for that type.
jstack_target() {
  local vendor="$1" type="$2"
  case "$vendor" in
    claude)
      case "$type" in
        skills)   echo "$HOME/.claude/skills" ;;
        commands) echo "$HOME/.claude/commands" ;;
        agents)   echo "$HOME/.claude/agents" ;;
        hooks)    echo "$HOME/.claude/hooks" ;;
        mods)     echo "$HOME/.claude/mods" ;;   # loaded via CLAUDE_CODE_PLUGIN_DIRS in settings.json
        config)   echo "$HOME/.claude" ;;   # settings.json, statusline script
      esac ;;
    codex)
      case "$type" in
        skills)   echo "$HOME/.codex/skills" ;;
        commands) echo "" ;;   # TODO: ~/.codex/prompts — verify format first
        agents)   echo "" ;;   # Codex has no subagent-file concept
      esac ;;
    opencode)
      case "$type" in
        skills)   echo "$HOME/.config/opencode/skills" ;;
        commands) echo "" ;;   # TODO: verify OpenCode command dir/format
        agents)   echo "" ;;   # TODO: verify OpenCode agent dir/format
      esac ;;
  esac
}

# jstack_detect — prints the vendors whose CLI is on PATH, space-separated.
jstack_detect() {
  local found=""
  command -v claude   >/dev/null 2>&1 && found="$found claude"
  command -v codex    >/dev/null 2>&1 && found="$found codex"
  command -v opencode >/dev/null 2>&1 && found="$found opencode"
  echo "$found" | xargs
}

# jstack_is_vendor NAME — true if NAME is a known vendor.
jstack_is_vendor() {
  case " $JSTACK_VENDORS " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
