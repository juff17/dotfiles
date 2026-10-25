# dotfiles

Dotfiles + machine setup for a Linux (KDE) workstation. Everything under [`home/`](./home) mirrors
`$HOME` and is symlinked into place; system packages and programs are installed by separate scripts.

## Install

```bash
git clone https://github.com/juff17/dotfiles && cd dotfiles
./install.sh            # full bootstrap: system packages -> system installers -> link dotfiles
./install.sh --links    # only (re)symlink dotfiles — no sudo/apt, no installers
```

- **Per-file symlinks.** `home/` is a mirror of `$HOME`; the installer walks every file under it and
  links it to the same relative path. Per-file (not whole-dir) means multiple sources can share a
  directory — e.g. `~/.config/` holds our files alongside everything else that lives there.
- **Conflicts are backed up, not clobbered.** Any existing file in the way is moved into
  `.dotfiles-backup/<timestamp>/` in the repo (gitignored) with its relative path preserved, then the symlink is created.
- **Idempotent.** Re-running reports `ok` for links already in place.
- Overrides: `DOTFILES_TARGET=/path` (link target, for a dry run) · `DOTFILES_BACKUP=/path` (backup root).

## Layout

| Path | What it is | Installed by |
|---|---|---|
| `home/` | `$HOME` mirror — dotfiles symlinked into place (`.zshrc`, `.config/…`) | `./install.sh` (symlink) |
| `scripts/` | System installers (apt packages, docker, postgres, python/uv, zsh + p10k, fonts, vscode, …) | `./install.sh` (full) |
| `apt-packages.txt` | Package list consumed by `scripts/install_apt_packages.sh` | — |

Add a new dotfile by dropping it at its mirrored path under `home/` (e.g. `home/.config/foo/bar.conf`)
and re-running `./install.sh --links`.

## Claude Code config
Claude Code settings, hooks, skills, commands and agents live in [jstack](https://github.com/juff17/jstack),
not here. Clone it and run its `./setup`. Its desktop notifications use the icon and `claude-code` desktop
entry under `home/.local/share/`, which also list Claude Code in System Settings > Notifications.

## Machine-local shell settings
`.zshrc` sources `~/.zshrc.local` last if it exists. Put anything specific to one machine there (CA bundle
overrides, aliases into other repos); it isn't tracked here.

## Other configs
Ghostty, tmux, btop and yazi configs live in the `ghosty-config` repo, not here.
