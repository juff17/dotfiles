#!/usr/bin/env node
// The viewer pane's Todo mode, as the canvas's T1 draws it with T3's jump
// back: every repo's open todos grouped by category, the active tab's repo
// first in each group, and the selected one opened under its row with its
// note and where it came from. ↵ goes to the tab that added it, or offers to
// start Claude there again when that tab is gone. Items come from
// bin/ghostty-todo (the /todo skill) and from a here.
//   todo-view.mjs [dir]
// DV_TABS names the window's tab session as `socket:session`
// (bin/ghostty-claude-start); without it, dir is the folder.
// TD_FILES_EXIT, TD_DIFF_EXIT and TD_DIAGRAMS_EXIT are the exit codes that
// switch the pane to another mode (bin/ghostty-viewer); Tab goes to Diagrams,
// q to Files. TD_POPUP=1 runs it in Alt+T's popup (bin/ghostty-todo-panel)
// instead: no modes, Alt+T, Esc or q close it, and so does going to a tab.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { CATEGORIES, DEFAULT_CATEGORY, STORE, add, age, arrange, change, colorOf, load, remove, repoOf, stamp } from './todo.mjs'

const DIR = process.argv[2] || process.cwd()
const [TABS_SOCKET, TABS_SESSION] = process.env.DV_TABS?.split(':') ?? [process.env.AGENT_HUB_TABS_SOCKET || 'ghostty', '']
const WIN = Number(/^ghostty-(\d+)$/.exec(TABS_SESSION)?.[1]) || 0
const LAYOUT_SOCKET = process.env.GHOSTTY_LAYOUT_SOCKET || 'ghostty-layout'
// The tab session touches this file when the active tab changes (tmux.conf).
const TAB_CHANGED = `${process.env.XDG_RUNTIME_DIR || '/tmp'}/ghostty-layout/tab-changed`
const CLAUDE_FILE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ghostty-layout/claude')
const FILES_EXIT = Number(process.env.TD_FILES_EXIT) || 0
const DIFF_EXIT = Number(process.env.TD_DIFF_EXIT) || 0
const DIAGRAMS_EXIT = Number(process.env.TD_DIAGRAMS_EXIT) || 0
const POPUP = process.env.TD_POPUP === '1'
const MODES = [
  { label: ' Diagrams ', exit: DIAGRAMS_EXIT },
  { label: ' Files ', exit: FILES_EXIT },
  { label: ' Diff ', exit: DIFF_EXIT },
  { label: ' Todo ', exit: 0 },
]
const REFRESH_MS = 2000
const SAY_MS = 4000
// The mode header and summary above the list, the status row below.
const TOP = 3
const CHROME_ROWS = 3

// Catppuccin Mocha, as in the design and diff-view.mjs.
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
const fg = hex => `\x1b[38;2;${rgb(hex)}m`
const bg = hex => `\x1b[48;2;${rgb(hex)}m`
const P = { text: '#cdd6f4', sub: '#a6adc8', overlay: '#6c7086', blue: '#89b4fa', green: '#a6e3a1', peach: '#fab387', red: '#f38ba8', mauve: '#cba6f7' }
const C = {
  text: fg(P.text),
  sub: fg(P.sub),
  overlay: fg(P.overlay),
  blue: fg(P.blue),
  green: fg(P.green),
  crust: fg('#11111b'),
  cursorBg: bg('#313244'),
  cardBg: bg('#181825'),
  tabBg: bg(P.text),
  pillBg: bg(P.mauve),
  bold: '\x1b[1m',
  strike: '\x1b[9m',
  reset: '\x1b[0m',
}

const out = s => process.stdout.write(s)
const width = () => process.stdout.columns
const bodyHeight = () => Math.max(1, process.stdout.rows - CHROME_ROWS)

let items = []
let lastStamp = null
let loadError = ''
// The active tab's repo: its main root, which every worktree shares.
let here = { root: '', repo: '' }
// Where each tab-session pane is now: its window's own session, window and index.
let panes = new Map()
let only = false
let showDone = false
let cursorId = ''
let scroll = 0
// What the status row is asking for: a title, a category, or a yes.
let prompt = null
let said = null
// The body rows last drawn, for clicks.
let drawn = []

