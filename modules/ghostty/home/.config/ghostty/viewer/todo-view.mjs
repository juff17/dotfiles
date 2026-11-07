#!/usr/bin/env node
// The viewer pane's Todo mode, as the canvas's T1 draws it with T3's jump
// back: every repo's open todos grouped by category, the active tab's repo
// first in each group, and the selected one opened under its row with its
// note and where it came from. ↵ goes to the tab that added it, or offers to
// start Claude there again when that tab is gone. Items come from
// bin/ghostty-todo (the /todo skill) and from here: a hands a message to
// Claude Haiku (ghostty-todo file), which writes the item; Shift+A adds one
// by hand, a title, a category and a note. m marks items and w hands the
// marked ones, or the selected one, to agents: one Claude each, started as
// the hub's New agent starts a task, in a tab or the background.
//   todo-view.mjs [dir]
// DV_TABS names the window's tab session as `socket:session`
// (bin/ghostty-claude-start); without it, dir is the folder.
// TD_FILES_EXIT, TD_DIFF_EXIT and TD_DIAGRAMS_EXIT are the exit codes that
// switch the pane to another mode (bin/ghostty-viewer); Tab goes to Diagrams,
// q to Files. TD_POPUP=1 runs it in Alt+T's popup (bin/ghostty-todo-panel)
// instead: no modes, Alt+T, Esc or q close it, and so does going to a tab.

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launch } from '../hub/model.mjs'
import { CATEGORIES, DEFAULT_CATEGORY, HANDOFF_MODELS, STORE, add, age, arrange, change, colorOf, fill, filingState, handoffSpec, load, remove, repoOf, stamp } from './todo.mjs'

const TODO_CLI = join(dirname(fileURLToPath(import.meta.url)), '../bin/ghostty-todo')

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
const P = {
  text: '#cdd6f4', sub: '#a6adc8', overlay: '#6c7086', surface2: '#585b70',
  blue: '#89b4fa', green: '#a6e3a1', peach: '#fab387', red: '#f38ba8', mauve: '#cba6f7',
}
const C = {
  text: fg(P.text),
  sub: fg(P.sub),
  overlay: fg(P.overlay),
  // Placeholder text in an empty prompt.
  hint: fg(P.surface2),
  blue: fg(P.blue),
  green: fg(P.green),
  peach: fg(P.peach),
  red: fg(P.red),
  mauve: fg(P.mauve),
  crust: fg('#11111b'),
  cursorBg: bg('#313244'),
  cardBg: bg('#181825'),
  tabBg: bg(P.text),
  pillBg: bg(P.mauve),
  claudeBg: bg(P.peach),
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  strike: '\x1b[9m',
  reset: '\x1b[0m',
}
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPIN_MS = 120

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
// The ids m marked, for w to hand off together.
let marked = new Set()
let scroll = 0
// What the status row is asking for: a message for Claude; a title, a
// category and a note; changes to an item; how to hand items off; or a yes.
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
  const list = [...view.filing, ...view.groups.flatMap(g => g.items)]
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
function tabOf(pane) {
  if (!pane) return ''
  const at = panes.get(pane)
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
  // ☑ has an emoji form that some fonts draw two cells wide; ✓ stays one.
  const box = item.done ? `${C.green}✓${C.reset}${back}` : '☐'
  const mark = marked.has(item.id) ? `${C.mauve}▌${C.reset}${back}` : ' '
  // ✻, as the hub marks a Claude at work: it's been handed to an agent.
  const agent = item.handoff ? `${C.blue}✻ ${C.reset}${back}` : ''
  const right = `${item.repo} · ${age(Date.now() - (item.done || item.created))}`
  const room = Math.max(4, width() - 4 - right.length - (agent ? 2 : 0) - 3)
  const fitted = fit(item.title, room)
  const words = fitted.trimEnd()
  const title = item.done
    ? `${C.sub}${C.strike}${words}${C.reset}${back}${fitted.slice(words.length)}`
    : `${selected ? C.bold : ''}${fitted}`
  return `${back}${mark} ${box} ${title}${C.reset}${back} ${agent}${C.sub}${right} ${C.reset}`
}

