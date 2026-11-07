# Ghostty

My [Ghostty](https://ghostty.org) configuration, in [`modules/ghostty/home/.config/ghostty/`](../modules/ghostty/home/.config/ghostty/). Every new window opens as a layout:

```
┌────┬─────────────────────────────────────────┐
│work│ btop (CPU only)                          │
│hub●├──────────────┬──────────────────────────┤
│▲ 2 │ viewer       │ [dir] 1:zsh 2:claude ✻   │ ← tmux tabs
│✻ 3 │ files·diff·dv│ claude / shell           │
│+new│              │                          │
└────┴──────────────┴──────────────────────────┘
```

- **Top:** btop, showing only its CPU box. If btop isn't installed, htop runs instead.
- **Bottom right:** a tmux session with its tab bar at the top. Ghostty's tab keys drive tmux tabs.
- **Left:** opens with the window, in Files (the yazi file manager, which previews documents). Each Claude start or resume in the window points Files at that Claude's folder: straight away if Files is showing, otherwise the next time you switch to it. Tab switches it to Diagrams, the diagram viewer (`dv`), which shows the diagrams Claude draws. A header row shows both modes; click one to switch.
- **Todo:** a mode of the left pane, after Diff. It shows every repo's open todos grouped by category (bug, feature, follow-up, docs, question, other), with the active tab's repo first in each group. The selected one opens under its row: who added it, from which tab and branch, and its note. `enter` goes back to the tab that added it, even in another Ghostty window. If that tab is gone, a second `enter` opens a new tab in the item's worktree running `claude --resume` on the session that added it. Items come from the `/todo` skill, which has Claude run `bin/ghostty-todo` (Claude adds them only when you ask), or from `a` in the pane. Done items stay under "done today" and are dropped after a week. The list is one file, `~/.local/state/ghostty-layout/todos.json` (`$XDG_STATE_HOME`), so every window shows the same list. An item added outside a git repo shows `none` as its repo.
- **Diff:** a mode of the left pane, beside Files. It shows the uncommitted changes of the repository your active tmux tab is in, against the last commit (staged, unstaged and new files): a summary of what changed, a row per file with its added and removed lines, and one file open in place under its row with its diff. It checks git every second, so it empties once you commit.
- **Ping:** when Claude finishes or asks for permission in a tab you're not on, that tab turns red and a desktop notification names the tab and its project. The notification comes from jstack's `agent-notify.sh`.
- **Rail:** a strip down the far left. **work** and **hub** switch the window between this workspace and the agent hub, the counts under them are the agents that need you (▲), are working (✻), are done (✓) and are idle (○), and **+ new** starts an agent. The hub button gets an orange dot while anything needs you. A tab running Claude carries the same glyph in the tab bar.

## Agent hub

The hub is the window's second view (`Ctrl+Shift+A` or the rail's **hub**). It shows every Claude session on the machine, from every Ghostty window and the background (`claude --bg`):