const run = args =>
  new Promise(done =>
    execFile('tmux', args, { encoding: 'utf8' }, (error, stdout, stderr) =>
      done({ ok: !error, out: stdout ?? '', err: (stderr || error?.message || '').trim() }),
    ),
  )
const tabs = (...args) => run(['-L', TABS_SOCKET, ...args])
const outer = (...args) => run(['-L', LAYOUT_SOCKET, ...args])

function say(text, color = P.sub) {
  said = { text, color, until: Date.now() + SAY_MS }
  draw()
  setTimeout(draw, SAY_MS + 50)
}

// The active tab's folder, or dir when DV_TABS isn't set or tmux can't say.
async function activeFolder() {
  if (!TABS_SESSION) return DIR
  const shown = await tabs('display', '-p', '-t', `${TABS_SESSION}:`, '#{pane_current_path}')
  return (shown.ok && shown.out.trim()) || DIR
}

// A window shows in several sessions (the hub's too). A workspace tab's own
// is its window's ghostty-<n>; a tab opened from the hub is only in
// hubtabs-<n> (ghostty-lib.sh hub_tabs), and marked hub.
async function readPanes() {
  const listed = await tabs('list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}')
  const map = new Map()
  if (!listed.ok) return map
  for (const line of listed.out.split('\n')) {
    const [pane, session, window, index] = line.split('\t')
    const [, kind, n] = /^(ghostty|hubtabs)-(\d+)$/.exec(session ?? '') ?? []
    if (!pane || !kind || (kind === 'hubtabs' && map.has(pane))) continue
    map.set(pane, { session, window, index, win: Number(n), hub: kind === 'hubtabs' })
  }
  return map
}

function readStore(force = false) {
  const now = stamp()
  if (!force && now === lastStamp) return false
  lastStamp = now
  try {
    items = load()
    loadError = ''
  } catch (error) {
    loadError = error.message
  }
  return true
}

let refreshing = false
async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    readStore()
    const folder = await activeFolder()
    if (folder !== here.folder) here = { folder, ...(await repoOf(folder)) }
    panes = await readPanes()
  } finally {
    refreshing = false
    draw()
  }
}

// The list as drawn: what arrange() returns, flattened in order.
function shown() {
  return arrange(items, { here: here.root, only })
}

function selectable(view = shown()) {
  const list = view.groups.flatMap(g => g.items)
  return showDone ? [...list, ...view.doneToday] : list
}

function cursorItem(list = selectable()) {
  return list.find(i => i.id === cursorId) ?? list[0]
}

// By `by` items; ±Infinity goes to the first or last.
function moveCursor(by, list = selectable()) {
  if (!list.length) return
  const at = Math.max(0, list.indexOf(cursorItem(list)))
  cursorId = list[Math.max(0, Math.min(list.length - 1, at + by))]?.id ?? list[by < 0 ? 0 : list.length - 1].id
  draw()
}

const tidy = text => String(text).replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '')
const fit = (text, w) => {
  const chars = [...tidy(text)]
  return chars.length > w ? `${chars.slice(0, Math.max(0, w - 1)).join('')}…` : chars.join('') + ' '.repeat(w - chars.length)
}
const wrap = (text, w) =>
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
const hint = pairs => pairs.map(([key, what]) => `${C.blue}${key}${C.sub} ${what}${C.reset}`).join('  ')
const hintWidth = pairs => pairs.map(([key, what]) => `${key} ${what}`).join('  ').length

// Where an item's tab is now, in words.
function tabOf(item) {
  if (!item.pane) return ''
  const at = panes.get(item.pane)
  if (!at) return 'a tab now closed'
  const tab = at.hub ? 'a hub tab' : `tab ${at.index}`
  return at.win === WIN || !WIN ? tab : `w${at.win} · ${tab}`
}

const clock = ms => new Date(ms).toTimeString().slice(0, 5)

function header() {
  if (POPUP) return `${C.text}${C.bold} Todo${C.reset}\x1b[${width() - 'alt+t close'.length}G${hint([['alt+t', 'close']])}`
  const line = MODES.map((m, i) => (i === 3 ? `${C.tabBg}${C.crust}${C.bold}${m.label}${C.reset}` : `${C.sub}${C.bold}${m.label}${C.reset}`)).join(' ')
  return `${line}\x1b[${width() - 'tab switch'.length + 1}G${hint([['tab', 'switch']])}`
}

