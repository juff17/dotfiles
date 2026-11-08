// The Todo mode's decisions, apart from the terminal: which key does what,
// where the cursor goes, how the prompts and the edit form take keys, what
// the hand-off row offers and says, and where ↵ goes. todo-view.mjs holds
// the state and does the drawing and the tmux and store calls; everything
// here takes what it needs as arguments, so it loads without a terminal and
// the tests can drive it.

import { existsSync } from 'node:fs'

import { CATEGORIES, DEFAULT_CATEGORY, HANDOFF_MODELS, TYPES, filingState, handoffPlace, inGit } from './todo.mjs'

export const tidy = text => String(text).replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '')
export const fit = (text, w) => {
  const chars = [...tidy(text)]
  return chars.length > w ? `${chars.slice(0, Math.max(0, w - 1)).join('')}…` : chars.join('') + ' '.repeat(w - chars.length)
}
export const wrap = (text, w) =>
  String(text)
    .split('\n')
    .flatMap(para => {
      const lines = []
      let line = ''
      for (const word of tidy(para).split(' ')) {
        if (line && [...line].length + 1 + [...word].length > w) {
          lines.push(line)
          line = word
        } else line = line ? `${line} ${word}` : word
        while ([...line].length > w) {
          lines.push([...line].slice(0, w).join(''))
          line = [...line].slice(w).join('')
        }
      }
      return [...lines, line]
    })

export const visible = text => [...text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length

export const shellQuote = text => text.replace(/[^\w./-]/g, '\\$&')

// What each key does with no prompt open, by name; todo-view.mjs maps the
// names to what it runs.
export const KEYS = {
  q: 'quit',
  '\x03': 'quit',
  '\x1b': 'close',
  '\x1bt': 'close',
  '\t': 'next-mode',
  j: 'down',
  k: 'up',
  '\x1b[B': 'down',
  '\x1b[A': 'up',
  '\x04': 'page-down',
  '\x15': 'page-up',
  '\x1b[6~': 'page-down',
  '\x1b[5~': 'page-up',
  g: 'first',
  G: 'last',
  '\r': 'go',
  ' ': 'done',
  a: 'claude',
  A: 'manual',
  r: 'retry',
  e: 'edit',
  c: 'category',
  t: 'type',
  x: 'delete',
  m: 'mark',
  M: 'clear-marks',
  w: 'handoff',
  f: 'only',
  d: 'show-done',
}

// Mouse reports, other escape sequences, Alt+letter, then single keys.
export const INPUT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[^a-zA-Z~]*[a-zA-Z~]|\x1b[a-zA-Z]|[\s\S]/gu

// What came in, split into mouse reports and keys, in order.
export function parseInput(text) {
  const events = []
  for (const m of text.matchAll(INPUT)) {
    if (m[1] !== undefined) events.push({ mouse: { button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), released: m[4] === 'm' } })
    else events.push({ key: m[0] })
  }
  return events
}

// The list as the cursor walks it: what arrange() returns, flattened in order.
export function selectable(view, showDone) {
  const list = [...view.filing, ...view.groups.flatMap(g => g.items)]
  return showDone ? [...list, ...view.doneToday] : list
}

export function cursorItem(list, cursorId) {
  return list.find(i => i.id === cursorId) ?? list[0]
}

// The id the cursor lands on, `by` items on; ±Infinity goes to the first or
// last. Undefined on an empty list.
export function moveTo(list, cursorId, by) {
  if (!list.length) return undefined
  const at = Math.max(0, list.indexOf(cursorItem(list, cursorId)))
  return list[Math.max(0, Math.min(list.length - 1, at + by))]?.id ?? list[by < 0 ? 0 : list.length - 1].id
}

// Where the cursor goes when the item leaves the list: the one after it, or
// before it at the end.
export const neighbour = (list, item) => list[list.indexOf(item) + 1] ?? list[list.indexOf(item) - 1]

// Marks only hold open, real items still in the list.
export function pruneMarks(marked, list) {
  for (const id of marked) if (!list.some(i => i.id === id && !i.done && !i.filing)) marked.delete(id)
  return marked
}

