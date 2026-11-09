#!/usr/bin/env node
// The viewer pane's Todo mode, as the canvas's T1 draws it with T3's jump
// back: every repo's open todos grouped by category, the active tab's repo
// first in each group, and the selected one opened under its row with its
// note and where it came from. ↵ opens the agent it was handed to in the
// hub, beside the hub's list, or else goes to the tab that added it, or
// offers to start Claude there again when that tab is gone. Items come from
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
import { mkdirSync, readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readState } from '../hub/client.mjs'
import { load as settings } from '../hub/settings.mjs'
import { launch } from '../hub/model.mjs'
import { go as openInHub } from '../hub/tray.mjs'
import { CATEGORIES, STORE, TYPES, add, age, arrange, change, colorOf, fill, filingState, handoffPlace, handoffSpec, knownRepos, load, remove, repoOf, stamp, typeColorOf } from './todo.mjs'
import * as ui from './todo-ui.mjs'
import { EDIT_FIELDS, FIELD_NAMES, FIELDS, KEYS, fit, tidy, visible, wrap } from './todo-ui.mjs'

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
// How long a note under the list shows: Settings' todo.noteSecs.
const sayMs = () => settings()['todo.noteSecs'] * 1000
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
// Every agent the hub knows of, from agentd's state.
let agents = []
let only = false
let showDone = false
let cursorId = ''
// The ids m marked, for w to hand off together.
const marked = new Set()
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
  said = { text, color, until: Date.now() + sayMs() }
  draw()
  setTimeout(draw, sayMs() + 50)
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
    agents = readState()?.agents ?? []
  } finally {
    refreshing = false
    draw()
  }
}

// The list as drawn: what arrange() returns, flattened in order.
function shown() {
  return arrange(items, { here: here.root, only })
}

const selectable = (view = shown()) => ui.selectable(view, showDone)
const cursorItem = (list = selectable()) => ui.cursorItem(list, cursorId)

// By `by` items; ±Infinity goes to the first or last.
function moveCursor(by, list = selectable()) {
  if (!list.length) return
  cursorId = ui.moveTo(list, cursorId, by)
  draw()
}

const hint = pairs => pairs.map(([key, what]) => `${C.blue}${key}${C.sub} ${what}${C.reset}`).join('  ')
const hintWidth = pairs => pairs.map(([key, what]) => `${key} ${what}`).join('  ').length

// Where an item's tab is now, in words.
const tabOf = pane => ui.tabOf(pane, panes, WIN)

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
  // The type leads the right side, in its own color.
  const type = item.type ? `${item.type} · ` : ''
  const room = Math.max(4, width() - 4 - type.length - ui.cells(right) - (agent ? 2 : 0) - 3)
  const fitted = fit(item.title, room)
  const words = fitted.trimEnd()
  const title = item.done
    ? `${C.sub}${C.strike}${words}${C.reset}${back}${fitted.slice(words.length)}`
    : `${selected ? C.bold : ''}${fitted}`
  const typed = item.type ? `${fg(typeColorOf(item.type))}${item.type}${C.sub} · ` : ''
  return `${back}${mark} ${box} ${title}${C.reset}${back} ${agent}${C.sub}${typed}${right} ${C.reset}`
}

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
  const go = ui.goLabel(item, panes, agents)
  const keys = [...(go ? [['↵', go]] : []), ['e', 'edit'], ['c', 'category'], ['t', 'type'], ['space', item.done ? 'reopen' : 'done']]
  rows.push(pad(hint(keys)))
  return rows
}

const LABEL_W = 10