function summary(view) {
  const scope = only ? here.repo || 'this repo' : 'all repos'
  const left = `${C.blue}${C.bold}${view.open} open · ${scope}${C.reset}`
  const right = 'by category'
  return `${left}\x1b[${width() - right.length}G${C.sub}${right}${C.reset}`
}

function itemRow(item, selected) {
  const back = selected ? C.cursorBg : ''
  const box = item.done ? `${C.green}☑${C.reset}${back}` : '☐'
  const right = `${item.repo} · ${age(Date.now() - (item.done || item.created))}`
  const room = Math.max(4, width() - 4 - right.length - 3)
  const title = item.done ? `${C.sub}${C.strike}${fit(item.title, room)}${C.reset}${back}` : `${selected ? C.bold : ''}${fit(item.title, room)}`
  return `${back}  ${box} ${title}${C.reset}${back} ${C.sub}${right} ${C.reset}`
}

const visible = text => [...text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length

// The selected item's card: who added it where, its note, and its keys.
function cardRows(item) {
  const w = Math.max(10, width() - 7)
  const pad = text => {
    const inner = text.replaceAll(C.reset, `${C.reset}${C.cardBg}`)
    return `    ${C.cardBg} ${inner}${' '.repeat(Math.max(0, w - visible(text)))} ${C.reset}`
  }
  // The repo is on the item's row already; the branch goes last, where a
  // long one can be cut.
  const by = item.by === 'claude' ? 'Claude' : 'you'
  const where = [tabOf(item) && `in ${tabOf(item)}`, `at ${clock(item.created)}`, item.branch && `on ${item.branch}`].filter(Boolean).join(' ')
  const rows = [pad(`${C.sub}${fit(`added by ${by} ${where}`, w).trimEnd()}${C.reset}`)]
  if (item.note) for (const line of wrap(item.note, w)) rows.push(pad(`${C.text}${line}${C.reset}`))
  const go = !item.pane ? '' : panes.has(item.pane) ? 'go to tab' : 'reopen'
  const keys = [...(go ? [['↵', go]] : []), ['e', 'edit'], ['c', 'category'], ['space', item.done ? 'reopen' : 'done']]
  rows.push(pad(hint(keys)))
  return rows
}

// Every body row, with the item each one belongs to so clicks and scrolling
// find it.
function bodyRows(view, current) {
  const rows = []
  for (const g of view.groups) {
    rows.push({ text: `${C.sub}▾${C.reset} ${fg(g.color)}${C.bold}${g.name}${C.reset} ${C.sub}${g.items.length}${C.reset}` })
    for (const item of g.items) {
      const selected = item === current
      rows.push({ text: itemRow(item, selected), item })
      if (selected) for (const text of cardRows(item)) rows.push({ text, item })
    }
    rows.push({ text: '' })
  }
  if (view.doneToday.length) {
    rows.push({ text: `${C.sub}${showDone ? '▾' : '▸'} done today ${view.doneToday.length}${C.reset}`, done: true })
    if (showDone)
      for (const item of view.doneToday) {
        const selected = item === current
        rows.push({ text: itemRow(item, selected), item })
        if (selected) for (const text of cardRows(item)) rows.push({ text, item })
      }
  }
  return rows
}

function emptyRows(height) {
  const lines = loadError
    ? [loadError]
    : only
      ? [`No open todos in ${here.repo || 'this repo'}.`, 'f shows every repo.']
      : ['No todos yet.', 'Ask Claude to /todo something, or press a.']
  const rows = Array.from({ length: height }, () => ({ text: '' }))
  const top = Math.max(0, Math.floor(height / 2) - 1)
  lines.forEach((line, i) => {
    const padding = Math.max(0, Math.floor((width() - line.length) / 2))
    if (rows[top + i]) rows[top + i] = { text: `${' '.repeat(padding)}${C.sub}${line}${C.reset}` }
  })
  return rows
}

function statusRow(list, current) {
  if (prompt?.kind === 'title') {
    const label = prompt.edit ? 'edit' : 'add'
    const room = width() - label.length - 6
    const text = [...prompt.text].slice(-room).join('')
    return `${C.pillBg}${C.crust}${C.bold} ${label.toUpperCase()} ${C.reset} ${C.text}${text}${C.reset}\x1b[7m \x1b[0m`
  }
  if (prompt?.kind === 'cat') {
    const picks = CATEGORIES.map((c, i) => `${C.blue}${i + 1}${C.reset} ${c.name === prompt.cat ? `${C.bold}${fg(c.color)}` : fg(c.color)}${c.short}${C.reset}`)
    return `${C.pillBg}${C.crust}${C.bold} CATEGORY ${C.reset} ${picks.join(' ')}`
  }
  if (prompt?.kind === 'confirm') return `${fg(P.peach)}${prompt.text}${C.reset}`
  if (said && Date.now() < said.until) return `${fg(said.color)}${fit(said.text, width() - 1)}${C.reset}`
  const pairs = [['space', 'done'], ['a', 'add'], ['x', 'delete'], ['f', only ? 'all repos' : 'this repo']]
  const position = list.length ? `${list.indexOf(current) + 1}/${list.length} ` : ''
  const fits = 8 + hintWidth(pairs) + position.length < width()
  const left = `${C.pillBg}${C.crust}${C.bold} TODO ${C.reset}  ${fits ? hint(pairs) : hint(pairs.slice(0, 2))}`
  return position ? `${left}\x1b[${width() - position.length + 1}G${C.text}${position}${C.reset}` : left
}

// Each frame goes out in one write, inside synchronized output, every row
// overwriting itself, so a refresh never flickers.
function draw() {
  const view = shown()
  const list = selectable(view)
  const current = cursorItem(list)
  if (current) cursorId = current.id
  const height = bodyHeight()
  let rows
  if (!view.groups.length && !(showDone && view.doneToday.length)) {
    rows = emptyRows(height)
    if (view.doneToday.length) rows[height - 1] = { text: `${C.sub}▸ done today ${view.doneToday.length}${C.reset}`, done: true }
    scroll = 0
  } else {
    rows = bodyRows(view, current)
    // Keeps the selected item's whole card in view, its row first.
    const first = rows.findIndex(r => r.item === current)
    let last = first
    while (rows[last + 1]?.item === current) last++
    if (first >= 0) {
      if (last >= scroll + height) scroll = last - height + 1
      if (first < scroll) scroll = first
    }
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)))
  }
  drawn = rows
  const lines = [header(), summary(view)]
  for (let row = 0; row < height; row++) lines.push(rows[scroll + row]?.text ?? '')
  lines.push(statusRow(list, current))
  let frame = '\x1b[?2026h'
  lines.forEach((line, i) => {
    frame += `\x1b[${i + 1};1H\x1b[2K${line}`
  })
  out(`${frame}\x1b[?2026l`)
}