- **Lanes** for task agents: **Needs you** (a permission prompt, a question, or a monitor that raised something), **Working** (with the command running now and for how long), **Done** (finished, and you haven't looked yet) and **Idle**. A lane that fills up keeps going: Needs you scrolls with a "▾ more" cue and never shrinks a card, Working drops to cards that show only the command, Done keeps its newest two as cards and folds the rest to a line each, and Idle is a line each. An empty lane says so (*Nothing needs you*, *Nothing working*, …). A tab that parked its conversation in a background job is one card with that job: its state comes from the job, and Enter and `o` go to the tab.
- **Monitors** in a tray below, which keeps room for five even when fewer run and grows to about a third of the screen when more do: each Monitor a session armed (pr-babysit's `watch_pr.py`, logger's `watch_logs.py`, or any other), with what it watches, its latest event and when it came. A monitor is *watching*, *needs action* (its last event was a failed, manual, stuck or conflicted job, an error or a crash, and you haven't seen it), *stale* (its command no longer runs) or *ended* (it expired, failed, or went with its session's last process when the session was resumed; it leaves after five minutes). One you stop, with `x` or by asking its agent, leaves at once. A session that's watching something stays in the strip; it shows in a lane only when it needs you. `x` on a monitor stops just that one: the hub ends the monitor's own process group, so the session and its other monitors keep running. Answering `a` to its question stops it without asking from then on; the choice is kept in `~/.local/state/agent-hub/prefs.json` (`$XDG_STATE_HOME`), so it lasts through restarts. Delete the `stop-monitor` entry there to be asked again.
- **Open a session:** Enter opens the agent's live session beside a list of the rest, and your keys go to it. A tab agent opens through its own grouped tmux session, so the workspace stays on the tab it was on; a background agent opens with `claude attach`. `Ctrl+Shift+B` closes it and goes back to the board. Switching tabs in it, from its tab bar or with the tab keys, switches only what that pane shows, and the list follows to the agent in the new tab.
- **Hub tabs:** the open session's tab bar has every workspace tab, plus the tabs opened from the hub. A tab you open there (`Ctrl+Shift+T`), or that New agent opens, is a hub tab: it shows in the hub and not in the workspace, and its card says *hub tab*. It goes the other way too: a tab you open in the workspace shows in the hub at once. A tab is still one tab in both places, so closing a workspace tab from the hub closes it in the workspace.
- **New agent** (`n`, or **+ new**): a task with a first prompt, run in a new hub tab or in the background, in its own worktree (`claude -w`, the default) or on the current branch; a PR babysitter (`/pr-babysit <link>`, in the background); or a log watcher (`/logger watch <source>`, in the background). Folder, model, permission mode and effort are fields of their own, starting at Opus, auto, medium for a task and Sonnet, auto, medium for a monitor; recent folders are one keypress away.
- A done agent counts as seen once you open it, mark it (`e`), or its tab is the one in front.

The hub needs no Claude Code hooks. It reads what Claude already writes: each running session's `~/.claude/sessions/<pid>.json` (its status, what it's waiting for, its tmux pane) and its transcript (the prompt, the tool running, the last reply, the context used, and every Monitor with the events it delivered).

The theme is Catppuccin Mocha.

## Agents widget

A Plasma panel widget puts the hub's agents beside the clock. It is the only alert: Claude sends no desktop pop-ups (jstack has no notification hook, and Ghostty's `desktop-notifications` is off):

- **In the panel:** a glyph and count per kind: ▲ needs you, ✗ broke (a monitor saw a failed job, an error, a crash or a conflict), ✻ working, ◉ watching (◌ gone quiet) and ✓ done; ○ when nothing runs. A new ▲ or ✗ fills it with its colour for two seconds, and a ring stays around it until you open the inbox.
- **The inbox** (click it, or the shortcut you give it): every item in those sections, needs-you first, each with its buttons. **Allow** and **Deny** answer a permission prompt, only while it's on screen, as in the hub; **Go** opens the agent's live session in the hub, beside the list of the rest, and brings Ghostty to the front (the workspace stays on its tab); **Open hub ↗** shows the hub. Keys: `j` / `k` move, `↵` goes, `1` / `2` press the first two buttons, `x` dismisses an item until it changes, `esc` closes. Done items fold into one line until shown, and leave once you open them.
- **Notes:** a session can post something only it knows needs you, a fix ready to push or a finished rebase, as a ▲ item: pr-babysit's `notify.sh` writes it to `$XDG_RUNTIME_DIR/agent-hub/notes/`. Go takes you to that session; Go or `x` clears it, and it's dropped after a day.
- It reads and acts through `ghostty-hub tray` (`hub/tray.mjs`), the same agents the hub shows, so handling an item in one clears it in the other. It keeps agentd running while it's in the panel.

## Install

`./install.sh ghostty` sets it all up: `ghostty`, `tmux` and `btop` from the module's `packages.txt`, yazi from its `install.sh` (snap), and Node.js for Diff and Diagrams from the `node` module (fnm), which it requires. btop and yazi are optional, see above.

