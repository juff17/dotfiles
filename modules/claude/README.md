# jstack

Personal home for coding-agent tooling — skills, slash commands, and subagents —
organized into **bundles** and installed onto any machine with one command.

The point: on a new PC, `git clone` this repo and run `./setup`. Your agent
tools land in the right place for whichever agent(s) you have installed. No
marketplaces, no per-repo sprawl.

## Layout

```
jstack/
  setup                 # the entrypoint your dotfiles call
  lib/
    link.sh             # symlink-or-copy helper
    targets.sh          # the only vendor-specific file: vendor -> install dirs
  general/              # a bundle — anatomy of one:
    skills/    <name>/SKILL.md
    commands/  <name>.md
    agents/    <name>.md
  docify/               # a bundle (document-writing skills)
  review/               # a bundle
  daily-prep/           # a bundle (slack digest, standup prep)
  shortcuts/            # a bundle (short-circuit guidance prompts)
```

A **bundle** is just a folder that groups related tools. It is a
source-organization and install-selection concept only — at install time
everything flattens into the agent's own directories, so **tool names must be
globally unique across bundles.** (Commands are the exception: they are
namespaced by bundle, so `docify/commands/foo.md` installs as `/docify:foo`.)

## Install

```sh
./setup                   # every bundle into every detected agent
./setup --host claude     # only Claude Code
./setup --bundle docify   # only the docify bundle
./setup --dry-run         # show what would happen, change nothing
./setup --uninstall       # remove everything jstack installed
./setup --copy            # copy instead of symlink (Windows / forced)
```

Installs are **symlinks** on macOS/Linux, so edits here are live and
`git pull` updates every machine. Re-run `./setup` only after adding or
removing tools, or on a fresh machine. It is idempotent.

**This repo must live at a stable path** (symlinks point back into it). Keep it
at `~/projects/jstack`. Your dotfiles bootstrap is then just:

```sh
git clone <jstack-remote> ~/projects/jstack
~/projects/jstack/setup
```

## Vendor support

| Type     | Claude | Codex | OpenCode |
|----------|:------:|:-----:|:--------:|
| skills   |   ✅   |  ✅   |    ✅    |
| commands |   ✅   |  —    |    —     |
| agents   |   ✅   |  —    |    —     |

Skills are the portable backbone. Commands and agents are Claude-first today;
other vendors are wired for skills only and silently skip the rest. Add a vendor
by editing `lib/targets.sh` — nothing else changes.

## Adding a tool

1. Drop it in the right bundle: `general/skills/my-skill/SKILL.md`, or
   `general/commands/my-cmd.md`, or `general/agents/my-agent.md`.
2. `./setup` (or `./setup --dry-run` first).

Need a new bundle? Make a folder with a `skills/`, `commands/`, or `agents/`
subdir — `setup` discovers it automatically.
