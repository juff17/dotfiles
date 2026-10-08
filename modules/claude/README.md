# jstack

Personal home for coding-agent tooling — skills, slash commands, and subagents —
organized by **category** and installed onto any machine with one command.

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
  skills/
    <category>/<name>/SKILL.md
  commands/
    <category>/<name>.md
  agents/
    <category>/<name>.md
```

Tools are grouped by type first, then by **category**: `docify` (document
writing), `review`, `daily-prep` (slack digest, standup prep), `general`, and
`shortcuts` (short-circuit guidance prompts). A category is a
source-organization and install-selection concept only — at install time skills
and agents flatten into the agent's own directories, so **their names must be
globally unique across categories.** Commands are the exception: they are
namespaced by category, so `commands/shortcuts/discuss.md` installs as
`/shortcuts:discuss`.

## Install

```sh
./setup                   # every category into every detected agent
./setup --host claude     # only Claude Code
./setup --category docify # only the docify category
./setup --dry-run         # show what would happen, change nothing
./setup --uninstall       # remove everything jstack installed
./setup --copy            # copy instead of symlink (Windows / forced)
./setup --force           # also replace items jstack did not install
```

Setup only replaces or removes what it installed (a symlink into this repo, or
a copy recorded in the git-ignored `.installed` file). If something else
already has a tool's name, setup skips it with a warning. Installs whose
source was renamed or deleted are removed on each run.

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

1. Drop it under its type and category: `skills/general/my-skill/SKILL.md`,
   `commands/general/my-cmd.md`, or `agents/general/my-agent.md`.
2. `./setup` (or `./setup --dry-run` first).

Need a new category? Make a folder under `skills/`, `commands/`, or `agents/` —
`setup` discovers it automatically.