`./install.sh --links ghostty` symlinks each file in `modules/ghostty/home/.config/ghostty/` into `~/.config/ghostty/`, so edits here apply live. A file already in the way is moved to `.dotfiles-backup/`. Windows that are open during install keep their layout (the module's `after-link.sh` records them); new windows get the new one.

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
| `tab` in the viewer | Next mode: Diagrams → Files → Diff → Todo → Diagrams. Click the viewer first to focus it. |
| click `Diagrams` / `Files` / `Diff` / `Todo` in the viewer | Switch to that mode |
| `j` / `k` in Diff | Move between changed files |
| `enter` or click in Diff | Open that file's diff in place, or close it |
| `J` / `K`, `PgDn` / `PgUp`, scroll in Diff | Scroll (`g` / `G`: top / bottom) |
| click `×` on a diagram's tab | Close that diagram |
| `q` in dv | Close the viewer |
| `q` in yazi | Switch to Diagrams |
| `q` in Diff | Switch to Files |
| `j` / `k`, scroll in Todo | Move between todos (`g` / `G`: first / last) |
| `enter` in Todo | Go to the tab that added it; a second `enter` reopens a closed one |
| `space` in Todo | Mark done, or reopen a done one |
| `a` / `e` / `c` / `x` in Todo | Add (then pick its category with `1`–`5`), edit the title, next category, delete (`x` twice) |
| `f` / `d` in Todo | This repo only or every repo / show what's done today |
| `q` in Todo | Switch to Files |
| `alt+t` anywhere in the window | Open the todo list in a popup over the workspace or the hub, with the same keys as Todo mode; `alt+t`, `esc` or `q` close it, and so does `enter` once it has gone to a tab. Claude's own `alt+t` (thinking on or off) is turned off. |
| `ctrl+shift+n` (default) | New window with the layout |
| `ctrl+shift+a`, or **work** / **hub** on the rail | Switch between the workspace and the agent hub |
| `alt+n` anywhere in the window, **+ new** on the rail, or `n` in the hub | New agent |
| `h` / `l`, `j` / `k` in the hub | Move between lanes and agents (`tab`: the monitors strip) |
| `enter` in the hub (a click only selects) | Open that agent's live session beside the list, with focus in it |
| `alt+s` in the hub | Swap focus between the list and the open session |
| `ctrl+shift+b` (or `ctrl+]` in the session) | Close the session the hub opened and go back to the board; in the workspace, go to the board |
| `a` / `d` in the hub | Allow or deny the selected permission prompt |
| `e` / `E` in the hub | Mark the selected done agent, or all of them, as seen |
| `o` in the hub | Go to the selected agent's tab; a hub tab opens beside the list, since the workspace doesn't have it |
| `x` in the hub | Close a done or idle agent's tab, and any monitors it still runs (asks first); for a tab parked on a background job, stop the job too (its conversation is kept); on a monitor, stop only that monitor (asks first, until you answer `a`: yes, don't ask again) |
| `/` in the hub | Filter agents by name, repo or command |
| `ctrl+s`, `esc` in New agent | Start, cancel (`↑`/`↓` fields, `←`/`→` choices, `tab` completes the folder) |
| `shift`+drag | Select text with Ghostty instead of tmux |
| click a pane | Focus btop, the viewer or the tabs |

## How it works

Each window is one Ghostty split running two tmux servers, one inside the other:

- **The outer tmux** (`layout.conf`, socket `ghostty-layout`) lays the window out. It runs one session per window, with no status bar and no prefix key. Its panes are btop, the viewer and the tab session.
- **The tab session** (`tmux.conf`, socket `ghostty`) runs in the outer tmux's bottom-right pane and keeps your tabs. `prefix` keys reach it untouched, because the outer tmux has no prefix.
- **The hub's tab session** (`hubtabs-<window>`, on the same server) is a detached session that `hub_tabs` in `ghostty-lib.sh` makes the first time the hub opens a tab or a session. It has every workspace tab linked in (`link-window`, and a `window-linked` hook for each new one), plus the hub tabs, which only it has. The session the hub opens is grouped with it rather than with the workspace's session, so a tab opened there lands here. It goes when the window closes.

Ghostty's own splits can't do this layout. Its D-Bus actions can open splits but not size them, and a `global:` keybind acts on every split of every window, so a script can't resize one split without moving the others. tmux sizes panes exactly, in one step.

The scripts in `bin/`:

