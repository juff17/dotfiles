# diagram-pane

Renders the Mermaid diagrams the agent draws (`mcp__diagram-pane__show`) to
PNGs and shows them beside the chat.

## Viewer

Diagrams can show in one of two places. Pick one with the `VIEWER` constant at
the top of `hooks/register.tsx`.

| `VIEWER`            | Where diagrams show                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `'ghostty'` (default) | dv, the diagram viewer in the left pane of the Ghostty layout. The in-chat pane never opens on its own. |
| `'claude'`          | The pane inside Claude Code, opened each time a diagram is drawn and on resume when tabs were saved.                  |

Both modes render every diagram. The tabs belong to the session that drew
them: a new session starts with none, `claude --resume` brings that session's
own back, and `/clear` starts over. The store keeps the 20 sessions used last.
`/diagram-pane` opens the in-chat pane in either mode.

dv lives in the dotfiles repo (`modules/ghostty/home/.config/ghostty/viewer/`), not here. The Ghostty pane is
started by `~/.config/ghostty/bin/ghostty-claude-start` (a `SessionStart`
hook) through `ghostty-viewer`, and shows the window's active tab. Outside that
layout, with `'ghostty'` set, nothing shows a diagram until you run
`/diagram-pane` or start dv yourself; it then shows the tabs written last:

```sh
node ~/.config/ghostty/viewer/diagram-view.mjs
```

## Pane files

dv reads only these, so they're the contract between the two repos. A session
running in tmux writes its tabs to
`$XDG_CACHE_HOME/claude-diagram-pane/panes/<socket>-<pane>.json` (default
`~/.cache/...`): `<socket>` is the tmux socket's name, `<pane>` the pane id
without its `%`, so `ghostty-12.json`. Each change rewrites it whole; the
session deletes it when it exits. Outside tmux, nothing is written.

```json
{
  "session": "6f1c2e…",
  "diagrams": [
    { "id": "1729800000000-ab12", "title": "Diagram pane flow", "file": "/home/you/.cache/claude-diagram-pane/1729800000000-ab12.png", "width": 1200, "height": 2000 }
  ],
  "current": 0
}
```

- `session`: the id of the session that wrote it.
- `diagrams`: the tabs in order. `file` is the PNG's absolute path; `width` and `height` are its size in pixels.
- `current`: the index of the tab Claude last drew or showed.

dv closes a tab by writing the file back without it. The mod can't watch the
file, so before each change it keeps only the tabs the file still lists, when
`session` is its own.

Changing these fields breaks dv; change
`modules/ghostty/home/.config/ghostty/viewer/diagram-view.mjs` in the dotfiles repo with them.

## Tests

```sh
claude plugin test .
```