const visible = text => [...text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length

const cardWidth = () => Math.max(10, width() - 7)
const cardLine = text => {
  const inner = text.replaceAll(C.reset, `${C.reset}${C.cardBg}`)
  return `    ${C.cardBg} ${inner}${' '.repeat(Math.max(0, cardWidth() - visible(text)))} ${C.reset}`
}

// The selected item's card: who added it where, its note, and its keys.
function cardRows(item) {
  if (item.filing) return filingCard(item)
  const w = cardWidth()
  const pad = cardLine
  // The repo is on the item's row already; the branch goes last, where a
  // long one can be cut.
  const by = item.by === 'claude' ? 'Claude' : 'you'
  const where = [tabOf(item.pane) && `in ${tabOf(item.pane)}`, `at ${clock(item.created)}`, item.branch && `on ${item.branch}`].filter(Boolean).join(' ')
  const rows = [pad(`${C.sub}${fit(`added by ${by} ${where}`, w).trimEnd()}${C.reset}`)]
  if (prompt?.kind === 'edit' && prompt.id === item.id) return [...rows, ...editRows(w)]
  if (item.handoff) {
    const { name, where: ran, pane, at } = item.handoff
    const place = ran === 'bg' ? 'in the background' : `in ${tabOf(pane) || 'a tab'}`
    rows.push(pad(`${C.blue}✻ ${C.sub}${fit(`handed to ${name} ${place} at ${clock(at)}`, w - 2).trimEnd()}${C.reset}`))
  }
  if (item.note) for (const line of wrap(item.note, w)) rows.push(pad(`${C.text}${line}${C.reset}`))
  const go = agentPane(item) ? 'go to agent' : !item.pane ? '' : panes.has(item.pane) ? 'go to tab' : 'reopen'
  const keys = [...(go ? [['↵', go]] : []), ['e', 'edit'], ['c', 'category'], ['space', item.done ? 'reopen' : 'done']]
  rows.push(pad(hint(keys)))
  return rows
}

const LABEL_W = 10

// Every field of the item being edited, the one you're on with the caret:
// the category as all its picks, the others as their text wrapped under it.
function editRows(w) {
  const room = Math.max(4, w - LABEL_W)
  const rows = []
  for (const field of FIELDS) {
    const on = prompt.field === field
    const label = `${on ? `${C.mauve}${C.bold}` : C.sub}${FIELD_NAMES[field].padEnd(LABEL_W)}${C.reset}`
    let lines
    if (field === 'cat') {
      const color = colorOf(prompt.cat)
      lines = [
        on
          ? CATEGORIES.map((c, i) => `${C.blue}${i + 1}${C.reset} ${c.name === prompt.cat ? `${C.bold}${fg(c.color)}\x1b[4m` : fg(c.color)}${c.short}${C.reset}`).join(' ')
          : `${fg(color)}${prompt.cat}${C.reset}`,
      ]
    } else if (!prompt[field]) lines = [on ? `${CARET}${C.hint}${fit(field === 'note' ? 'Details for later' : PLACEHOLDER.title, room - 1).trimEnd()}${C.reset}` : `${C.hint}none${C.reset}`]
    else {
      // Room for the caret after the last character.
      lines = wrap(prompt[field], on ? room - 1 : room).map(line => `${C.text}${line}${C.reset}`)
      if (on) lines[lines.length - 1] += CARET
    }
    lines.forEach((line, i) => rows.push(cardLine(`${i ? ' '.repeat(LABEL_W) : label}${line}`)))
  }
  return rows
}

// A message Claude is turning into a todo: a spinner while it works, a cross
// once it has failed, and the message itself until the real title comes.
function filingRow(item, selected) {
  const back = selected ? C.cursorBg : ''
  const failed = filingState(item) === 'failed'
  const mark = failed ? `${C.red}✕` : `${C.peach}${SPINNER[Math.floor(Date.now() / SPIN_MS) % SPINNER.length]}`
  const right = `${item.repo} · ${age(Date.now() - item.created)}`
  const room = Math.max(4, width() - 4 - right.length - 3)
  const text = fit(item.title, room)
  const title = failed ? `${selected ? C.bold : ''}${text}` : `${C.sub}${C.italic}${text}`
  return `${back}  ${mark}${C.reset}${back} ${title}${C.reset}${back} ${C.sub}${right} ${C.reset}`
}

function filingCard(item) {
  const w = cardWidth()
  if (filingState(item) === 'filing')
    return [cardLine(`${C.sub}Claude Haiku is filing this, since ${clock(item.filing.started)}${C.reset}`), cardLine(hint([['x', 'drop']]))]
  const why = item.filing.error || 'it took too long'
  return [
    ...wrap(`Claude couldn't file this: ${why}`, w).map(line => cardLine(`${C.red}${line}${C.reset}`)),
    cardLine(hint([['r', 'retry'], ['shift+a', 'add by hand'], ['x', 'drop']])),
  ]
}

// Every body row, with the item each one belongs to so clicks and scrolling
// find it.
function bodyRows(view, current) {
  const rows = []
  if (view.filing.length) {
    rows.push({ text: `${C.sub}▾${C.reset} ${C.peach}${C.bold}filing${C.reset} ${C.sub}${view.filing.length}${C.reset}` })
    for (const item of view.filing) {
      const selected = item === current
      rows.push({ text: filingRow(item, selected), item })
      if (selected) for (const text of filingCard(item)) rows.push({ text, item })
    }
    rows.push({ text: '' })
  }
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
      : ['No todos yet.', 'Press a to have Claude add one, or Shift+A to add one by hand.']
  const rows = Array.from({ length: height }, () => ({ text: '' }))
  const top = Math.max(0, Math.floor(height / 2) - 1)
  lines.forEach((line, i) => {
    const padding = Math.max(0, Math.floor((width() - line.length) / 2))
    if (rows[top + i]) rows[top + i] = { text: `${' '.repeat(padding)}${C.sub}${line}${C.reset}` }
  })
  return rows
}

const CARET = '\x1b[7m \x1b[0m'
const PLACEHOLDER = {
  claude: 'Describe the item and let Claude handle it, or Shift+A to add it by hand',
  title: 'What needs doing',
  note: 'Details for later, or ↵ to skip',
}
const FIELDS = ['title', 'cat', 'note']
const FIELD_NAMES = { title: 'title', cat: 'category', note: 'note' }

// Where an add by hand is: the fields done ticked, this one bold, the rest dim.
function trail(at) {
  const parts = FIELDS.map((f, i) => {
    const name = FIELD_NAMES[f]
    if (i < FIELDS.indexOf(at)) return { text: `✓ ${name}`, color: C.sub }
    return f === at ? { text: name, color: `${C.mauve}${C.bold}` } : { text: name, color: C.hint }
  })
  return {
    text: parts.map(p => `${p.color}${p.text}${C.reset}`).join(`${C.hint} › ${C.reset}`),
    width: parts.reduce((n, p) => n + [...p.text].length, 0) + 3 * (parts.length - 1),
  }
}

// A pill, then what's typed so far (its end, when it's long) or the
// placeholder, then something set against the right edge if there's room.
// The placeholder says what to do, so it keeps its room over the right side.
function inputRow(label, pillBg, text, placeholder = '', right = null) {
  const pill = `${pillBg}${C.crust}${C.bold} ${label} ${C.reset} `
  const lead = label.length + 3
  const need = text ? 30 : [...placeholder].length + 3
  const side = right && width() - lead - right.width >= need ? right : null
  const room = width() - lead - 1 - (side ? side.width + 2 : 0)
  const body = text
    ? `${C.text}${[...text].slice(-room).join('')}${C.reset}${CARET}`
    : `${CARET}${C.hint}${fit(placeholder, room).trimEnd()}${C.reset}`
  return side ? `${pill}${body}\x1b[${width() - side.width + 1}G${side.text}` : `${pill}${body}`
}

function statusRow(list, current) {
  if (prompt?.kind === 'claude') {
    const model = 'haiku 5.5 · medium'
    return inputRow('CLAUDE', C.claudeBg, prompt.text, PLACEHOLDER.claude, { text: `${C.hint}${model}${C.reset}`, width: model.length })
  }
  if (prompt?.kind === 'edit') {
    const pairs = [['tab', 'next field'], ...(prompt.field === 'cat' ? [['1–6', 'pick']] : []), ['↵', 'save'], ['esc', 'cancel']]
    return `${C.pillBg}${C.crust}${C.bold} EDIT ${C.reset}  ${hint(8 + hintWidth(pairs) < width() ? pairs : pairs.slice(-2))}`
  }
  if (prompt?.kind === 'title' || prompt?.kind === 'note')
    return inputRow(prompt.kind.toUpperCase(), C.pillBg, prompt.text, PLACEHOLDER[prompt.kind], trail(prompt.kind))
  if (prompt?.kind === 'cat') {
    const picks = CATEGORIES.map((c, i) => `${C.blue}${i + 1}${C.reset} ${c.name === prompt.cat ? `${C.bold}${fg(c.color)}` : fg(c.color)}${c.short}${C.reset}`)
    const line = `${C.pillBg}${C.crust}${C.bold} CATEGORY ${C.reset} ${picks.join(' ')}`
    const used = 11 + CATEGORIES.reduce((n, c) => n + c.short.length + 3, 0)
    const side = trail('cat')
    return width() - used - side.width > 2 ? `${line}\x1b[${width() - side.width + 1}G${side.text}` : line
  }
  if (prompt?.kind === 'handoff') {
    const n = prompt.ids.length
    const choice = (key, value) => `${C.blue}${key}${C.reset} ${C.text}${C.bold}${value}${C.reset}`
    const choices = [
      choice('t', prompt.runAs === 'tab' ? 'tab' : 'background'),
      choice('b', prompt.worktree ? 'worktree' : 'this branch'),
      choice('m', prompt.model),
    ].join('  ')
    const lead = `${C.claudeBg}${C.crust}${C.bold} HAND OFF ${C.reset} ${C.sub}${n} ${n === 1 ? 'todo' : 'todos'} →${C.reset} ${choices}`
    const used = 11 + `${n} todos → `.length + 't background  b this branch  m sonnet'.length
    return width() - used > 20 ? `${lead}  ${hint([['↵', 'start'], ['esc', 'cancel']])}` : lead
  }
  if (prompt?.kind === 'confirm') return `${fg(P.peach)}${prompt.text}${C.reset}`
  if (said && Date.now() < said.until) return `${fg(said.color)}${fit(said.text, width() - 1)}${C.reset}`
  const pairs = marked.size
    ? [['w', 'hand off'], ['m', 'mark'], ['shift+m', 'clear'], ['space', 'done']]
    : [['space', 'done'], ['a', 'add'], ['shift+a', 'by hand'], ['m', 'mark'], ['w', 'hand off'], ['f', only ? 'all repos' : 'this repo']]
  const position = list.length ? `${marked.size ? `${marked.size} marked · ` : ''}${list.indexOf(current) + 1}/${list.length} ` : ''
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
  for (const id of marked) if (!list.some(i => i.id === id && !i.done && !i.filing)) marked.delete(id)
  const height = bodyHeight()
  let rows
  if (!view.groups.length && !view.filing.length && !(showDone && view.doneToday.length)) {
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

// The item under the cursor, unless Claude is still filing it: until then
// it has nothing to mark done, edit or recategorize.
function realItem() {
  const item = cursorItem()
  if (!item?.filing) return item
  say(filingState(item) === 'failed' ? 'r retries it, Shift+A adds it by hand, x drops it' : 'Claude is still filing this; x drops it')
}

function toggleDone() {
  const item = realItem()
  if (!item) return
  const list = selectable()
  const next = list[list.indexOf(item) + 1] ?? list[list.indexOf(item) - 1]
  write(() => change(item.id, { done: item.done ? null : Date.now() }))
  // Done leaves the list, so the cursor moves on instead of following it.
  if (!item.done && !showDone && next) cursorId = next.id
  say(item.done ? `Reopened: ${item.title}` : `Done: ${item.title}`, item.done ? P.blue : P.green)
}

function cycleCategory() {
  const item = realItem()
  if (!item) return
  const at = CATEGORIES.findIndex(c => c.name === item.cat)
  const cat = CATEGORIES[(at + 1) % CATEGORIES.length].name
  write(() => change(item.id, { cat }))
}

function startClaude() {
  prompt = { kind: 'claude', text: '' }
  draw()
}

// On a filing that failed, starts from its message and replaces it.
function startManual() {
  const item = cursorItem()
  prompt = filingState(item ?? {}) === 'failed' ? { kind: 'title', text: item.title, replaces: item.id } : { kind: 'title', text: '' }
  draw()
}

// ghostty-todo file runs Claude and waits for it, so it goes in its own
// session: closing the Alt+T popup doesn't stop it.
function fileWithClaude(args) {
  try {
    const child = spawn(process.execPath, [TODO_CLI, 'file', ...args], { detached: true, stdio: 'ignore' })
    child.on('error', error => say(`Couldn't run ghostty-todo: ${error.message}`, P.red))
    child.unref()
  } catch (error) {
    say(`Couldn't run ghostty-todo: ${error.message}`, P.red)
  }
}

function retryFiling() {
  const item = cursorItem()
  if (filingState(item ?? {}) !== 'failed') return
  fileWithClaude(['--retry', item.id])
  say('Asked Claude again', P.peach)
}

// Stops the filer, and the claude it started, which share its process group.
function stopFiler(item) {
  const pid = item.filing?.pid
  if (!pid) return
  try {
    process.kill(-pid)
  } catch {
    try {
      process.kill(pid)
    } catch {}
  }
}

function startEdit() {
  const item = realItem()
  if (!item) return
  prompt = { kind: 'edit', id: item.id, field: 'title', title: item.title, cat: item.cat, note: item.note ?? '' }
  draw()
}

function onEditKey(key) {
  const at = FIELDS.indexOf(prompt.field)
  if (key === '\t' || key === '\x1b[B') prompt.field = FIELDS[(at + 1) % FIELDS.length]
  else if (key === '\x1b[Z' || key === '\x1b[A') prompt.field = FIELDS[(at + FIELDS.length - 1) % FIELDS.length]
  else if (key === '\r') {
    const { id, title, cat, note } = prompt
    if (!title.trim()) {
      prompt.field = 'title'
      return say('A todo needs a title', P.peach)
    }
    prompt = null
    const saved = write(() => change(id, { title: title.trim(), cat, note: note.trim() }))
    return say(saved ? `Saved: ${saved.title}` : 'That todo is gone', saved ? P.green : P.peach)
  } else if (prompt.field === 'cat') {
    const i = CATEGORIES.findIndex(c => c.name === prompt.cat)
    const step = { '\x1b[C': 1, ' ': 1, '\x1b[D': CATEGORIES.length - 1 }[key]
    if (step) prompt.cat = CATEGORIES[(i + step) % CATEGORIES.length].name
    else if (CATEGORIES[Number(key) - 1]) prompt.cat = CATEGORIES[Number(key) - 1].name
  } else {
    const text = prompt[prompt.field]
    if (key === '\x7f' || key === '\b') prompt[prompt.field] = [...text].slice(0, -1).join('')
    else if (key === '\x15') prompt[prompt.field] = ''
    else if (key === '\x17') prompt[prompt.field] = text.replace(/\S*\s*$/, '')
    else if (!key.startsWith('\x1b') && key >= ' ') prompt[prompt.field] += key
  }
  draw()
}

function toggleMark() {
  const item = realItem()
  if (!item) return
  if (item.done) return say('It’s done; space reopens it')
  if (!marked.delete(item.id)) marked.add(item.id)
  moveCursor(1)
}

// The marked items, in the list's order, or else the selected one.
function startHandoff() {
  let ids = selectable()
    .filter(i => marked.has(i.id))
    .map(i => i.id)
  if (!ids.length) {
    const item = realItem()
    if (!item) return
    if (item.done) return say('It’s done; space reopens it')
    ids = [item.id]
  }
  // Without a layout window there is no tab session to open tabs in.
  prompt = { kind: 'handoff', ids, runAs: WIN ? 'tab' : 'bg', worktree: true, model: HANDOFF_MODELS[0] }
  draw()
}

function onHandoffKey(key) {
  if (key === 't') {
    if (!WIN) return say('Not in a Ghostty layout window, so agents can only run in the background')
    prompt.runAs = prompt.runAs === 'tab' ? 'bg' : 'tab'
  } else if (key === 'b') prompt.worktree = !prompt.worktree
  else if (key === 'm') prompt.model = HANDOFF_MODELS[(HANDOFF_MODELS.indexOf(prompt.model) + 1) % HANDOFF_MODELS.length]
  else if (key === '\r') {
    const { ids, ...how } = prompt
    prompt = null
    return void handOff(ids, how)
  }
  draw()
}

function claudePath() {
  try {
    return readFileSync(CLAUDE_FILE, 'utf8').trim() || 'claude'
  } catch {
    return 'claude'
  }
}

// Starts one agent per item, one after another so the tabs open in order,
// and records on each item who has it.
async function handOff(ids, how) {
  say(`Starting ${ids.length === 1 ? 'an agent' : `${ids.length} agents`}…`, P.peach)
  const started = []
  const failed = []
  for (const id of ids) {
    const item = items.find(i => i.id === id)
    if (!item) continue
    const spec = handoffSpec(item, how)
    const error = spec ? await startAgent(item, spec) : `${item.repo} is gone from disk`
    if (error) failed.push(`${item.title}: ${error}`)
    else started.push(item)
  }
  for (const item of started) marked.delete(item.id)
  void refresh()
  if (failed.length) return say(`${started.length ? `Started ${started.length}; ` : ''}couldn't start ${failed.join('; ')}`, P.red)
  const where = how.runAs === 'tab' ? 'in new tabs' : 'in the background'
  say(started.length === 1 ? `Handed to an agent ${where === 'in new tabs' ? 'in a new tab' : where}: ${started[0].title}` : `Handed ${started.length} todos to agents ${where}`, P.green)
}

// '' once the agent is running, or what went wrong.
async function startAgent(item, spec) {
  const plan = launch(spec)
  const claude = claudePath()
  let pane = ''
  if (plan.where === 'tab') {
    // -d: the tabs open behind the one you're on.
    const made = await tabs('new-window', '-d', '-t', `ghostty-${WIN}:`, '-c', spec.cwd, '-P', '-F', '#{pane_id}')
    if (!made.ok) return `couldn't open a tab: ${made.err}`
    pane = made.out.trim()
    // Typed into the tab's shell, so the shell stays when Claude exits.
    await tabs('send-keys', '-t', pane, '-l', `${shellQuote(claude)}${plan.line.slice('claude'.length)}`)
    await tabs('send-keys', '-t', pane, 'Enter')
  } else {
    // claude --bg prints its id and returns once the agent is running.
    const error = await new Promise(done => {
      let output = ''
      const child = spawn(claude, plan.argv.slice(1), { cwd: spec.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', b => (output += b))
      child.stderr.on('data', b => (output += b))
      child.on('error', e => done(`couldn't start claude: ${e.message}`))
      child.on('close', code => done(code ? `claude --bg failed: ${tidy(output).trim().slice(0, 120)}` : ''))
      child.unref()
    })
    if (error) return error
  }
  write(() => change(item.id, { handoff: { name: plan.name, where: plan.where, pane, at: Date.now() } }))
  return ''
}

// The tab of the agent the item was handed to, while it's open.
const agentPane = item => (item.handoff?.pane && panes.has(item.handoff.pane) ? item.handoff.pane : '')

function confirm(text, yes, key) {
  prompt = { kind: 'confirm', text, yes, key }
  draw()
}

function startDelete() {
  const item = cursorItem()
  if (!item) return
  if (item.filing)
    return confirm(`Drop "${item.title}"? x again drops it`, () => {
      write(() => remove(item.id))
      stopFiler(item)
      say('Dropped it')
    }, 'x')
  confirm(`Delete "${item.title}"? x again to delete, any other key keeps it`, () => {
    write(() => remove(item.id))
    say(`Deleted: ${item.title}`)
  }, 'x')
}

// A new item goes in under the active tab's repo, but without its pane:
// you added it here, not from that tab. One that replaces a failed filing
// keeps that filing's repo.
async function finishAdd({ title, cat, note, replaces }) {
  const where = await repoOf(here.folder || DIR)
  const old = replaces && items.find(i => i.id === replaces)
  if (old) stopFiler(old)
  const item = write(() => (replaces && fill(replaces, { title, cat, note, by: 'you' })) || add({ title, cat, note, by: 'you', cwd: here.folder || DIR, ...where }))
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
  if (prompt.kind === 'edit') return onEditKey(key)
  if (prompt.kind === 'handoff') return onHandoffKey(key)
  if (prompt.kind === 'cat') {
    const picked = key === '\r' ? prompt.cat : CATEGORIES[Number(key) - 1]?.name
    if (!picked) return
    prompt = { ...prompt, kind: 'note', cat: picked, text: '' }
    return draw()
  }
  // What the placeholder offers. Only on an empty line, so a message can
  // still have a capital A in it.
  if (prompt.kind === 'claude' && key === 'A' && !prompt.text) return startManual()
  if (key === '\r') {
    const text = prompt.text.trim()
    if (prompt.kind === 'note') {
      const { title, cat, replaces } = prompt
      prompt = null
      return void finishAdd({ title, cat, note: text, replaces })
    }
    if (!text) {
      prompt = null
      return draw()
    }
    if (prompt.kind === 'claude') {
      prompt = null
      fileWithClaude(['--dir', here.folder || DIR, '--', text])
      return say('Sent to Claude. It shows here once it’s filed.', P.peach)
    }
    const current = cursorItem()
    prompt = { kind: 'cat', title: text, replaces: prompt.replaces, cat: (!current?.filing && current?.cat) || DEFAULT_CATEGORY }
    return draw()
  }
  if (key === '\x7f' || key === '\b') prompt.text = [...prompt.text].slice(0, -1).join('')
  else if (key === '\x15') prompt.text = ''
  else if (key === '\x17') prompt.text = prompt.text.replace(/\S*\s*$/, '')
  else if (!key.startsWith('\x1b') && key >= ' ') prompt.text += key
  draw()
}

const shellQuote = text => text.replace(/[^\w./-]/g, '\\$&')

// The tab of the agent it was handed to, or else the tab that added it, in
// this window or another; or, once that tab is gone, a new tab running
// Claude there, resuming the item's session.
async function goTo() {
  const item = realItem()
  if (!item) return
  panes = await readPanes()
  const pane = agentPane(item) || item.pane
  if (!pane) {
    if (item.handoff?.where === 'bg') return say(`${item.handoff.name} runs in the background: open it in the hub`)
    return say(item.by === 'you' ? 'You added this one here, so it has no tab to go to' : 'This one was added outside the layout’s tabs')
  }
  const at = panes.get(pane)
  if (at?.hub) {
    // The hub opens its tabs itself, beside its board.
    if (at.win === WIN && WIN) await outer('select-window', '-t', `layout-${WIN}:hub`)
    if (POPUP && at.win === WIN) return quit()
    return say(`It's a tab the hub opened${at.win === WIN ? '' : ` in Ghostty window ${at.win}`}: pick it on the board`)
  }
  if (at) {
    await tabs('select-window', '-t', `${at.session}:${at.window}`)
    await tabs('select-pane', '-t', pane)
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
  const claude = claudePath()
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
    a: startClaude,
    A: startManual,
    r: retryFiling,
    e: startEdit,
    c: cycleCategory,
    x: startDelete,
    m: toggleMark,
    M: () => {
      marked.clear()
      draw()
    },
    w: startHandoff,
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
// Turns the spinner of anything Claude is filing.
setInterval(() => {
  if (items.some(i => filingState(i) === 'filing')) draw()
}, SPIN_MS)
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
