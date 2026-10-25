# Ghostty

My [Ghostty](https://ghostty.org) configuration, in [`home/.config/ghostty/`](../home/.config/ghostty/). Every new window opens as a layout:

```
┌──────────────────────────────────────────────┐
│ btop (CPU only)                               │
├──────────────┬───────────────────────────────┤
│ viewer       │ [dir] 1:zsh 2:claude* 3:gad!  │ ← tmux tabs
│ files·diff·dv│ claude / shell                │
└──────────────┴───────────────────────────────┘
```

- **Top:** btop, showing only its CPU box. If btop isn't installed, htop runs instead.
- **Bottom right:** a tmux session with its tab bar at the top. Ghostty's tab keys drive tmux tabs.
- **Left:** opens with the window, in Files (the yazi file manager, which previews documents). Each Claude start or resume in the window points Files at that Claude's folder: straight away if Files is showing, otherwise the next time you switch to it. Tab switches it to Diagrams, the diagram viewer (`dv`), which shows the diagrams Claude draws. A header row shows both modes; click one to switch.
- **Diff:** a mode of the left pane, beside Files. It shows the uncommitted changes of the repository your active tmux tab is in, against the last commit (staged, unstaged and new files): a summary of what changed, a row per file with its added and removed lines, and one file open in place under its row with its diff. It checks git every second, so it empties once you commit.
- **Ping:** when Claude finishes or asks for permission in a tab you're not on, that tab turns red and a desktop notification names the tab and its project. The notification comes from jstack's `agent-notify.sh`.

The theme is Catppuccin Mocha.

## Install

The dotfiles' `./install.sh` sets it all up: `ghostty`, `tmux` and `btop` come from `apt-packages.txt`, yazi from `scripts/install_yazi.sh` (snap), and Node.js for Diff and Diagrams from `scripts/install_node.sh` (fnm). btop and yazi are optional, see above.

`./install.sh --links` symlinks each file in `home/.config/ghostty/` into `~/.config/ghostty/`, so edits here apply live. A file already in the way is moved to `.dotfiles-backup/`. Windows that are open during install keep their layout; new windows get the new one.

The Claude Code hooks live in jstack's `config/core/settings.json`:
- **SessionStart:** `bin/ghostty-claude-start` points the viewer at Claude's folder.
- **Stop** and the `permission_prompt` notification: `bin/ghostty-claude-ping` rings the tab's bell.

Diagrams come from jstack's diagram-pane mod, which renders each one to a PNG and writes each session's tabs to a file for its tmux pane, under `~/.cache/claude-diagram-pane/panes/`. `dv` shows the file of the window's active tab, and closes a diagram by rewriting it; the format is in the mod's README. A new Claude session starts with no diagrams, and a resumed one gets its own back.

## Keys

| Keys | Action |
|---|---|
| `ctrl+shift+t` | New tmux tab |
| `ctrl+shift+w` | Close tmux tab |
| `ctrl+tab` / `ctrl+shift+tab` | Next / previous tmux tab |
| `ctrl+shift+→` / `ctrl+shift+←` | Next / previous tmux tab |
| click `×` on a tab | Close that tab |
| `tab` in the viewer | Next mode: Diagrams → Files → Diff → Diagrams. Click the viewer first to focus it. |
| click `Diagrams` / `Files` / `Diff` in the viewer | Switch to that mode |
| `j` / `k` in Diff | Move between changed files |
| `enter` or click in Diff | Open that file's diff in place, or close it |
| `J` / `K`, `PgDn` / `PgUp`, scroll in Diff | Scroll (`g` / `G`: top / bottom) |
| click `×` on a diagram's tab | Close that diagram |
| `q` in dv | Close the viewer |
| `q` in yazi | Switch to Diagrams |
| `q` in Diff | Switch to Files |
| `ctrl+shift+n` (default) | New window with the layout |
| `shift`+drag | Select text with Ghostty instead of tmux |
| click a pane | Focus btop, the viewer or the tabs |

## How it works

Each window is one Ghostty split running two tmux servers, one inside the other:

- **The outer tmux** (`layout.conf`, socket `ghostty-layout`) lays the window out. It runs one session per window, with no status bar and no prefix key. Its panes are btop, the viewer and the tab session.
- **The tab session** (`tmux.conf`, socket `ghostty`) runs in the outer tmux's bottom-right pane and keeps your tabs. `prefix` keys reach it untouched, because the outer tmux has no prefix.

Ghostty's own splits can't do this layout. Its D-Bus actions can open splits but not size them, and a `global:` keybind acts on every split of every window, so a script can't resize one split without moving the others. tmux sizes panes exactly, in one step.

The scripts in `bin/`:

- **`ghostty-surface`** is Ghostty's `command`, so it runs in every new split. In the first split of a new window, it builds that window's outer session at the window's size, then attaches to it. Any other split gets your shell. It also runs the outer panes: `ghostty-surface top` runs btop and `ghostty-surface tabs` runs the tab session. `ghostty-surface viewer` opens the viewer once the new window is attached.
- **Keeping btop's height:** tmux shares a window resize out between the panes, so a `window-resized` hook puts btop back to `GHOSTTY_TOP_ROWS` after one. That includes the resize on attach, when KDE maximizes a new window while its layout is being built.
- **`ghostty-claude-start`** sends the viewer's yazi to Claude's folder with `ya emit-to` (yazi runs with a client id per window), and leaves the folder in a file that Files reads when it next starts. It never moves focus. If you closed the viewer, it opens a new one. It also saves where Node.js is, which Diff and Diagrams need and Ghostty's own PATH lacks. The viewer gets `DV_TABS` so Diagrams and Diff know which tab session to follow; `tmux.conf` touches `$XDG_RUNTIME_DIR/ghostty-layout/tab-changed` when the active tab changes, so both switch with it.
- **`ghostty-viewer`** runs the left pane's three modes in turn, starting with `yazi`: `yazi` (Files), `viewer/diff-view.mjs` (Diff) and `dv` (`viewer/diagram-view.mjs`, Diagrams). Diff and Diagrams exit with the code of the mode to show next (`GV_*_EXIT`, `DV_TAB_EXIT`, `DV_DIFF_EXIT`). `yazi` can't choose an exit code, so it says where to go by whether it writes its `--cwd-file`: Tab and the Diff tab do, `q` and the Diagrams tab don't. `yazi/init.lua` and `yazi/theme.toml` lay yazi out like the design: the mode header, a file list beside a wide preview, and a short status bar. `dv` draws images through tmux with kitty Unicode placeholders, so panning moves in whole cells.
- **Tab keys:** Ghostty sends them as escape codes, and the outer tmux runs the matching command in the tab session, whichever pane has focus.

New windows are told apart from splits you open yourself by their D-Bus window number, recorded in `$XDG_RUNTIME_DIR/ghostty-layout/<ghostty pid>/known`.

Settings you can change through the environment:
- `GHOSTTY_TOP_ROWS` (default 10): rows for btop.
- `GHOSTTY_VIEWER_SHARE` (default 40): the viewer's percent of the bottom row.

## Tests

`dv`'s zoom and pan math has tests. They use only Node's built-in test runner:

```bash
node --test home/.config/ghostty/viewer/view.test.mjs
```

## Limits

- **btop's pane** only displays. It ignores the mouse and never takes focus, so keys always go to the viewer or the tabs. If btop exits anyway, it starts again a second later.
- **Dividers:** the line under btop can't be dragged, so a drag that runs up over it doesn't resize btop. The divider beside the viewer still drags.
- **Right-click** goes to the program under the pointer; tmux's own pane menu is turned off.
- **When a window opens**, the viewer holds focus for about a second while yazi starts, then hands it back. yazi asks Ghostty about the terminal through tmux, and tmux gives the answers to whichever pane has focus; in Claude's pane one of them reads as Alt+P and opens the model picker. Keys typed in that second go to yazi. Starting Claude never moves focus, since yazi is already running.
- **Closing the last tab** closes the window.
- **Ghostty tabs:** tabs made from Ghostty's own tab button don't get the layout.
- **`shift`+drag** selects across the whole window, btop and viewer included, since Ghostty sees one split.