function write(action) {
  try {
    return action()
  } catch (error) {
    say(error.message, P.red)
  } finally {
    readStore(true)
    draw()
  }
}

function toggleDone() {
  const item = cursorItem()
  if (!item) return
  const list = selectable()
  const next = list[list.indexOf(item) + 1] ?? list[list.indexOf(item) - 1]
  write(() => change(item.id, { done: item.done ? null : Date.now() }))
  // Done leaves the list, so the cursor moves on instead of following it.
  if (!item.done && !showDone && next) cursorId = next.id
  say(item.done ? `Reopened: ${item.title}` : `Done: ${item.title}`, item.done ? P.blue : P.green)
}

function cycleCategory() {
  const item = cursorItem()
  if (!item) return
  const at = CATEGORIES.findIndex(c => c.name === item.cat)
  const cat = CATEGORIES[(at + 1) % CATEGORIES.length].name
  write(() => change(item.id, { cat }))
}

function startAdd() {
  prompt = { kind: 'title', text: '' }
  draw()
}

function startEdit() {
  const item = cursorItem()
  if (!item) return
  prompt = { kind: 'title', text: item.title, edit: item.id }
  draw()
}

function confirm(text, yes, key) {
  prompt = { kind: 'confirm', text, yes, key }
  draw()
}

