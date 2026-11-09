# dotfiles

Dotfiles + machine setup for a Linux (KDE) workstation, split into modules under [`modules/`](./modules).
Each module is one part of the setup, so you can install any part without taking everything.

## Install

```bash
git clone https://github.com/juff17/dotfiles && cd dotfiles
./install.sh                     # every module
./install.sh ghostty shell       # just these, plus the modules they require
./install.sh --links [module...] # only (re)symlink files: no sudo/apt, no installers
./install.sh --list              # show the modules and what each one has
```

## Modules

| Module | What it sets up |
|---|---|
| `kde` | `kubuntu-desktop` (SDDM preselected), KDE colors/icons and global shortcuts |
| `base` | apt packages for every machine: fzf, ripgrep, psql, build toolchain, zram, cpufreq, duperemove |
| `shell` | zsh, Oh My Zsh, Powerlevel10k, JetBrains Mono Nerd Font; `.zshrc`, `.p10k.zsh`, `z.sh` |
| `fonts` | JetBrains Mono, Noto, Microsoft core fonts |
| `node` | fnm + Node.js LTS |
| `dev` | Docker, uv |
| `ghostty` | Ghostty, tmux, btop, yazi and the layout config (requires `node`), see [`docs/ghostty.md`](./docs/ghostty.md) |
| `dolphin` | Dolphin settings, Filelight |
| `claude` | Claude Code, plus its settings, hooks, skills, commands and mods (see [`modules/claude`](./modules/claude/README.md)) |

A full install runs them in that order. `kde` goes first because `base` leaves out what
`kubuntu-desktop` already pulls in (curl, vim, htop, unzip, dolphin, ark, ...).

A module folder can have any of:

| File | Used for |
|---|---|
| `packages.txt` | apt packages, one per line (`#` comments allowed) |
| `install.sh` | other install steps: snaps, curl installers, debconf answers |
| `home/` | files symlinked into `$HOME` at the same relative path |
| `after-link.sh` | runs after `home/` is linked, also with `--links` |
| `requires` | modules to install first, one per line |

Each module runs its packages, then `install.sh`, then links `home/`. Install steps skip what's already
installed, so re-running is safe.

To add a dotfile, drop it at its mirrored path under a module's `home/` (e.g.
`modules/kde/home/.config/foo/bar.conf`) and re-run `./install.sh --links`. To add a module, create a
folder under `modules/` and add it to `ORDER` in `install.sh`.

## Linking

- **Per-file symlinks.** Every file under a module's `home/` is linked to the same path under `$HOME`.
  Per-file (not whole-dir) means several modules can share a directory such as `~/.config/`.
- **Conflicts are backed up, not clobbered.** A file in the way is moved into
  `.dotfiles-backup/<timestamp>/` in the repo (gitignored) with its relative path kept. A link left
  from an older layout of this repo is replaced without a backup.
- **Idempotent.** Re-running reports `ok` for links already in place.
- Overrides: `DOTFILES_TARGET=/path` (link target, for a dry run) · `DOTFILES_BACKUP=/path` (backup root).

## Claude Code config
The `claude` module installs Claude Code itself (native installer, skipped if already present), then runs
its own `setup`, which links the module's settings, hooks, skills, commands, agents and mods into
`~/.claude/` and installs the plugins they name. It has its own linker rather than a `home/` folder
because skills and commands are grouped by category in the repo but flat (or namespaced) once installed.
See [modules/claude/README.md](modules/claude/README.md). Run it from the main checkout, not a worktree.
MCP connectors (Atlassian, Figma, Slack, Elastic, Linear) are added by hand once per machine; see
[Connectors](modules/claude/README.md#connectors) for which skills need them and the commands.
Claude Code sends no desktop notifications: what needs you shows in the Agents panel widget from the
`ghostty` module (see [docs/ghostty.md](docs/ghostty.md#agents-widget)).

## Tests

Run every suite before committing a change, agents included:

```bash
./test.sh                # every suite
./test.sh ghostty        # one or more of: ghostty, claude, mods
```

| Suite | Covers | Runner |
|---|---|---|
| `ghostty` | the agent hub and `agentd`, the Agents widget, and the logic of every viewer (`dv`, todo, diff, diagrams, help) | `node --test`, nothing to install |
| `claude` | the claude module's skill and hook scripts | Python's `unittest`, nothing to install |
| `mods` | Claude Code mods with a `hooks/*.test.tsx` | `claude plugin test`, skipped when `claude` isn't installed |

Tests sit next to the code they test: `*.test.mjs` beside the ghostty module's `.mjs` files,
`modules/claude/tests/test_<tool>.py`, and each mod's `hooks/*.test.tsx`. A new test file in one of
those places is picked up without changing `test.sh`. When you change a behaviour, add or update the
test that pins it in the same commit. See [docs/ghostty.md](docs/ghostty.md#tests) and
[modules/claude/README.md](modules/claude/README.md#tests) for what each suite covers.

## Pre-commit

[pre-commit](https://pre-commit.com) lints the staged files, then runs the test suite for each part
they touch. Set it up once per clone:

```bash
uv tool install pre-commit
pre-commit install
pre-commit run --all-files   # every hook on every file, by hand
```

| Hook | Checks | Config |
|---|---|---|
| `pre-commit-hooks` | JSON, YAML and TOML parse; no merge markers, private keys or large files; trailing whitespace and final newlines (fixed in place) | |
| `ruff check` | Python | [`ruff.toml`](ruff.toml) |
| `shellcheck` | shell scripts, warnings and errors only | [`.shellcheckrc`](.shellcheckrc) |
| `biome lint` | JS and TS, safe fixes applied in place | [`biome.json`](biome.json) |
| `tests (ghostty / claude / mods)` | `./test.sh <suite>`, only when a file that suite covers is staged | |

The linter configs leave out rules the existing code breaks on purpose; each config says why.
`z.sh` (upstream) and `.p10k.zsh` (generated) are skipped. CI runs the same lint hooks in its `lint`
job, and the tests in their own jobs.

## Machine-local shell settings
`.zshrc` sources `~/.zshrc.local` last if it exists. Put anything specific to one machine there (CA bundle
overrides, tokens, work-only settings); it isn't tracked here.