- **`ghostty-surface`** is Ghostty's `command`, so it runs in every new split. In the first split of a new window, it builds that window's outer session at the window's size, then attaches to it. Any other split gets your shell. It also runs the outer panes: `ghostty-surface top` runs btop and `ghostty-surface tabs` runs the tab session. `ghostty-surface viewer` opens the viewer once the new window is attached.
- **Keeping btop's height:** tmux shares a window resize out between the panes, so a `window-resized` hook puts btop back to `GHOSTTY_TOP_ROWS` after one. That includes the resize on attach, when KDE maximizes a new window while its layout is being built.
- **`ghostty-claude-start`** sends the viewer's yazi to Claude's folder with `ya emit-to` (yazi runs with a client id per window), and leaves the folder in a file that Files reads when it next starts. It never moves focus. If you closed the viewer, it opens a new one. It also saves where Node.js is, which Diff, Todo and Diagrams need and Ghostty's own PATH lacks. The viewer gets `DV_TABS` so Diagrams, Diff and Todo know which tab session to follow; `tmux.conf` touches `$XDG_RUNTIME_DIR/ghostty-layout/tab-changed` when the active tab changes, so they switch with it.
- **`ghostty-viewer`** runs the left pane's four modes in turn, starting with `yazi`: `yazi` (Files), `viewer/diff-view.mjs` (Diff), `viewer/todo-view.mjs` (Todo) and `dv` (`viewer/diagram-view.mjs`, Diagrams). Diff, Todo and Diagrams exit with the code of the mode to show next (`GV_*_EXIT`, `TD_*_EXIT`, `DV_TAB_EXIT`, `DV_DIFF_EXIT`, `DV_TODO_EXIT`). `yazi` can't choose an exit code, so it says where to go by whether it writes its `--cwd-file`: Tab and the Diff and Todo tabs do, `q` and the Diagrams tab don't. The Todo tab also creates the file `GV_TODO_MARK` names first. `yazi/init.lua` and `yazi/theme.toml` lay yazi out like the design: the mode header, a file list beside a wide preview, and a short status bar. `dv` draws images through tmux with kitty Unicode placeholders, so panning moves in whole cells.
- **`ghostty-todo`** is the todo list's command line: `add`, `list`, `done`, `undo`, `edit` and `rm` (`ghostty-todo help`). `add` records the repo (the main checkout, so a worktree's items count as its repo's), the branch and worktree, the tab's tmux pane, and the Claude session it runs under, found from its parent processes. It records only the pane, since a window shows in the hub's sessions too; Todo looks up the window's own session when it goes there. `viewer/todo.mjs` holds the store both share. Each write takes a lock folder beside the file and replaces the file whole.
- **`ghostty-todo-panel`** runs in `alt+t`'s popup (`display-popup` in `layout.conf`). It reads the window from the client's session, so the list follows that window's tab session, and runs `viewer/todo-view.mjs` with `TD_POPUP=1`: no mode header, and keys that close the popup instead of switching modes. Inside a popup tmux's own bindings don't apply, so the list itself reads `alt+t` as close.
- **Tab keys:** Ghostty sends them as escape codes, and the outer tmux runs the matching command in the tab session, whichever pane has focus; in a session the hub opened, they act on that pane's own session (`peek-<pane number>`) instead, so a new tab there is a hub tab. `Ctrl+Shift+A` is one of them too, and switches the outer session's window.
- **The hub's windows:** `add_hub` in `ghostty-lib.sh` gives each outer session a second window, `hub`, and a rail (`hub/rail.mjs`) down the left of both. Clicks on a rail pass through to it without selecting its pane, and it never keeps focus, like btop. It puts its own width back after a resize. `ghostty-hub setup` adds the rail and the hub to a window opened before they existed.
- **`hub/agentd.mjs`** is the one process that watches the sessions, so every rail and hub together cost one. Once a second it reads the session files, the new lines of each transcript and the tab server's panes, writes `$XDG_RUNTIME_DIR/agent-hub/state.json`, and sets each Claude tab's `@agent` glyph, which `tmux.conf` draws. The hub and the rails start it when it isn't running and register in `clients/`; it exits a little after the last of them. `hub/model.mjs` holds the logic that turns a session into a card, and `hub/hub.mjs` and `hub/rail.mjs` draw.

New windows are told apart from splits you open yourself by their D-Bus window number, recorded in `$XDG_RUNTIME_DIR/ghostty-layout/<ghostty pid>/known`.

