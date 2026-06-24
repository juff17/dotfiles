# Context Groups for Claude Code

Define named sets of directories once, then load them into Claude Code on demand — no
re-adding folders every session. One config (`~/.context-groups/groups.json`) drives the
`cg` CLI:

- **`cg`** — Claude Code: launch a session preloaded with the group, or switch live with `/cg`.

## Install

```bash
git clone <this-repo> context_groups && cd context_groups
./install.sh            # installs the cg CLI + /cg slash command
```

- Symlinks the CLI into `~/.local/bin` (idempotent; warns if it isn't on `$PATH`).
  Use `--copy` to copy instead of symlink.
- Uninstall: `rm ~/.local/bin/cg ~/.claude/commands/cg.md`.

### Repo layout

| Path | Installs to | Purpose |
|---|---|---|
| `install.sh` | — | root: run the Claude installer |
| `claude/bin/cg` | `~/.local/bin/cg` | Claude CLI |
| `claude/commands/cg.md` | `~/.claude/commands/cg.md` | the `/cg` slash command |
| `~/.context-groups/groups.json` | — | your groups (created on first use) |

The default install **symlinks**, so edits in the repo take effect immediately.

## Usage — Claude Code (`cg`)

```bash
cg create work ~/projects/api ~/projects/web   # define a group once
cg work                                        # launch Claude with the whole group loaded
cg list                                        # list groups
cg show work                                   # show a group's dirs
cg active                                      # what's loaded in this session
cg add work ~/projects/shared                  # add a dir
cg remove work ~/projects/web                  # drop a dir
cg rename work backend                         # rename
cg rm backend                                  # delete
cg init                                        # pre-trust + pre-seed every group's dirs
```

- `cg <name>` launches a session with every folder in the group already available.
  Pass extra Claude flags after `--`: `cg work -- --model opus`.
- **`/cg <group>`** (slash command, inside Claude) switches the active group live;
  **`/cg --active`** shows what's loaded.
- First launch in a repo is prompt-free — `cg` pre-accepts Claude's folder-trust dialog.

## Config

One file — edit it directly to bulk-manage groups:

```
~/.context-groups/groups.json
```

Group names can't collide with subcommands (`create`, `apply`, `init`, …).
