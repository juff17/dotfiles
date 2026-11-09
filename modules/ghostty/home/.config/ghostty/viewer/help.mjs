// The keys Alt+H shows (viewer/help-view.mjs), one section per feature, as
// the Keys table in docs/ghostty.md lists them. rare marks the ones that are
// easy to forget, which the view draws in peach. Change a key here and in the
// docs together.

export const SECTIONS = [
  {
    id: 'any',
    name: 'Anywhere',
    color: '#89b4fa',
    where: 'the workspace, the hub, or a session it opened',
    keys: [
      ['alt+h', 'This help'],
      ['alt+t', 'Todo list in a popup'],
      ['alt+s', 'Settings'],
      ['alt+d', 'Diagrams of the active tab, open session or selected card'],
      ['alt+n', 'New agent'],
      ['alt+e', "Open the current tab's repo or worktree in your editor (Settings › Editor)"],
      ['ctrl+shift+a', 'Switch between the workspace and the hub'],
      ['ctrl+shift+b', 'Back to the board (closes the session the hub opened)', true],
      ['ctrl+shift+n', 'New window with the layout'],
      ['shift+drag', 'Select text with Ghostty instead of tmux', true],
    ],
  },
  {
    id: 'tabs',
    name: 'Tabs',
    color: '#a6e3a1',
    where: 'the tmux tab bar',
    keys: [
      ['ctrl+shift+t', 'New tab'],
      ['ctrl+shift+w', 'Close tab'],
      ['ctrl+tab', 'Next tab'],
      ['ctrl+shift+tab', 'Previous tab'],
      ['ctrl+shift+→ / ←', 'Next / previous tab'],
      ['ctrl+shift+pgup', 'Move this tab left', true],
      ['ctrl+shift+pgdn', 'Move this tab right', true],
      ['click ×', 'Close that tab'],
    ],
  },
  {
    id: 'viewer',
    name: 'Viewer pane',
    color: '#94e2d5',
    where: 'the left pane: Diagrams, Files, Diff, Todo',
    keys: [
      ['tab', 'Next mode (click the viewer first to focus it)'],
      ['click a mode', 'Switch to that mode'],
      ['q in Files', 'Go to Diagrams', true],
    ],
  },
  {
    id: 'diff',
    name: 'Diff',
    color: '#f9e2af',
    where: 'uncommitted changes of the active tab’s repo',
    keys: [
      ['j / k', 'Move between changed files'],
      ['↵ or click', 'Open that file’s diff in place, or close it'],
      ['J / K  pgdn / pgup', 'Scroll'],
      ['g / G', 'Top / bottom'],
      ['q', 'Back to Files'],
    ],
  },
  {
    id: 'dv',
    name: 'Diagrams',
    color: '#89dceb',
    where: 'dv, in the pane or the Alt+D window',
    keys: [
      ['[ / ]', 'Previous / next diagram'],
      ['1–9 or click a chip', 'Jump to that diagram'],
      ['scroll  + / -', 'Zoom'],
      ['drag  h j k l', 'Pan'],
      ['0', 'Fit the diagram again', true],
      ['x or click ×', 'Close that diagram'],
      ['esc  alt+d', 'Close the Alt+D window'],
    ],
  },
  {
    id: 'todo',
    name: 'Todo',
    color: '#cba6f7',
    where: 'the Todo mode and the Alt+T popup',
    keys: [
      ['j / k  g / G', 'Move, first / last'],
      ['↵', 'Open its agent in the hub, or go to the tab that added it'],
      ['↵ ↵', 'Reopen its tab with claude --resume when it’s closed', true],
      ['space', 'Mark done, or reopen'],
      ['a', 'Add with Claude: describe it and Haiku files it'],
      ['shift+a', 'Add by hand: title, category 1–6, then a note'],
      ['r', 'Retry a filing Claude couldn’t finish', true],
      ['e', 'Edit: title, category, type, directory and note in one form; tab moves, ↵ saves'],
      ['c', 'Next category', true],
      ['m  shift+m', 'Mark for hand-off, clear the marks'],
      ['w', 'Hand the marked todos, or this one, to agents: t tab or background, b worktree or branch, m model', true],
      ['x x', 'Delete, or drop a filing (press twice)', true],
      ['f', 'This repo only / every repo', true],
      ['d', 'Show what’s done today', true],
      ['q  esc', 'Close (Files, in the pane)'],
    ],
  },
  {
    id: 'hub',
    name: 'Hub',
    color: '#fab387',
    where: 'the board and the session beside it',
    keys: [
      ['h / l  j / k', 'Move between lanes and agents'],
      ['tab', 'The monitors strip', true],
      ['↵', 'Open the agent’s live session beside the list'],
      ['alt+w', 'Swap focus between the list and the session', true],
      ['ctrl+]', 'Close the session, back to the board', true],
      ['a / d', 'Allow / deny the permission prompt'],
      ['e / E', 'Mark the done agent seen / all of them', true],
      ['o', 'Go to the agent’s tab'],
      ['x  ctrl+x', 'Close its tab, or stop a monitor (asks first)'],
      ['/', 'Filter by name, repo or command'],
      ['n', 'New agent'],
    ],
  },
  {
    id: 'new',
    name: 'New agent',
    color: '#f5c2e7',
    where: 'alt+n, + new on the rail, or n in the hub',
    keys: [
      ['↑ / ↓', 'Move between fields'],
      ['← / →', 'Change a choice'],
      ['tab', 'Complete the folder', true],
      ['ctrl+s', 'Start'],
      ['esc', 'Cancel'],
    ],
  },
  {
    id: 'set',
    name: 'Settings',
    color: '#94e2d5',
    where: '⚙ set on the rail',
    keys: [
      ['↑ / ↓', 'Move between settings'],
      ['tab / shift+tab', 'Next / previous section'],
      ['← / →', 'Change a setting'],
      ['space', 'Turn on or off, or the next choice'],
      ['r', 'Put a setting back to its default', true],
      ['esc or alt+s', 'Close'],
    ],
  },
].map(s => ({ ...s, keys: s.keys.map(([key, what, rare = false]) => ({ key, what, rare })) }))

// The section Alt+H opens on: the one for the tmux window it was pressed in.
const PLACES = { hub: 'hub', diagrams: 'dv' }
export const startAt = place => Math.max(0, SECTIONS.findIndex(s => s.id === (PLACES[place] ?? 'any')))

// The sections with only the keys that match every word of query, in a key,
// what it does, or the section's name; sections left empty are dropped.
export function filter(query, sections = SECTIONS) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return sections
  return sections
    .map(s => ({
      ...s,
      keys: s.keys.filter(k => {
        const text = `${k.key} ${k.what} ${s.name}`.toLowerCase()
        return words.every(w => text.includes(w))
      }),
    }))
    .filter(s => s.keys.length)
}