export const nextCategory = cat => CATEGORIES[(CATEGORIES.findIndex(c => c.name === cat) + 1) % CATEGORIES.length].name

// Through each type, then none, then round again.
export function nextType(type) {
  const at = TYPES.findIndex(t => t.name === type)
  return at === TYPES.length - 1 ? null : TYPES[at + 1].name
}

// Why the item under the cursor can't be changed yet, when Claude is still filing it.
export const filingHint = item =>
  filingState(item) === 'failed' ? 'r retries it, Shift+A adds it by hand, x drops it' : 'Claude is still filing this; x drops it'

// Keeps the selected item's whole card in view, its row first.
export function scrollTo(rows, current, scroll, height) {
  // With nothing selected, rows without an item (headers, and past the end)
  // would all match it.
  const first = current ? rows.findIndex(r => r.item === current) : -1
  let last = first
  while (first >= 0 && rows[last + 1]?.item === current) last++
  if (first >= 0) {
    if (last >= scroll + height) scroll = last - height + 1
    if (first < scroll) scroll = first
  }
  return Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)))
}

export function emptyLines({ loadError, only, repo }) {
  return loadError
    ? [loadError]
    : only
      ? [`No open todos in ${repo || 'this repo'}.`, 'f shows every repo.']
      : ['No todos yet.', 'Press a to have Claude add one, or Shift+A to add one by hand.']
}

// The status row's keys when nothing is open, and where the cursor is.
export const statusPairs = (marks, only) =>
  marks
    ? [['w', 'hand off'], ['m', 'mark'], ['shift+m', 'clear'], ['space', 'done']]
    : [['space', 'done'], ['a', 'add'], ['shift+a', 'by hand'], ['m', 'mark'], ['w', 'hand off'], ['f', only ? 'all repos' : 'this repo']]
export const position = (list, current, marks) =>
  list.length ? `${marks ? `${marks} marked · ` : ''}${list.indexOf(current) + 1}/${list.length} ` : ''

export const FIELDS = ['title', 'cat', 'note']
// Adding by hand skips the type, since t sets it after; the edit form has it.
export const EDIT_FIELDS = ['title', 'cat', 'type', 'note']
export const FIELD_NAMES = { title: 'title', cat: 'category', type: 'type', note: 'note' }

// A line being typed, after one key: backspace, Ctrl+U clears, Ctrl+W
// drops the last word, and any other printable key goes on the end.
export function editText(text, key) {
  if (key === '\x7f' || key === '\b') return [...text].slice(0, -1).join('')
  if (key === '\x15') return ''
  if (key === '\x17') return text.replace(/\S*\s*$/, '')
  if (!key.startsWith('\x1b') && key >= ' ') return text + key
  return text
}

// On a filing that failed, starts from its message and replaces it.
export const manualPrompt = item =>
  filingState(item ?? {}) === 'failed' ? { kind: 'title', text: item.title, replaces: item.id } : { kind: 'title', text: '' }

export const editPrompt = item => ({ kind: 'edit', id: item.id, field: 'title', title: item.title, cat: item.cat, type: item.type ?? null, note: item.note ?? '' })

// Every key in the edit form but ↵, which saves (editChanges): tab and the
// arrows move between fields, the category and type take their pick, and the
// title and note take text. Changes the prompt in place.
export function editKey(prompt, key) {
  const at = EDIT_FIELDS.indexOf(prompt.field)
  if (key === '\t' || key === '\x1b[B') prompt.field = EDIT_FIELDS[(at + 1) % EDIT_FIELDS.length]
  else if (key === '\x1b[Z' || key === '\x1b[A') prompt.field = EDIT_FIELDS[(at + EDIT_FIELDS.length - 1) % EDIT_FIELDS.length]
  else if (prompt.field === 'cat') {
    const i = CATEGORIES.findIndex(c => c.name === prompt.cat)
    const step = { '\x1b[C': 1, ' ': 1, '\x1b[D': CATEGORIES.length - 1 }[key]
    if (step) prompt.cat = CATEGORIES[(i + step) % CATEGORIES.length].name
    else if (CATEGORIES[Number(key) - 1]) prompt.cat = CATEGORIES[Number(key) - 1].name
  } else if (prompt.field === 'type') {
    // The types, then none, as one ring.
    const ring = [...TYPES.map(t => t.name), null]
    const i = ring.indexOf(prompt.type)
    const step = { '\x1b[C': 1, ' ': 1, '\x1b[D': ring.length - 1 }[key]
    if (step) prompt.type = ring[(i + step) % ring.length]
    else if (key === '0') prompt.type = null
    else if (TYPES[Number(key) - 1]) prompt.type = TYPES[Number(key) - 1].name
  } else prompt[prompt.field] = editText(prompt[prompt.field], key)
  return prompt
}

