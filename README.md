# dotfiles

Dotfiles + machine setup for a Linux (KDE) workstation. Everything under [`home/`](./home) mirrors
`$HOME` and is symlinked into place; system packages and programs are installed by separate scripts.

## Install

```bash
git clone https://github.com/juff17/dotfiles && cd dotfiles
./install.sh            # full bootstrap: system packages -> link dotfiles -> programs
./install.sh --links    # only (re)symlink dotfiles — no sudo/apt, no program installers
```

- **Per-file symlinks.** `home/` is a mirror of `$HOME`; the installer walks every file under it and
  links it to the same relative path. Per-file (not whole-dir) means multiple sources can share a
  directory — e.g. `~/.claude/commands/` holds our files *and* the `cg.md` that `context_groups` installs.
- **Conflicts are backed up, not clobbered.** Any existing file in the way is moved into
  `~/.dotfiles-backup/<timestamp>/` with its relative path preserved, then the symlink is created.
- **Idempotent.** Re-running reports `ok` for links already in place.
- Overrides: `DOTFILES_TARGET=/path` (link target, for a dry run) · `DOTFILES_BACKUP=/path` (backup root).

## Layout

| Path | What it is | Installed by |
|---|---|---|
| `home/` | `$HOME` mirror — dotfiles symlinked into place (`.zshrc`, `.config/…`, `.claude/…`) | `./install.sh` (symlink) |
| `scripts/` | System installers (apt packages, docker, postgres, python/uv, zsh, fonts, vscode, …) | `./install.sh` (full) |
| `context_groups/` | The `cg` CLI + `/cg` slash command — a program with its own installer | its `install.sh`, called by root |
| `orchestrator/` | Design docs for an agent-orchestrator effort — **not installed**, reference only | — |
| `apt-packages.txt` | Package list consumed by `scripts/install_apt_packages.sh` | — |

Add a new dotfile by dropping it at its mirrored path under `home/` (e.g. `home/.config/foo/bar.conf`)
and re-running `./install.sh --links`.

## Claude Code config (`home/.claude/`)
- `settings.json` — Opus, `cleanupPeriodDays` 90, and the SessionStart hook below.
- `hooks/gitignore-worktrees.sh` (SessionStart) — appends `.claude/worktrees/` + orchestration artifacts
  to each repo's `.git/info/exclude` (local, untracked, idempotent) so they never leak into a diff.
- `agents/`, `commands/`, `skills/` — kept as placeholders (the `.gitkeep` files are not symlinked).

## context_groups
`cg` manages named sets of directories ("context groups") for Claude Code sessions. Installs the CLI to
`~/.local/bin/cg` and the `/cg` command to `~/.claude/commands/cg.md`. See [`context_groups/README.md`](./context_groups/README.md).

## orchestrator (design only)
A separate, not-yet-built design for running many Claude Code agents over GitLab driven by Jira. Lives in
[`orchestrator/`](./orchestrator/) and is independent of the dotfiles. Start at
[`orchestrator/README.md`](./orchestrator/README.md).