// Every field of the item being edited, the one you're on with the caret:
// the category and type as all their picks, the others as their text wrapped under it.
function editRows(w) {
  const room = Math.max(4, w - LABEL_W)
  const rows = []
  for (const field of EDIT_FIELDS) {
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
    } else if (field === 'type') {
      const pick = (key, name, color) => `${C.blue}${key}${C.reset} ${name === prompt.type ? `${C.bold}${fg(color)}\x1b[4m` : fg(color)}${name ?? 'none'}${C.reset}`
      lines = [
        on
          ? [...TYPES.map((t, i) => pick(i + 1, t.name, t.color)), pick(0, null, P.sub)].join(' ')
          : prompt.type
            ? `${fg(typeColorOf(prompt.type))}${prompt.type}${C.reset}`
            : `${C.hint}none${C.reset}`,
      ]
    } else if (field === 'repo') lines = [on ? repoPicks(room) : prompt.repo === ui.NO_REPO ? `${C.hint}none${C.reset}` : `${C.text}${prompt.repo.repo}${C.reset}`]
    else if (!prompt[field]) lines = [on ? `${CARET}${C.hint}${fit(field === 'note' ? 'Details for later' : PLACEHOLDER.title, room - 1).trimEnd()}${C.reset}` : `${C.hint}none${C.reset}`]
    else {
      // Wrapped with the caret's mark in, so it lands where the wrap puts it.
      const text = on ? ui.withCaret(prompt[field], prompt.at) : prompt[field]
      lines = wrap(text, room).map(line => `${C.text}${ui.caretShown(line)}${C.reset}`)
    }
    lines.forEach((line, i) => rows.push(cardLine(`${i ? ' '.repeat(LABEL_W) : label}${line}`)))
  }
  return rows
}

// The repo field while you're on it: the filter typed so far, then the
// pick and the matches after it, as many as fit, and where the pick is in them.
function repoPicks(room) {
  const matches = ui.repoMatches(prompt)
  const typed = prompt.find ? `${C.text}${prompt.find}${C.reset}${CARET} ` : ''
  const lead = prompt.find ? ui.cells(prompt.find) + 2 : 0
  if (!matches.length) return `${typed}${C.peach}no directory matches${C.reset}`
  const at = Math.max(0, matches.indexOf(prompt.repo))
  const count = `${at + 1}/${matches.length}`
  let used = lead + count.length + 2
  const names = []
  for (const [i, r] of matches.slice(at).entries()) {
    const name = r === ui.NO_REPO ? 'none' : r.repo
    if (i && used + ui.cells(name) + 2 > room) break
    names.push(i ? `${C.sub}${name}${C.reset}` : `${C.bold}${C.mauve}\x1b[4m${fit(name, Math.max(1, room - used)).trimEnd()}${C.reset}`)
    used += ui.cells(name) + 2
  }
  return `${typed}${names.join('  ')}  ${C.hint}${count}${C.reset}`
}

// A message Claude is turning into a todo: a spinner while it works, a cross
// once it has failed, and the message itself until the real title comes.
function filingRow(item, selected) {
  const back = selected ? C.cursorBg : ''
  const failed = filingState(item) === 'failed'
  const mark = failed ? `${C.red}✕` : `${C.peach}${SPINNER[Math.floor(Date.now() / SPIN_MS) % SPINNER.length]}`
  const right = `${item.repo} · ${age(Date.now() - item.created)}`
  const room = Math.max(4, width() - 4 - ui.cells(right) - 3)
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
  const lines = ui.emptyLines({ loadError, only, repo: here.repo })
  const rows = Array.from({ length: height }, () => ({ text: '' }))
  const top = Math.max(0, Math.floor(height / 2) - 1)
  lines.forEach((line, i) => {
    const padding = Math.max(0, Math.floor((width() - ui.cells(line)) / 2))
    if (rows[top + i]) rows[top + i] = { text: `${' '.repeat(padding)}${C.sub}${line}${C.reset}` }
  })
  return rows
}

const CARET = '\x1b[7m \x1b[0m'
const caretBlock = ({ before, under, after }) => `${C.text}${before}\x1b[7m${under}\x1b[27m${after}${C.reset}`
const PLACEHOLDER = {
  claude: 'Describe the item and let Claude handle it, or Shift+A to add it by hand',
  title: 'What needs doing',
  note: 'Details for later, or ↵ to skip',
}
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