// What ↵ in the edit form writes, or null when the title is empty.
export function editChanges({ id, title, cat, type, note }) {
  if (!title.trim()) return null
  return { id, fields: { title: title.trim(), cat, type, note: note.trim() } }
}

// What the status row says after an edit is saved: null when the store
// failed, so its error stays showing; that the todo is gone only when the
// save found no such item.
export function savedNote(saved, error) {
  if (error) return null
  return saved ? { ok: true, text: `Saved: ${saved.title}` } : { ok: false, text: 'That todo is gone' }
}

// What a key does to the open prompt: the prompt after it (null closes it)
// and what the viewer has to do besides (run), if anything:
//   yes      the confirm was answered with its key
//   edit     the edit form takes the key (editKey, editChanges)
//   handoff  the hand-off row takes it (handoffKey)
//   manual   switch to adding by hand (manualPrompt)
//   add      add `add` by hand
//   file     hand `text` to Claude to file
//   ignore   nothing, not even a redraw
// `current` is the item under the cursor, whose category a new one starts on.
export function promptKey(prompt, key, current) {
  if (prompt.kind === 'confirm') return { prompt: null, run: key === prompt.key ? 'yes' : '' }
  if (key === '\x1b' || key === '\x03') return { prompt: null }
  if (prompt.kind === 'edit') return { prompt, run: 'edit' }
  if (prompt.kind === 'handoff') return { prompt, run: 'handoff' }
  if (prompt.kind === 'cat') {
    const picked = key === '\r' ? prompt.cat : CATEGORIES[Number(key) - 1]?.name
    if (!picked) return { prompt, run: 'ignore' }
    return { prompt: { ...prompt, kind: 'note', cat: picked, text: '' } }
  }
  // What the placeholder offers. Only on an empty line, so a message can
  // still have a capital A in it.
  if (prompt.kind === 'claude' && key === 'A' && !prompt.text) return { prompt, run: 'manual' }
  if (key === '\r') {
    const text = prompt.text.trim()
    if (prompt.kind === 'note') {
      const { title, cat, replaces } = prompt
      return { prompt: null, run: 'add', add: { title, cat, note: text, replaces } }
    }
    if (!text) return { prompt: null }
    if (prompt.kind === 'claude') return { prompt: null, run: 'file', text }
    return { prompt: { kind: 'cat', title: text, replaces: prompt.replaces, cat: (!current?.filing && current?.cat) || DEFAULT_CATEGORY } }
  }
  prompt.text = editText(prompt.text, key)
  return { prompt }
}

// The marked items, in the list's order.
export const markedIds = (list, marked) => list.filter(i => marked.has(i.id)).map(i => i.id)

// The hand-off row for these items. Fixed as the row opens, so what it says
// is where the agents start. Without a layout window (win 0) there is no
// tab session to open tabs in.
export function handoffPrompt(ids, items, here, win, exists = existsSync) {
  const at = { ...here }
  const places = ids.map(id => {
    const item = items.find(i => i.id === id) ?? {}
    const place = handoffPlace(item, at, exists)
    return { cwd: place.cwd, git: inGit(place, exists), moved: place !== item }
  })
  const git = places.filter(p => p.git).length
  return { kind: 'handoff', ids, here: at, places, inGit: git, runAs: win ? 'tab' : 'bg', worktree: git > 0, model: HANDOFF_MODELS[0] }
}

