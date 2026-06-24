---
description: Switch the active context group, or show it with --active
argument-hint: [<group-name> | --active]
allowed-tools: Bash(cg:*)
---
!`cg apply "$ARGUMENTS"`

The output above is your context-group status:

- For `--active` (or no argument): the repositories in this session's **active
  workspace** — the primary directory plus any added repos.
- For a group name: confirmation that the group's repos were written to this project's
  `.claude/settings.local.json` (`permissions.additionalDirectories`) and picked up by
  Claude Code's settings watcher.

If you just switched and a repo isn't immediately readable/editable, the settings file
didn't exist when this session started (the watcher only tracks files present at
startup) — open `/hooks` once to force a reload, or it'll be available next launch.
Run `cg init --all` to pre-bootstrap every group directory so this never happens again.