Settings you can change through the environment:
- `GHOSTTY_TOP_ROWS` (default 10): rows for btop.
- `GHOSTTY_VIEWER_SHARE` (default 40): the viewer's percent of the bottom row.
- `GHOSTTY_RAIL` (default 1): `0` leaves out the rail and the hub.
- `GHOSTTY_RAIL_COLS` (default 6): the rail's width.

### The Agents widget

`./install.sh --links ghostty` links the widget's folder, `modules/ghostty/plasmoid/dev.dotfiles.agents/`, to `~/.local/share/plasma/plasmoids/dev.dotfiles.agents` as one link (the module's `after-link.sh`). It isn't under `home/` because Plasma refuses a widget whose files are links that lead outside its folder. Check that Plasma sees it:

```bash
kpackagetool6 --type Plasma/Applet --show dev.dotfiles.agents
```

Then put it in the panel, once:

1. Right-click an empty part of the panel and choose **Add Widgets…**. A sidebar of widgets opens.
2. Type **Agents** in its search box.
3. Drag the **Agents** card onto the panel, left of the system tray, and let go. It shows as a small dark chip: `✻2` with two agents working, `○` with none.
4. Give it its shortcut: right-click the chip, **Configure Agents…**, **Keyboard Shortcuts**, set **Meta+A** (the inbox's header names it). Set it there rather than over D-Bus, which can crash KWin.

Plasma loads the widget's files when its panel starts, so after changing them, or if Agents isn't in the widget list yet, restart the panel: `systemctl --user restart plasma-plasmashell` (windows stay open).

If the chip shows **"Sorry! There was an error loading dev.dotfiles.agents … package does not exist"**, the folder isn't one link: `ls -la ~/.local/share/plasma/plasmoids/` should show `dev.dotfiles.agents -> …/modules/ghostty/plasmoid/dev.dotfiles.agents`. Run `./install.sh --links ghostty` to fix it, then restart the panel as above.

## Tests

`dv`'s zoom and pan math, the todo store (categories, grouping, pruning, writes), the agent hub's model (reading transcripts and monitor events, sorting agents into lanes, fitting a full lane, the commands a new agent runs) and the Agents widget's items (sections, what's new, dismissing) have tests. They use only Node's built-in test runner:

```bash
node --test modules/ghostty/home/.config/ghostty/viewer/view.test.mjs modules/ghostty/home/.config/ghostty/viewer/todo.test.mjs modules/ghostty/home/.config/ghostty/hub/hub.test.mjs modules/ghostty/home/.config/ghostty/hub/tray.test.mjs
```

## Limits

- **btop's pane** only displays. It ignores the mouse and never takes focus, so keys always go to the viewer or the tabs. If btop exits anyway, it starts again a second later.
- **Dividers:** the line under btop can't be dragged, so a drag that runs up over it doesn't resize btop. The divider beside the viewer still drags.
- **Right-click** goes to the program under the pointer; tmux's own pane menu is turned off.
- **When a window opens**, the viewer holds focus for about a second while yazi starts, then hands it back. yazi asks Ghostty about the terminal through tmux, and tmux gives the answers to whichever pane has focus; in Claude's pane one of them reads as Alt+P and opens the model picker. Keys typed in that second go to yazi. Starting Claude never moves focus, since yazi is already running.
- **Closing the last tab** closes the window. Only workspace tabs count: closing the last one also closes the window's hub tabs and whatever runs in them.
- **Ghostty tabs:** tabs made from Ghostty's own tab button don't get the layout.
- **Answering from the hub** (`a` / `d`) works for tab agents, and only while the prompt is on screen. A background agent's prompt is answered in its session (Enter). The same goes for Allow and Deny in the Agents widget.
- **Go in the Agents widget** brings the first Ghostty window to the front. With several layout windows open, the agent still opens in the right window's hub, but it may be another window that comes forward.
- **Sessions outside the layout** (Claude in another terminal or another tmux) show on the hub, but can't be opened from it.
- **An open session resizes its tab** to the hub's pane, the way two tmux clients on one window do; it goes back when you're in the workspace again.
- **`shift`+drag** selects across the whole window, btop and viewer included, since Ghostty sees one split.