// A pill, then what's typed so far (around the caret, when it's long) or the
// placeholder, then something set against the right edge if there's room.
// The placeholder says what to do, so it keeps its room over the right side.
function inputRow(label, pillBg, text, placeholder = '', right = null, at = undefined) {
  const pill = `${pillBg}${C.crust}${C.bold} ${label} ${C.reset} `
  const lead = label.length + 3
  const need = text ? 30 : ui.cells(placeholder) + 3
  const side = right && width() - lead - right.width >= need ? right : null
  const room = width() - lead - 1 - (side ? side.width + 2 : 0)
  const body = text
    ? caretBlock(ui.caretParts(text, at, room + 1))
    : `${CARET}${C.hint}${fit(placeholder, room).trimEnd()}${C.reset}`
  return side ? `${pill}${body}\x1b[${width() - side.width + 1}G${side.text}` : `${pill}${body}`
}

function statusRow(list, current) {
  if (prompt?.kind === 'claude') {
    const s = settings()
    const model = `${s['todo.filing.model']} 5.5 · ${s['todo.filing.effort']}`
    return inputRow('CLAUDE', C.claudeBg, prompt.text, PLACEHOLDER.claude, { text: `${C.hint}${model}${C.reset}`, width: model.length }, prompt.at)
  }
  if (prompt?.kind === 'edit') {
    const picks = { cat: [['1–6', 'pick']], type: [['0–5', 'pick']], repo: [['←/→', 'pick'], ['type', 'filter']] }[prompt.field] ?? []
    const pairs = [['tab', 'next field'], ...picks, ['↵', 'save'], ['esc', 'cancel']]
    return `${C.pillBg}${C.crust}${C.bold} EDIT ${C.reset}  ${hint(8 + hintWidth(pairs) < width() ? pairs : pairs.slice(-2))}`
  }
  if (prompt?.kind === 'title' || prompt?.kind === 'note')
    return inputRow(prompt.kind.toUpperCase(), C.pillBg, prompt.text, PLACEHOLDER[prompt.kind], trail(prompt.kind), prompt.at)
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
    // Outside git there's no worktree or branch to choose, only the folder.
    // Items without a repo go to the open folder; the row says which.
    const outside = n - prompt.inGit
    const folders = [...new Set(prompt.places.filter(p => !p.git).map(p => p.cwd))]
    const away = prompt.places.filter(p => p.moved).length
    const branch = !prompt.inGit
      ? `${Date.now() - (prompt.flash ?? 0) < sayMs() ? C.peach : C.sub}in ${folders.length === 1 ? basename(folders[0]) : 'their folders'}, not git${C.reset}`
      : `${choice('b', prompt.worktree ? 'worktree' : 'this branch')}${C.sub}${outside ? ` · ${outside} not in git` : away ? ` · ${away} without a repo → ${prompt.here.repo}` : ''}${C.reset}`
    const choices = [choice('t', prompt.runAs === 'tab' ? 'tab' : 'background'), branch, choice('m', prompt.model)].join('  ')
    const lead = `${C.claudeBg}${C.crust}${C.bold} HAND OFF ${C.reset} ${C.sub}${n} ${n === 1 ? 'todo' : 'todos'} →${C.reset} ${choices}`
    const used = 11 + `${n} todos → `.length + 't background  b this branch · 9 without a repo → dotfiles  m sonnet'.length
    return width() - used > 20 ? `${lead}  ${hint([['↵', 'start'], ['esc', 'cancel']])}` : lead
  }
  if (prompt?.kind === 'confirm') return `${fg(P.peach)}${prompt.text}${C.reset}`
  if (said && Date.now() < said.until) return `${fg(said.color)}${fit(said.text, width() - 1)}${C.reset}`
  // Marks on items f hides don't count: w wouldn't hand them off.
  const marks = ui.markedIds(list, marked).length
  const pairs = ui.statusPairs(marks, only)
  const position = ui.position(list, current, marks)
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
  ui.pruneMarks(marked, items)
  const height = bodyHeight()
  let rows
  if (!view.groups.length && !view.filing.length && !(showDone && view.doneToday.length)) {
    rows = emptyRows(height)
    if (view.doneToday.length) rows[height - 1] = { text: `${C.sub}▸ done today ${view.doneToday.length}${C.reset}`, done: true }
    scroll = 0
  } else {
    rows = bodyRows(view, current)
    scroll = ui.scrollTo(rows, current, scroll, height)
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

// The action's result as { value }, or { error } when the store threw,
// which the status row then shows.
function attempt(action) {
  try {
    return { value: action() }
  } catch (error) {
    say(error.message, P.red)
    return { error }
  } finally {
    readStore(true)
    draw()
  }
}

const write = action => attempt(action).value

// The item under the cursor, unless Claude is still filing it: until then
// it has nothing to mark done, edit or recategorize.
function realItem() {
  const item = cursorItem()
  if (!item?.filing) return item
  say(ui.filingHint(item))
}

function toggleDone() {
  const item = realItem()
  if (!item) return
  const next = ui.neighbour(selectable(), item)
  write(() => change(item.id, { done: item.done ? null : Date.now() }))
  // Done leaves the list, so the cursor moves on instead of following it.
  if (!item.done && !showDone && next) cursorId = next.id
  say(item.done ? `Reopened: ${item.title}` : `Done: ${item.title}`, item.done ? P.blue : P.green)
}

function cycleCategory() {
  const item = realItem()
  if (!item) return
  write(() => change(item.id, { cat: ui.nextCategory(item.cat) }))
}

// Through each type, then none, then round again.
function cycleType() {
  const item = realItem()
  if (!item) return
  write(() => change(item.id, { type: ui.nextType(item.type) }))
}

function startClaude() {
  prompt = { kind: 'claude', text: '' }
  draw()
}

// On a filing that failed, starts from its message and replaces it.
function startManual() {
  prompt = ui.manualPrompt(cursorItem())
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
  prompt = ui.editPrompt(item, knownRepos(items))
  draw()
}

function onEditKey(key) {
  if (key === '\r') {
    const save = ui.editChanges(prompt)
    if (!save) {
      prompt.field = 'title'
      delete prompt.at
      return say('A todo needs a title', P.peach)
    }
    prompt = null
    const { value, error } = attempt(() => change(save.id, save.fields))
    const note = ui.savedNote(value, error)
    return note && say(note.text, note.ok ? P.green : P.peach)
  }
  ui.editKey(prompt, key)
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
  let ids = ui.markedIds(selectable(), marked)
  if (!ids.length) {
    const item = realItem()
    if (!item) return
    if (item.done) return say('It’s done; space reopens it')
    ids = [item.id]
  }
  prompt = ui.handoffPrompt(ids, items, here, WIN)
  draw()
}

function onHandoffKey(key) {
  const result = ui.handoffKey(prompt, key, WIN)
  if (result === 'no-tab') return say('Not in a Ghostty layout window, so agents can only run in the background')
  if (result === 'no-git') {
    // The row covers the status line, so the note itself lights up.
    prompt.flash = Date.now()
    setTimeout(draw, sayMs() + 50)
    return draw()
  }
  if (result === 'start') {
    const { ids, here: at, runAs, worktree, model } = prompt
    prompt = null
    return void handOff(ids, at, { runAs, worktree, model })
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
// and records on each item who has it. An item without a repo goes to the
// folder the viewer had open (at) when the row opened.
async function handOff(ids, at, how) {
  say(`Starting ${ids.length === 1 ? 'an agent' : `${ids.length} agents`}…`, P.peach)
  const started = []
  const failed = []
  for (const id of ids) {
    const item = items.find(i => i.id === id)
    if (!item) continue
    const s = settings()
    const spec = handoffSpec(handoffPlace(item, at), { ...how, mode: s['todo.handoff.mode'], effort: s['todo.handoff.effort'] })
    const error = spec ? await startAgent(item, spec) : `${item.repo} is gone from disk`
    if (error) failed.push(`${item.title}: ${error}`)
    else started.push(item)
  }
  for (const item of started) marked.delete(item.id)
  void refresh()
  const result = ui.handoffResult(started, failed, how.runAs)
  say(result.text, result.ok ? P.green : P.red)
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
    await tabs('send-keys', '-t', pane, '-l', ui.tabLine(claude, plan))
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
  const was = prompt
  const step = ui.promptKey(prompt, key, cursorItem())
  if (step.run === 'ignore') return
  prompt = step.prompt
  if (step.run === 'yes') return was.yes()
  if (step.run === 'edit') return onEditKey(key)
  if (step.run === 'handoff') return onHandoffKey(key)
  if (step.run === 'manual') return startManual()
  if (step.run === 'add') return void finishAdd(step.add)
  if (step.run === 'file') {
    fileWithClaude(['--dir', here.folder || DIR, '--', step.text])
    return say('Sent to Claude. It shows here once it’s filed.', P.peach)
  }
  draw()
}

// The agent it was handed to, opened in the hub beside its list as the
// tray's Go does: a tab agent through a session of its own, so the
// workspace stays on its tab, a background one with claude attach. Without
// one, the tab that added it, in this window or another; or, once that tab
// is gone, a new tab running Claude there, resuming the item's session.
async function goTo() {
  const item = realItem()
  if (!item) return
  panes = await readPanes()
  agents = readState()?.agents ?? []
  const agent = ui.hubAgent(item, agents)
  if (agent) {
    const went = await openInHub(agent, WIN ? `layout-${WIN}` : '')
    if (!went.ok) return say(went.message, P.red)
    return POPUP ? quit() : draw()
  }
  const pane = ui.agentPane(item, panes) || item.pane
  if (!pane) return say(ui.noTabText(item))
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
  const dir = ui.reopenDir(item)
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
  await tabs('send-keys', '-t', pane, '-l', ui.reopenLine(claude, item.session))
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

function onMouse(report) {
  const action = ui.mouseAction(report, { prompt, top: TOP, height: bodyHeight() })
  if (!action) return
  if (action.move) return moveCursor(action.move)
  if (action.header !== undefined) {
    const mode = !POPUP && ui.modeAt(action.header, MODES)
    if (mode?.exit) quit(mode.exit)
    return
  }
  const row = drawn[scroll + action.row]
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
  if (prompt && ui.promptTakes(key, POPUP)) return onPromptKey(key)
  const page = Math.max(1, Math.floor(bodyHeight() / 2))
  const actions = {
    quit: () => quit(POPUP ? 0 : FILES_EXIT),
    close: () => POPUP && quit(),
    'next-mode': () => DIAGRAMS_EXIT && quit(DIAGRAMS_EXIT),
    down: () => moveCursor(1),
    up: () => moveCursor(-1),
    'page-down': () => moveCursor(page),
    'page-up': () => moveCursor(-page),
    first: () => moveCursor(-Infinity),
    last: () => moveCursor(Infinity),
    go: () => void goTo(),
    done: toggleDone,
    claude: startClaude,
    manual: startManual,
    retry: retryFiling,
    edit: startEdit,
    category: cycleCategory,
    type: cycleType,
    delete: startDelete,
    mark: toggleMark,
    'clear-marks': () => {
      marked.clear()
      draw()
    },
    handoff: startHandoff,
    only: () => {
      only = !only
      draw()
    },
    'show-done': () => {
      showDone = !showDone
      draw()
    },
  }
  actions[KEYS[key]]?.()
}

function onInput(data) {
  for (const event of ui.parseInput(data.toString('utf8'))) {
    if (event.mouse) onMouse(event.mouse)
    else onKey(event.key)
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