function startDelete() {
  const item = cursorItem()
  if (!item) return
  confirm(`Delete "${item.title}"? x again to delete, any other key keeps it`, () => {
    write(() => remove(item.id))
    say(`Deleted: ${item.title}`)
  }, 'x')
}

// A new item goes in under the active tab's repo, but without its pane:
// you added it here, not from that tab.
async function finishAdd(title, cat) {
  const where = await repoOf(here.folder || DIR)
  const item = write(() => add({ title, cat, by: 'you', cwd: here.folder || DIR, ...where }))
  if (item) {
    cursorId = item.id
    say(`Added to ${item.repo}: ${item.title}`, P.green)
  }
}

function onPromptKey(key) {
  if (prompt.kind === 'confirm') {
    const { yes, key: wanted } = prompt
    prompt = null
    if (key === wanted) return yes()
    return draw()
  }
  if (key === '\x1b' || key === '\x03') {
    prompt = null
    return draw()
  }
  if (prompt.kind === 'cat') {
    const picked = key === '\r' ? prompt.cat : CATEGORIES[Number(key) - 1]?.name
    if (!picked) return
    const { title } = prompt
    prompt = null
    return void finishAdd(title, picked)
  }
  if (key === '\r') {
    const title = prompt.text.trim()
    if (!title) {
      prompt = null
      return draw()
    }
    if (prompt.edit) {
      const id = prompt.edit
      prompt = null
      return write(() => change(id, { title }))
    }
    prompt = { kind: 'cat', title, cat: cursorItem()?.cat ?? DEFAULT_CATEGORY }
    return draw()
  }
  if (key === '\x7f' || key === '\b') prompt.text = [...prompt.text].slice(0, -1).join('')
  else if (key === '\x15') prompt.text = ''
  else if (key === '\x17') prompt.text = prompt.text.replace(/\S*\s*$/, '')
  else if (!key.startsWith('\x1b') && key >= ' ') prompt.text += key
  draw()
}

const shellQuote = text => text.replace(/[^\w./-]/g, '\\$&')

// The tab that added the item, in this window or another; or, once that
// tab is gone, a new tab running Claude there, resuming the item's session.
async function goTo() {
  const item = cursorItem()
  if (!item) return
  if (!item.pane) return say(item.by === 'you' ? 'You added this one here, so it has no tab to go to' : 'This one was added outside the layout’s tabs')
  panes = await readPanes()
  const at = panes.get(item.pane)
  if (at?.hub) {
    // The hub opens its tabs itself, beside its board.
    if (at.win === WIN && WIN) await outer('select-window', '-t', `layout-${WIN}:hub`)
    if (POPUP && at.win === WIN) return quit()
    return say(`It's a tab the hub opened${at.win === WIN ? '' : ` in Ghostty window ${at.win}`}: pick it on the board`)
  }
  if (at) {
    await tabs('select-window', '-t', `${at.session}:${at.window}`)
    await tabs('select-pane', '-t', item.pane)
    if (at.win !== WIN && WIN) return say(`Switched to tab ${at.index} in Ghostty window ${at.win}`)
    if (WIN) {
      const tabsPane = (await outer('show', '-t', `layout-${WIN}`, '-v', '@tabs')).out.trim()
      await outer('select-window', '-t', `layout-${WIN}:work`)
      if (tabsPane) await outer('select-pane', '-t', tabsPane)
    }
    return POPUP ? quit() : draw()
  }
  if (!WIN) return say('Not in a Ghostty layout window, so there is no tab session to open a tab in', P.red)
  const dir = [item.worktree, item.cwd, item.root].find(d => d && existsSync(d))
  if (!dir) return say(`Its tab is closed and ${item.repo} is gone from disk`, P.peach)
  const resume = item.session ? ', resuming its session' : ''
  confirm(`Its tab is closed. ↵ again opens Claude in ${basename(dir)}${resume}`, () => void reopen(item, dir), '\r')
}