// A key on the hand-off row: t, b and m change the prompt in place. Says
// what else happened: 'start' on ↵, 'no-tab' when t has no tab session to
// switch to, 'no-git' when b has no worktree or branch to choose.
export function handoffKey(prompt, key, win) {
  if (key === 't') {
    if (!win) return 'no-tab'
    prompt.runAs = prompt.runAs === 'tab' ? 'bg' : 'tab'
  } else if (key === 'b') {
    if (!prompt.inGit) return 'no-git'
    prompt.worktree = !prompt.worktree
  } else if (key === 'm') prompt.model = HANDOFF_MODELS[(HANDOFF_MODELS.indexOf(prompt.model) + 1) % HANDOFF_MODELS.length]
  else if (key === '\r') return 'start'
  return ''
}

// What the status row says once the agents have started, or some failed.
export function handoffResult(started, failed, runAs) {
  if (failed.length) return { ok: false, text: `${started.length ? `Started ${started.length}; ` : ''}couldn't start ${failed.join('; ')}` }
  const where = runAs === 'tab' ? 'in new tabs' : 'in the background'
  return {
    ok: true,
    text: started.length === 1 ? `Handed to an agent ${where === 'in new tabs' ? 'in a new tab' : where}: ${started[0].title}` : `Handed ${started.length} todos to agents ${where}`,
  }
}

// The line typed into a new tab's shell for a tab agent: launch's line, run
// with the claude the viewer found.
export const tabLine = (claude, plan) => `${shellQuote(claude)}${plan.line.slice('claude'.length)}`

// The line that reopens Claude in a closed tab's place.
export const reopenLine = (claude, session) => (session ? `${shellQuote(claude)} --resume ${shellQuote(session)}` : shellQuote(claude))

// Where a closed tab's item reopens: its worktree, the folder it was added
// in, or its repo, whichever is still on disk.
export const reopenDir = (item, exists = existsSync) => [item.worktree, item.cwd, item.root].find(d => d && exists(d))

// Where an item's tab is now, in words. `panes` is readPanes' map, `win`
// this window's number (0 outside a layout window).
export function tabOf(pane, panes, win) {
  if (!pane) return ''
  const at = panes.get(pane)
  if (!at) return 'a tab now closed'
  const tab = at.hub ? 'a hub tab' : `tab ${at.index}`
  return at.win === win || !win ? tab : `w${at.win} · ${tab}`
}

// The agent the item was handed to, while the hub knows it: a tab agent by
// its pane, a background one by the name it was started with (launch in
// hub/model.mjs), which its card shows.
export function hubAgent(item, agents) {
  const { pane, name } = item.handoff ?? {}
  if (!pane && !name) return null
  return agents.find(a => (pane ? a.pane?.pane === pane : a.kind === 'bg' && a.title === name)) ?? null
}

// The tab of the agent the item was handed to, while it's open.
export const agentPane = (item, panes) => (item.handoff?.pane && panes.has(item.handoff.pane) ? item.handoff.pane : '')

// What ↵ does on the item's card, in words, or '' when it does nothing.
export const goLabel = (item, panes, agents) =>
  hubAgent(item, agents) || agentPane(item, panes) ? 'go to agent' : !item.pane ? '' : panes.has(item.pane) ? 'go to tab' : 'reopen'

// Why ↵ has nowhere to go for an item with no tab of its own.
export const noTabText = item =>
  item.handoff?.where === 'bg'
    ? `${item.handoff.name} ran in the background and the hub no longer lists it`
    : item.by === 'you'
      ? 'You added this one here, so it has no tab to go to'
      : 'This one was added outside the layout’s tabs'

// The mode header's tabs, as column ranges from 1.
export function modeAt(col, modes) {
  let from = 1
  for (const m of modes) {
    if (col >= from && col < from + m.label.length) return m
    from += m.label.length + 1
  }
}

// What a mouse report does: { move } for the wheel, { header: x } for a
// click on the top row, { row } for a click on a body row (an index into
// the rows as scrolled), or null. Only left presses click, and none while a
// prompt is open; the wheel moves the cursor regardless.
export function mouseAction({ button, x, y, released }, { prompt, top, height }) {
  if (button & 64) return { move: (button & 1) === 0 ? -1 : 1 }
  if (released || (button & 3) !== 0 || button & 32 || prompt) return null
  if (y === 1) return { header: x }
  if (y < top || y >= top + height) return null
  return { row: y - top }
}