async function reopen(item, dir) {
  let claude = 'claude'
  try {
    claude = readFileSync(CLAUDE_FILE, 'utf8').trim() || claude
  } catch {}
  const made = await tabs('new-window', '-t', `ghostty-${WIN}:`, '-c', dir, '-P', '-F', '#{pane_id}')
  if (!made.ok) return say(`Couldn't open a tab: ${made.err}`, P.red)
  const pane = made.out.trim()
  // Typed into the tab's shell, so the shell stays when Claude exits.
  const command = item.session ? `${shellQuote(claude)} --resume ${shellQuote(item.session)}` : shellQuote(claude)
  await tabs('send-keys', '-t', pane, '-l', command)
  await tabs('send-keys', '-t', pane, 'Enter')
  write(() => change(item.id, { pane }))
  const tabsPane = (await outer('show', '-t', `layout-${WIN}`, '-v', '@tabs')).out.trim()
  if (tabsPane) await outer('select-pane', '-t', tabsPane)
  await outer('select-window', '-t', `layout-${WIN}:work`)
  if (POPUP) return quit()
  void refresh()
}

function quit(code = 0) {
  out('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  process.exit(code)
}

// The mode header's tabs, as column ranges from 1.
function modeAt(col) {
  let from = 1
  for (const m of MODES) {
    if (col >= from && col < from + m.label.length) return m
    from += m.label.length + 1
  }
}

function onMouse(button, x, y, released) {
  if (button & 64) return moveCursor((button & 1) === 0 ? -1 : 1)
  if (released || (button & 3) !== 0 || button & 32 || prompt) return
  if (y === 1) {
    const mode = !POPUP && modeAt(x)
    if (mode?.exit) quit(mode.exit)
    return
  }
  if (y < TOP || y >= TOP + bodyHeight()) return
  const row = drawn[scroll + y - TOP]
  if (row?.done) {
    showDone = !showDone
    return draw()
  }
  if (row?.item) {
    cursorId = row.item.id
    draw()
  }
}

function onKey(key) {
  if (prompt) return onPromptKey(key)
  const page = Math.max(1, Math.floor(bodyHeight() / 2))
  const actions = {
    q: () => quit(POPUP ? 0 : FILES_EXIT),
    '\x03': () => quit(POPUP ? 0 : FILES_EXIT),
    '\x1b': () => POPUP && quit(),
    '\x1bt': () => POPUP && quit(),
    '\t': () => DIAGRAMS_EXIT && quit(DIAGRAMS_EXIT),
    j: () => moveCursor(1),
    k: () => moveCursor(-1),
    '\x1b[B': () => moveCursor(1),
    '\x1b[A': () => moveCursor(-1),
    '\x04': () => moveCursor(page),
    '\x15': () => moveCursor(-page),
    '\x1b[6~': () => moveCursor(page),
    '\x1b[5~': () => moveCursor(-page),
    g: () => moveCursor(-Infinity),
    G: () => moveCursor(Infinity),
    '\r': () => void goTo(),
    ' ': toggleDone,
    a: startAdd,
    e: startEdit,
    c: cycleCategory,
    x: startDelete,
    f: () => {
      only = !only
      draw()
    },
    d: () => {
      showDone = !showDone
      draw()
    },
  }
  actions[key]?.()
}

// Mouse reports, other escape sequences, Alt+letter, then single keys.
const INPUT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[^a-zA-Z~]*[a-zA-Z~]|\x1b[a-zA-Z]|[\s\S]/gu

function onInput(data) {
  for (const m of data.toString('utf8').matchAll(INPUT)) {
    if (m[1] !== undefined) onMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'm')
    else onKey(m[0])
  }
}

if (!process.stdin.isTTY) {
  console.error('todo-view needs a terminal.')
  process.exit(1)
}

process.stdin.setRawMode(true)
process.stdin.on('data', onInput)
process.on('SIGWINCH', draw)
process.on('SIGTERM', () => quit())
// Alternate screen, no cursor, button and drag reports in SGR form.
out('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h')
mkdirSync(dirname(STORE), { recursive: true })
readStore(true)
draw()
void refresh()
setInterval(() => void refresh(), REFRESH_MS)
for (const [folder, name] of [
  [dirname(STORE), basename(STORE)],
  [dirname(TAB_CHANGED), 'tab-changed'],
]) {
  try {
    watch(folder, (_, changed) => {
      if (changed === name) void refresh()
    })
  } catch {
    // No such folder yet: the interval catches up.
  }
}
