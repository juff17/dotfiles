#!/usr/bin/env node
// The agent hub: every Claude session on the machine, as the H4 design draws
// it. Task agents sit in four lanes (Needs you, Working, Done, Idle) with the
// command each one is running; monitors (pr-babysit, logger) sit in a strip
// below, and one that needs you also raises a card in Needs you.
//   - Enter opens an agent's live session beside a list of the rest (a tmux
//     pane attached to its tab, or `claude attach` for a background one).
//   - n starts a new agent: a task in a new tab, a worktree or the
//     background, a PR babysitter or a log watcher.
// It runs in the hub window of the window's outer tmux (layout.conf), next to
// the rail. HUB_WIN is the Ghostty window number; GHOSTTY_CONF the config
// folder. State comes from agentd through client.mjs.

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { follow, markReviewed } from './client.mjs'
import { cardHeights, counts, lanes, launch, monitorsOf, scrollTo } from './model.mjs'
import { BOLD, ITALIC, MONITOR, P, STATE, ago, bar, bg, clean, enter, fg, leave, mix, paint, pill, render, split, tokens, width } from './term.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONF = process.env.GHOSTTY_CONF || dirname(HERE)
const WIN = Number(process.env.HUB_WIN) || 0
// Ghostty's own PATH may lack claude; bin/ghostty-hub finds it.
const CLAUDE = process.env.AGENT_HUB_CLAUDE || 'claude'
// AGENT_HUB_TABS_SOCKET points the hub at another tab server, for tests.
const TABS = ['-L', process.env.AGENT_HUB_TABS_SOCKET || 'ghostty']
const HOME = homedir()
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude')
const RECENTS = join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'agent-hub', 'recents.json')
const LANES = ['needs', 'working', 'done', 'idle']
// Below this width the lanes get too narrow to read, so the hub draws the
// list it shows beside an open session.
const MIN_BOARD_COLS = 96
// Rows the monitors tray keeps for monitors even when few or none run, so
// the board doesn't jump as monitors come and go. It grows past this, up to
// about a third of the screen, when more are running.
const MONITOR_ROWS = 5
// The fewest rows the lanes keep on a short screen, before the tray gives up
// its minimum.
const MIN_LANE_ROWS = 10
const LIST_COLS = 46

const run = (args, opts = {}) =>
  new Promise(resolve =>
    execFile(args[0], args.slice(1), { encoding: 'utf8', ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: stdout ?? '', err: (stderr || err?.message || '').trim() }),
    ),
  )
const outer = (...args) => run(['tmux', ...args])
const tabs = (...args) => run(['tmux', ...TABS, ...args])

// ------------------------------------------------------------ state

let agents = []
let focus = 0 // 0–3 a lane, 4 the monitors strip
const selected = { needs: null, working: null, done: null, idle: null, monitors: null } // ids
const scroll = { needs: 0, working: 0, done: 0, idle: 0, list: 0 }
let filter = ''
let filtering = false
let peek = null // { pane, id }
let listSel = null // id in the list beside an open session
let dialog = null
let confirm = null // { text, yes }
let note = null // { text, color, until }
let hits = [] // clickable regions of the last frame

const cols = () => process.stdout.columns || 120
const rows = () => process.stdout.rows || 40

function say(text, color = P.sub, ms = 5000) {
  note = { text, color, until: Date.now() + ms }
  draw()
}

function visible() {
  if (!filter) return agents
  const f = filter.toLowerCase()
  return agents.filter(a => `${a.title} ${a.repo} ${a.cmd} ${a.monitors.map(m => m.description).join(' ')}`.toLowerCase().includes(f))
}

const board = () => lanes(visible())
const strip = () => monitorsOf(visible())

function where(a) {
  if (a.pane) return a.pane.win === WIN || !a.pane.win ? `tab ${a.pane.tab}` : `w${a.pane.win} · tab ${a.pane.tab}`
  return a.kind === 'bg' ? 'bg' : 'terminal'
}

const kilo = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// The selected item of a lane, kept by id so it stays put as cards move.
function current(lane) {
  const list = lane === 'monitors' ? strip() : board()[lane]
  const key = x => (lane === 'monitors' ? x.key : x.id)
  let i = list.findIndex(x => key(x) === selected[lane])
  if (i < 0 && list.length) {
    i = 0
    selected[lane] = key(list[0])
  }
  return { list, i, item: list[i] ?? null }
}

function focused() {
  if (listMode()) return listItems().find(x => x.id === listSel)?.agent ?? null
  if (focus === 4) return current('monitors').item?.agent ?? null
  return current(LANES[focus]).item
}

const listMode = () => Boolean(peek) || cols() < MIN_BOARD_COLS

// ------------------------------------------------------------ board

const LANE_BG = bg(P.mantle)
const CARD_BG = bg(P.base)
const SEL_BG = bg(P.surface0)
const EMPTY = {
  needs: 'Nothing needs you',
  working: 'Nothing working',
  done: 'Nothing done',
  idle: 'Nothing idle',
  monitors: 'Nothing being monitored',
}

function hint(pairs) {
  return pairs.flatMap(([k, v], i) => [[`${i ? '  ' : ''}${k}`, fg(P.text)], [` ${v}`, fg(P.sub)]])
}

const tint = color => mix(color, P.mantle, 0.2)

// A header: a rounded bar tinted with its lane's color, the name on the left
// and the count in a solid chip on the right.
function header(look, count, w, extra = []) {
  return bar(
    [[` ${look.glyph} ${look.name}`, BOLD + fg(look.color)], ...extra],
    [[` ${count} `, BOLD + fg(P.crust) + bg(look.color)], [' ', '']],
    w,
    tint(look.color),
    P.mantle,
  )
}

// "Nothing …", centered, in an empty lane.
function empty(text, w) {
  const pad = Math.max(0, Math.floor((w - width(text)) / 2))
  return render([[`${' '.repeat(pad)}${text}`, ITALIC + fg(P.overlay1)]], w, LANE_BG)
}

function summary(c, width_) {
  const left = [
    [` ${c.needs + c.working + c.done + c.idle} tasks · ${c.monitors} monitor${c.monitors === 1 ? '' : 's'}   `, BOLD + fg(P.text)],
    [`▲ ${c.needs} need you`, BOLD + fg(P.peach)],
    [`  ✻ ${c.working} working`, fg(P.blue)],
    [`  ✓ ${c.done} done`, fg(P.green)],
    [`  ○ ${c.idle} idle`, fg(P.sub)],
    [`  ◉ ${c.watching} watching`, fg(P.teal)],
  ]
  const right = []
  if (filtering || filter) right.push([`/${filter}${filtering ? '▏' : ''}  `, fg(P.yellow)])
  right.push(...pill(' + New agent  n ', P.blue, P.base, BOLD + fg(P.crust)), [' ', ''])
  hits.push({ x1: width_ - 18, x2: width_, y1: 1, y2: 1, act: () => openDialog() })
  return split(left, right, width_)
}

// One lane as `h` rows of `w` cells.
function lane(name, w, h, laneIndex, x) {
  const look = STATE[name]
  const items = board()[name]
  const { i: sel } = current(name)
  const out = [header(look, items.length, w), render([], w, LANE_BG)]
  const room = h - 2
  const heights = cardHeights(name, items.length, room)
  const top = scrollTo(heights, room, focus === laneIndex ? sel : -1, scroll[name])
  scroll[name] = top
  if (top > 0) out.push(render([[` ▴ ${top} above`, fg(P.sub)]], w, LANE_BG))
  if (!items.length) out.push(render([], w, LANE_BG), empty(EMPTY[name], w))
  let i = top
  for (; i < items.length; i++) {
    const hgt = heights[i]
    const reserve = i < items.length - 1 ? 1 : 0
    if (out.length + hgt + reserve > h) break
    const y = out.length + 3
    const a = items[i]
    const on = focus === laneIndex && i === sel
    const id = a.id
    hits.push({ x1: x, x2: x + w - 1, y1: y, y2: y + hgt - 1, act: () => pick(laneIndex, id), wheel: laneIndex })
    out.push(...card(name, a, hgt, w, on))
  }
  const more = items.length - i
  while (out.length < h - (more > 0 ? 1 : 0)) out.push(render([], w, LANE_BG))
  // A card that ends on the lane's last row gives that row up to the cue, so
  // hidden cards are never hidden silently.
  if (more > 0) out.length = Math.min(out.length, h - 1)
  if (more > 0) out.push(render([[` ▾ ${more} more`, BOLD + fg(name === 'needs' ? P.peach : P.sub)]], w, LANE_BG))
  return out.slice(0, h)
}

// A card is a box with rounded corners: its title and where/age set in the
// top border, then its lines. The border sits on the lane's background and
// the inside on the card's, so the corners read as round.
function box(title, right, lines, w, border, fill) {
  const b = fg(border)
  const rw = right.reduce((n, [t]) => n + width(t), 0)
  const tw = Math.min(
    title.reduce((n, [t]) => n + width(t), 0),
    Math.max(4, w - 5 - rw),
  )
  const dashes = Math.max(1, w - 4 - tw - rw)
  const topRow =
    render([['╭─', b]], 2, LANE_BG) +
    render(title, tw, LANE_BG) +
    render([['─'.repeat(dashes), b]], dashes, LANE_BG) +
    render(right, Math.max(0, w - 4 - tw - dashes), LANE_BG) +
    render([['─╮', b]], 2, LANE_BG)
  const side = s => render([[s, b]], 1, LANE_BG)
  return [
    topRow,
    ...lines.map(spans => side('│') + render([[' '], ...spans], w - 2, fill) + side('│')),
    render([[`╰${'─'.repeat(Math.max(0, w - 2))}╯`, b]], w, LANE_BG),
  ]
}

function card(name, a, hgt, w, on) {
  // A card a monitor raised is named after what it watches.
  const raised = a.need === 'monitor' ? a.monitors.find(m => m.state === 'action') : null
  const title = [[` ${clean(raised ? `${raised.description} · ${a.repo}` : a.title)} `, BOLD + fg(on ? P.blue : P.text)]]
  const age = ago(name === 'working' ? a.stateSince : a.since)
  const cmd = clean(a.cmd)
  if (hgt === 1) {
    const fill = on ? SEL_BG : LANE_BG
    if (name === 'done')
      return [render([[on ? ' ▌' : '  ', fg(P.blue)], ['✓ ', fg(P.green)], [clean(a.title), fg(P.sub)], [` · ${cmd}`, fg(P.overlay1)]], w, fill)]
    return [split([[on ? ' ▌' : '  ', fg(P.blue)], [clean(a.title), BOLD + fg(P.text)], [`  ${where(a)}`, fg(P.sub)]], [[`${age} `, fg(P.sub)]], w, fill)]
  }
  const right = [[` ${where(a)} · ${age} `, fg(P.sub)]]
  const cmdColor = {
    needs: a.need === 'monitor' ? (/^\[(failed|error|crash|conflict)/.test(a.cmd) ? P.red : P.peach) : P.peach,
    working: P.blue,
    done: P.text,
    idle: P.sub,
  }[name]
  const toolAge = name === 'working' && a.cmd !== 'Thinking…' ? ` ${ago(a.since)}` : ''
  const lines = [[[cmd, fg(cmdColor)], [toolAge, fg(P.sub)]]]
  if (hgt >= 4) {
    if (name === 'needs')
      lines.push(
        a.need === 'monitor'
          ? [[`◉ from monitor · ${raised?.kind ?? 'monitor'}`, fg(P.teal)]]
          : a.need === 'permission'
            ? hint([['a', 'allow'], ['d', 'deny'], ['↵', 'open']])
            : hint([['↵', a.need === 'question' ? 'answer' : 'open']]),
      )
    else lines.push([[[a.branch && `⎇ ${a.branch}`, a.ctx && `ctx ${kilo(a.ctx)}`].filter(Boolean).join(' · '), fg(P.sub)]])
  }
  const border = on ? P.blue : a.need === 'monitor' ? P.teal : P.surface1
  return box(title, right, lines, w, border, on ? SEL_BG : CARD_BG)
}

function monitorRows(w, h, y0) {
  const list = strip()
  const { i: sel } = current('monitors')
  const look = { glyph: '◉', color: P.teal, name: 'Monitors' }
  const out = [header(look, list.length, w, [['   stay put, raise a card in Needs you when needed', fg(P.sub)]]), render([], w, LANE_BG)]
  if (!list.length) out.push(empty(`${EMPTY.monitors} · n → Babysit a PR or Watch logs`, w))
  // Like the lanes, a full tray says how many it hides.
  const space = h - out.length
  const room = list.length > space ? space - 1 : space
  const top = Math.max(0, Math.min(sel - room + 1, list.length - room))
  list.slice(top, top + room).forEach((m, k) => {
    const i = top + k
    const on = focus === 4 && i === sel
    const fill = on ? SEL_BG : LANE_BG
    const mlook = MONITOR[m.state]
    const ev = m.event
    const tagColor = !ev ? P.sub : /failed|error|crash|conflict|stuck|manual/.test(ev.tag) ? P.red : /comment|review/.test(ev.tag) ? P.mauve : P.teal
    const stateCol = render([[on ? ' ▌' : '  ', fg(P.blue)], [`${mlook.glyph} ${mlook.name}`, BOLD + fg(mlook.color)]], 18, fill)
    const target = render([[clean(m.description), BOLD + fg(P.text)]], 34, fill)
    const owner = render([[` ${m.agent.repo} · ${m.kind}`, fg(P.sub)]], 24, fill)
    const when = m.ended ? m.ended.reason : ev ? ago(ev.at) : ago(m.startedAt)
    const event = split(
      [...(m.busy ? [['✻ ', fg(P.blue)]] : []), ...(ev ? [[clean(ev.line), fg(tagColor)]] : [['waiting for its first event', fg(P.overlay1)]])],
      [[` ${when} `, fg(m.state === 'stale' ? P.peach : P.sub)]],
      w - 18 - 34 - 24,
      fill,
    )
    const key = m.key
    hits.push({ x1: 1, x2: w, y1: y0 + out.length, y2: y0 + out.length, act: () => pickMonitor(key) })
    out.push(stateCol + target + owner + event)
  })
  const hidden = list.length - top - room
  if (top > 0 || hidden > 0)
    out.push(render([[`  ${top > 0 ? `▴ ${top} above  ` : ''}${hidden > 0 ? `▾ ${hidden} more` : ''}  tab, then j/k`, BOLD + fg(P.sub)]], w, LANE_BG))
  while (out.length < h) out.push(render([], w, LANE_BG))
  return out.slice(0, h)
}

function footer(w) {
  if (note && note.until > Date.now()) return render([[` ${note.text}`, fg(note.color)]], w)
  if (confirm) return render([[` ${confirm.text} `, BOLD + fg(P.peach)], ['y', fg(P.text)], [' yes  ', fg(P.sub)], ['n', fg(P.text)], [' no', fg(P.sub)]], w)
  const keys = listMode()
    ? [['j/k', 'move'], ['↵', 'open'], ['esc', peek ? 'close session' : 'workspace'], ['a/d', 'allow/deny'], ['n', 'new']]
    : [['h/l', 'lane'], ['j/k', 'agent'], ['tab', 'monitors'], ['↵', 'open'], ['a/d', 'allow/deny'], ['e', 'reviewed'], ['o', 'go to tab'], ['x', 'close'], ['n', 'new'], ['/', 'filter']]
  return render([[' '], ...hint(keys)], w)
}

function drawBoard() {
  const W = cols()
  const H = rows()
  const c = counts(visible())
  const lines = [summary(c, W), render([], W)]
  const mons = strip().length
  // The tray's header and the row under it, then its rows: at least
  // MONITOR_ROWS, more with more monitors, up to about a third of the screen;
  // on a short screen the lanes keep MIN_LANE_ROWS first.
  const most = Math.max(MONITOR_ROWS, Math.floor(H / 3) - 2)
  const fit = Math.max(1, H - 4 - MIN_LANE_ROWS - 2)
  const stripH = 2 + Math.min(Math.min(Math.max(mons, MONITOR_ROWS), most), fit)
  const laneH = Math.max(6, H - 2 - stripH - 2)
  const gap = 2
  const w = Math.floor((W - 3 * gap) / 4)
  const cols_ = LANES.map((name, i) => lane(name, i === 3 ? W - 3 * (w + gap) : w, laneH, i, 1 + i * (w + gap)))
  for (let r = 0; r < laneH; r++) lines.push(cols_.map(c => c[r]).join(' '.repeat(gap)))
  lines.push(render([], W))
  lines.push(...monitorRows(W, stripH, lines.length + 1))
  lines.push(footer(W))
  return lines.slice(0, H)
}

// ------------------------------------------------------------ list

// The board as one column, beside an open session: a group per lane, then
// the monitors, each with a tinted header, a line saying so when it's empty,
// and a row of space before the next.
function listItems() {
  const l = board()
  const items = []
  const group = (name, list, toItem) => {
    if (items.length) items.push({ spacer: true })
    items.push({ group: name, count: list.length })
    if (!list.length) items.push({ empty: name })
    for (const x of list) items.push(toItem(x))
  }
  for (const name of LANES) group(name, l[name], a => ({ id: a.id, agent: a, lane: name }))
  group('monitors', strip(), m => ({ id: `m:${m.key}`, agent: m.agent, monitor: m }))
  return items
}

function drawList() {
  const W = cols()
  const H = rows()
  const lines = [
    split(
      [[peek ? ' ◂ board ' : ' agents ', BOLD + fg(P.blue)], [peek ? 'ctrl+]' : '', fg(P.sub)]],
      [...pill(' + New ', P.blue, P.base, BOLD + fg(P.crust)), [' ', '']],
      W,
    ),
    render([], W),
  ]
  hits.push({ x1: W - 9, x2: W, y1: 1, y2: 1, act: () => openDialog() })
  hits.push({ x1: 1, x2: 12, y1: 1, y2: 1, act: () => closePeek() })
  const items = listItems()
  const pickable = items.filter(x => x.id)
  if (!pickable.some(x => x.id === listSel)) listSel = (pickable.find(x => x.agent.id === peek?.id) ?? pickable[0])?.id ?? null
  const sel = items.findIndex(x => x.id === listSel)
  const room = H - 3
  if (sel >= 0) {
    if (sel < scroll.list) scroll.list = sel
    if (sel >= scroll.list + room) scroll.list = sel - room + 1
  }
  for (const it of items.slice(scroll.list, scroll.list + room)) {
    const y = lines.length + 1
    if (it.spacer) {
      lines.push(render([], W))
      continue
    }
    if (it.group) {
      const look = it.group === 'monitors' ? { glyph: '◉', color: P.teal, name: 'Monitors' } : STATE[it.group]
      lines.push(header(look, it.count, W))
      continue
    }
    if (it.empty) {
      lines.push(render([[`   ${EMPTY[it.empty]}`, ITALIC + fg(P.overlay1)]], W))
      continue
    }
    const on = it.id === listSel
    const open = peek && it.agent.id === peek.id && !it.monitor
    const fill = on ? SEL_BG : ''
    const head = it.monitor
      ? [[` ${MONITOR[it.monitor.state].glyph} `, fg(MONITOR[it.monitor.state].color)], [clean(it.monitor.description), BOLD + fg(P.text)]]
      : [[open ? ' ▶ ' : '   ', fg(P.blue)], [clean(it.agent.title), BOLD + fg(P.text)], [` ${clean(it.agent.cmd)}`, fg(P.sub)]]
    const id = it.id
    hits.push({ x1: 1, x2: W, y1: y, y2: y, act: () => ((listSel = id), openSession(it.agent)) })
    lines.push(split(head, [[` ${ago(it.monitor ? (it.monitor.event?.at ?? it.monitor.startedAt) : it.agent.since)} `, fg(P.sub)]], W, fill))
  }
  while (lines.length < H - 1) lines.push(render([], W))
  lines.push(footer(W))
  return lines.slice(0, H)
}

// ------------------------------------------------------------ dialog

const KINDS = [
  { id: 'task', glyph: '✻', color: P.blue, label: 'Task', sub: 'a worker with a prompt' },
  { id: 'pr', glyph: '◉', color: P.teal, label: 'Babysit a PR', sub: 'monitor until it merges' },
  { id: 'logs', glyph: '◉', color: P.teal, label: 'Watch logs', sub: 'monitor a service' },
]
const RUN_AS = [
  { id: 'tab', label: 'New tab', sub: 'in this window' },
  { id: 'worktree', label: 'Worktree + new tab', sub: 'on its own branch' },
  { id: 'bg', label: 'Background', sub: 'no tab; lives in the hub' },
]
const CHOICES = {
  model: ['default', 'opus', 'sonnet', 'haiku'],
  mode: ['default', 'auto', 'acceptEdits', 'plan'],
  effort: ['default', 'low', 'medium', 'high', 'xhigh'],
}

function recents() {
  let saved = []
  try {
    saved = JSON.parse(readFileSync(RECENTS, 'utf8'))
  } catch {}
  const roots = agents.map(a => {
    const m = a.cwd.match(/^(.*)\/\.claude\/worktrees\//)
    return m ? m[1] : a.cwd
  })
  return [...new Set([...saved, ...roots])].filter(p => p && p !== HOME).slice(0, 8)
}

function remember(dir) {
  const list = [dir, ...recents().filter(d => d !== dir)].slice(0, 12)
  try {
    mkdirSync(dirname(RECENTS), { recursive: true })
    writeFileSync(RECENTS, JSON.stringify(list))
  } catch {}
}

const tilde = p => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)
const expand = p => (p.startsWith('~') ? HOME + p.slice(1) : p)

function openDialog() {
  const r = recents()
  const base = focused()?.cwd ?? r[0] ?? join(HOME, 'projects')
  const root = base.match(/^(.*)\/\.claude\/worktrees\//)?.[1] ?? base
  dialog = {
    kind: 0,
    runAs: 0,
    model: 0,
    mode: 0,
    effort: 0,
    recent: Math.max(0, r.indexOf(root)),
    field: 'prompt',
    folder: { text: tilde(root), at: tilde(root).length },
    prompt: { text: '', at: 0 },
    target: { text: '', at: 0 },
    busy: false,
  }
  draw()
}

function fields() {
  const k = KINDS[dialog.kind].id
  return ['kind', 'folder', 'recent', k === 'task' ? 'prompt' : 'target', ...(k === 'task' ? ['runAs'] : []), 'model', 'mode', 'effort', 'start']
}

function input(field, w, on) {
  const { text, at } = dialog[field]
  const shown = clean(text)
  if (!on) return render([[shown || ' ', fg(P.text)]], w)
  // Keep the cursor in view on a long line.
  const start = Math.max(0, at - w + 2)
  const before = shown.slice(start, at)
  const cur = shown[at] ?? ' '
  const after = shown.slice(at + 1)
  return render([[before, fg(P.text)], [cur, '\x1b[7m'], [after, fg(P.text)]], w)
}

function drawDialog(base) {
  const W = cols()
  const H = rows()
  const w = Math.min(84, W - 4)
  const d = dialog
  const kind = KINDS[d.kind].id
  const body = []
  const label = (name, f) => [[` ${name.padEnd(9)}`, fg(d.field === f ? P.blue : P.sub)]]
  const row = (f, spans) => body.push({ f, line: spans })
  row(null, [[' New agent', BOLD + fg(P.blue)]])
  row(null, [])
  row('kind', [
    ...label('Kind', 'kind'),
    ...KINDS.flatMap((x, i) => [
      [` ${i === d.kind ? '●' : '○'} `, fg(x.color)],
      [x.label, i === d.kind ? BOLD + fg(P.text) : fg(P.sub)],
      ['  ', ''],
    ]),
  ])
  row(null, [[`            ${KINDS[d.kind].sub}`, fg(P.overlay1)]])
  row('folder', [...label('Folder', 'folder'), [' ', ''], { input: 'folder' }])
  const r = recents()
  row('recent', [
    ...label('Recent', 'recent'),
    ...r.flatMap((p, i) => [[` ${p.split('/').pop()} `, i === d.recent && d.field === 'recent' ? fg(P.crust) + bg(P.blue) : fg(P.text) + bg(P.surface0)], [' ', '']]),
  ])
  row(null, [])
  if (kind === 'task') row('prompt', [...label('Task', 'prompt'), [' ', ''], { input: 'prompt' }])
  else row('target', [...label(kind === 'pr' ? 'PR link' : 'Watch', 'target'), [' ', ''], { input: 'target' }])
  if (kind === 'pr') row(null, [['            starts /pr-babysit in the background; it lands in Monitors', fg(P.overlay1)]])
  if (kind === 'logs') row(null, [['            a command or service, e.g. docker compose logs api; runs /logger', fg(P.overlay1)]])
  if (kind === 'task') {
    row(null, [])
    row('runAs', [
      ...label('Run as', 'runAs'),
      ...RUN_AS.flatMap((x, i) => [[` ${i === d.runAs ? '●' : '○'} `, fg(P.blue)], [x.label, i === d.runAs ? BOLD + fg(P.text) : fg(P.sub)], [' ', '']]),
    ])
    row(null, [[`            ${RUN_AS[d.runAs].sub}`, fg(P.overlay1)]])
  }
  row(null, [])
  for (const f of ['model', 'mode', 'effort'])
    row(f, [...label(f[0].toUpperCase() + f.slice(1), f), [` ‹ ${CHOICES[f][d[f]]} › `, d.field === f ? fg(P.text) + bg(P.surface0) : fg(P.text)]])
  row(null, [])
  const lands =
    kind !== 'task' ? 'lands in Monitors, as a background session' : RUN_AS[d.runAs].id === 'bg' ? 'lands in Working, no tab' : 'opens its session here'
  row('start', [
    ['  ', ''],
    [d.busy ? ' Starting… ' : ' Start ', BOLD + (d.field === 'start' ? fg(P.crust) + bg(P.blue) : fg(P.blue) + bg(P.surface0))],
    ['  ctrl+s', fg(P.sub)],
    [`   ${lands}`, fg(P.overlay1)],
  ])
  row(null, [[' ↑/↓ field  ←/→ choose  tab complete folder  esc cancel', fg(P.overlay1)]])
  const h = body.length + 2
  const x0 = Math.floor((W - w) / 2)
  const y0 = Math.max(0, Math.floor((H - h) / 2))
  const box = bg(P.base)
  const lines = [...base]
  const edge = fg(P.blue)
  lines[y0] = place(lines[y0], x0, `${edge}╭${'─'.repeat(w - 2)}╮\x1b[0m`, w)
  body.forEach((b, i) => {
    const spans = b.line.flatMap(s => (s.input ? [] : [s]))
    const inp = b.line.find(s => s.input)
    let inner
    if (inp) {
      const lw = spans.reduce((n, [t]) => n + width(t), 0)
      inner = render(spans, lw, box) + input(inp.input, w - 2 - lw - 1, d.field === b.f) + render([], 1, box)
    } else inner = render(spans, w - 2, box)
    const y = y0 + 1 + i
    if (b.f) hits.push({ x1: x0 + 1, x2: x0 + w, y1: y + 1, y2: y + 1, act: () => ((d.field = b.f), b.f === 'start' && start(), draw()) })
    lines[y] = place(lines[y], x0, `${edge}│\x1b[0m${inner}${edge}│\x1b[0m`, w)
  })
  lines[y0 + h - 1] = place(lines[y0 + h - 1], x0, `${edge}╰${'─'.repeat(w - 2)}╯\x1b[0m`, w)
  return lines
}

// Puts `piece` (w cells) on a row at column x0. The rest of a row the dialog
// covers is left blank rather than spliced from the board behind, since
// cutting styled text by cells is fiddly and none of it needs reading.
function place(_line, x0, piece, w) {
  return `\x1b[0m${fg(P.surface1)}${' '.repeat(x0)}\x1b[0m${piece}${' '.repeat(Math.max(0, cols() - x0 - w))}`
}

function dialogKey(key, paste) {
  const d = dialog
  const fs = fields()
  const at = fs.indexOf(d.field)
  const move = n => (d.field = fs[Math.min(fs.length - 1, Math.max(0, at + n))])
  if (paste !== undefined) {
    if (['folder', 'prompt', 'target'].includes(d.field)) insert(d[d.field], paste.replace(/\s*\n\s*/g, ' '))
    return
  }
  const text = ['folder', 'prompt', 'target'].includes(d.field) ? d[d.field] : null
  const choice = { kind: [KINDS.length, 'kind'], runAs: [RUN_AS.length, 'runAs'], recent: [recents().length, 'recent'] }[d.field] ??
    (CHOICES[d.field] ? [CHOICES[d.field].length, d.field] : null)
  if (key === '\x1b') return (dialog = null)
  if (key === '\x13') return start()
  if (key === '\x1b[A' || key === '\x1b[Z') return move(-1)
  if (key === '\x1b[B') return move(1)
  if (key === '\r') return d.field === 'start' ? start() : move(1)
  if (key === '\t') {
    if (d.field === 'folder') return complete()
    return move(1)
  }
  if (choice && (key === '\x1b[C' || key === '\x1b[D' || key === ' ')) {
    const [n, prop] = choice
    if (!n) return
    d[prop] = (d[prop] + (key === '\x1b[D' ? n - 1 : 1)) % n
    if (prop === 'recent') {
      const p = tilde(recents()[d.recent] ?? '')
      d.folder = { text: p, at: p.length }
    }
    if (prop === 'kind' && !fields().includes(d.field)) d.field = 'kind'
    return
  }
  if (!text) return
  if (key === '\x1b[D') text.at = Math.max(0, text.at - 1)
  else if (key === '\x1b[C') text.at = Math.min(text.text.length, text.at + 1)
  else if (key === '\x1b[H' || key === '\x01') text.at = 0
  else if (key === '\x1b[F' || key === '\x05') text.at = text.text.length
  else if (key === '\x7f' || key === '\b') {
    if (text.at > 0) {
      text.text = text.text.slice(0, text.at - 1) + text.text.slice(text.at)
      text.at--
    }
  } else if (key === '\x15') {
    text.text = text.text.slice(text.at)
    text.at = 0
  } else if (key === '\x17') {
    const head = text.text.slice(0, text.at).replace(/\S+\s*$/, '')
    text.text = head + text.text.slice(text.at)
    text.at = head.length
  } else if (key.length >= 1 && !key.startsWith('\x1b') && key >= ' ') insert(text, key)
}

function insert(text, s) {
  const c = clean(s)
  text.text = text.text.slice(0, text.at) + c + text.text.slice(text.at)
  text.at += c.length
}

// Tab in Folder: the longest common start of the folders that match.
function complete() {
  const f = dialog.folder
  const full = expand(f.text)
  const dir = full.endsWith('/') ? full : dirname(full)
  const part = full.endsWith('/') ? '' : full.slice(dir.length + (dir.endsWith('/') ? 0 : 1))
  let names = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(part) && (part.startsWith('.') || !e.name.startsWith('.')))
      .map(e => e.name)
  } catch {}
  if (!names.length) return
  let common = names[0]
  for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1)
  const next = tilde(join(dir, common)) + (names.length === 1 ? '/' : '')
  dialog.folder = { text: next, at: next.length }
}

async function start() {
  const d = dialog
  if (!d || d.busy) return
  const kind = KINDS[d.kind].id
  const cwd = expand(d.folder.text.trim()).replace(/\/+$/, '') || HOME
  try {
    if (!statSync(cwd).isDirectory()) throw new Error()
  } catch {
    d.field = 'folder'
    return say(`No folder ${tilde(cwd)}`, P.red)
  }
  const spec = {
    kind,
    cwd,
    prompt: d.prompt.text,
    target: d.target.text,
    runAs: RUN_AS[d.runAs].id,
    model: CHOICES.model[d.model],
    mode: CHOICES.mode[d.mode],
    effort: CHOICES.effort[d.effort],
  }
  if (kind === 'task' && !spec.prompt.trim()) {
    d.field = 'prompt'
    return say('Give the task a first prompt', P.peach)
  }
  if (kind !== 'task' && !spec.target.trim()) {
    d.field = 'target'
    return say(kind === 'pr' ? 'Paste the PR or MR link' : 'Say what to watch', P.peach)
  }
  const plan = launch(spec)
  d.busy = true
  draw()
  remember(cwd)
  if (plan.where === 'bg') {
    const child = spawn(CLAUDE, plan.argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let outText = ''
    child.stdout.on('data', b => (outText += b))
    child.stderr.on('data', b => (outText += b))
    child.on('error', err => say(`Couldn't start claude: ${err.message}`, P.red))
    child.on('close', code => {
      dialog = null
      say(code === 0 ? `Started ${plan.name} in the background ${clean(outText).trim().slice(0, 60)}` : `claude --bg failed: ${clean(outText).trim().slice(0, 120)}`, code === 0 ? P.green : P.red, 8000)
    })
    child.unref()
    return
  }
  const session = WIN ? `ghostty-${WIN}` : null
  if (!session) {
    d.busy = false
    return say('Not in a Ghostty layout window, so there is no tab session to open a tab in', P.red)
  }
  const made = await tabs('new-window', '-d', '-t', `${session}:`, '-c', cwd, '-P', '-F', '#{window_id} #{pane_id}')
  if (!made.ok) {
    d.busy = false
    return say(`Couldn't open a tab: ${made.err}`, P.red)
  }
  const [window, pane] = made.out.trim().split(' ')
  // The shell reads this once its prompt is up; typing it rather than running
  // claude as the tab's command keeps the shell when Claude exits.
  await tabs('send-keys', '-t', pane, '-l', plan.line)
  await tabs('send-keys', '-t', pane, 'Enter')
  dialog = null
  await openSession({ id: `new:${pane}`, title: plan.name, pane: { session, window, pane, win: WIN } })
}

// ------------------------------------------------------------ actions

function pick(laneIndex, id) {
  const name = LANES[laneIndex]
  if (focus === laneIndex && selected[name] === id) {
    const a = board()[name].find(x => x.id === id)
    if (a) return openSession(a)
  }
  focus = laneIndex
  selected[name] = id
}

function pickMonitor(key) {
  if (focus === 4 && selected.monitors === key) {
    const m = strip().find(x => x.key === key)
    if (m) return openSession(m.agent)
  }
  focus = 4
  selected.monitors = key
}

function moveLane(n) {
  focus = (focus + n + 5) % 5
}

function moveIn(n) {
  if (listMode()) {
    const items = listItems().filter(x => x.id)
    const i = items.findIndex(x => x.id === listSel)
    listSel = items[Math.min(items.length - 1, Math.max(0, i + n))]?.id ?? null
    return
  }
  const name = focus === 4 ? 'monitors' : LANES[focus]
  const { list, i } = current(name)
  const next = list[Math.min(list.length - 1, Math.max(0, i + n))]
  if (next) selected[name] = name === 'monitors' ? next.key : next.id
}

// Opens a's session beside the list: a pane in this window that attaches to
// the agent's tmux tab through its own grouped session, so looking at a tab
// here doesn't switch tabs in the workspace. A background agent opens with
// `claude attach`.
let opening = false

async function openSession(a) {
  if (!a || opening) return
  opening = true
  try {
    await open(a)
  } finally {
    opening = false
  }
}

async function open(a) {
  if (!process.env.TMUX) return say('The hub is not running in tmux, so it has nowhere to open a session', P.red)
  let cmd
  const bin = join(CONF, 'bin', 'ghostty-hub')
  if (a.pane?.session && a.pane.window) cmd = `${bin} peek ${a.pane.session} ${a.pane.window}`
  else if (a.jobId) cmd = `${bin} attach ${a.jobId}`
  else return say(`${a.title} runs outside the layout's tabs, so it can't be opened here`, P.peach)
  if (a.id && !a.id.startsWith('new:')) markReviewed(a.id)
  if (peek && (await paneAlive(peek.pane))) {
    await outer('respawn-pane', '-k', '-t', peek.pane, cmd)
    await outer('select-pane', '-t', peek.pane)
    peek.id = a.id
    peek.window = a.pane?.window ?? null
  } else {
    const size = Math.max(20, cols() - LIST_COLS - 1)
    const made = await outer('split-window', '-h', '-t', process.env.TMUX_PANE, '-l', String(size), '-P', '-F', '#{pane_id}', cmd)
    if (!made.ok) return say(`Couldn't open the session: ${made.err}`, P.red)
    peek = { pane: made.out.trim(), id: a.id, window: a.pane?.window ?? null }
    await outer('set', '-p', '-t', peek.pane, '@peek', '1')
  }
  listSel = a.id
  draw()
}

// tmux display exits 0 with empty output for a pane that's gone, so the
// answer is whether it names the pane.
async function paneAlive(id) {
  return (await outer('display', '-p', '-t', id, '#{pane_id}')).out.trim() === id
}

async function closePeek() {
  if (!peek) return
  const p = peek.pane
  peek = null
  await outer('kill-pane', '-t', p)
  draw()
}

// a and d answer a permission prompt by pressing its keys in the agent's
// pane: 1 for Yes, Esc for No. Only while Claude says it's waiting right now
// and the dialog's first choice is at the bottom of its screen, so a key
// never lands in Claude's input box or cancels a running turn because the
// board was a second old.
async function answer(allow) {
  const a = focused()
  if (!a || a.need !== 'permission') return say('a and d answer permission prompts', P.sub)
  if (!a.pane) return say('Open a background session (↵) to answer it', P.peach)
  let waiting = false
  try {
    waiting = JSON.parse(readFileSync(join(CLAUDE_DIR, 'sessions', `${a.pid}.json`), 'utf8')).status === 'waiting'
  } catch {}
  const screen = await tabs('capture-pane', '-p', '-t', a.pane.pane)
  const bottom = screen.out.split('\n').filter(l => l.trim()).slice(-15).join('\n')
  if (!waiting || !/❯\s*1\.\s*Yes/.test(bottom)) return say(`${a.title} isn't showing a permission prompt right now`, P.peach)
  await tabs('send-keys', '-t', a.pane.pane, allow ? '1' : 'Escape')
  say(`${allow ? 'Allowed' : 'Denied'} ${a.cmd.replace(/^Allow |\?$/g, '')}`, allow ? P.green : P.peach)
}

async function goToTab() {
  const a = focused()
  if (!a?.pane) return say('Only tab agents have a tab to go to', P.sub)
  // By session as well: a bare window id picks whichever session used it last,
  // which can be the hub's own peek session.
  await tabs('select-window', '-t', `${a.pane.session}:${a.pane.window}`)
  if (a.pane.win === WIN || !WIN) await outer('select-window', '-t', `layout-${WIN}:work`)
  else say(`Switched ${a.title}'s tab in Ghostty window ${a.pane.win}`, P.sub)
}

function closeAgent() {
  const a = focused()
  if (!a) return
  if (a.state === 'working' || a.state === 'needs') return say('Only Done and Idle agents close from here', P.sub)
  if (a.pane)
    confirm = {
      text: `Close ${where(a)} (${a.title})?`,
      yes: () => tabs('kill-window', '-t', a.pane.window),
    }
  else if (a.jobId) confirm = { text: `Stop background agent ${a.title}?`, yes: () => run([CLAUDE, 'stop', a.jobId]) }
}

function onKey(key) {
  if (confirm) {
    const c = confirm
    confirm = null
    if (key === 'y') void c.yes()
    return
  }
  if (filtering) {
    if (key === '\r' || key === '\x1b') filtering = key === '\r' ? false : ((filter = ''), false)
    else if (key === '\x7f') filter = filter.slice(0, -1)
    else if (key >= ' ' && !key.startsWith('\x1b')) filter += key
    return
  }
  const actions = {
    h: () => moveLane(-1),
    l: () => moveLane(1),
    '\x1b[D': () => moveLane(-1),
    '\x1b[C': () => moveLane(1),
    j: () => moveIn(1),
    k: () => moveIn(-1),
    '\x1b[B': () => moveIn(1),
    '\x1b[A': () => moveIn(-1),
    '\t': () => (focus = focus === 4 ? 0 : 4),
    '\r': () => openSession(focused()),
    a: () => answer(true),
    d: () => answer(false),
    e: () => {
      const a = focused()
      if (a?.state === 'done') markReviewed(a.id)
    },
    E: () => board().done.forEach(a => markReviewed(a.id)),
    o: () => goToTab(),
    x: () => closeAgent(),
    n: () => openDialog(),
    '/': () => ((filtering = true), (filter = '')),
    '\x1b': () => (peek ? closePeek() : outer('select-window', '-t', `layout-${WIN}:work`)),
    q: () => outer('select-window', '-t', `layout-${WIN}:work`),
  }
  void actions[key]?.()
}

function onMouse({ button, x, y, up }) {
  if (button & 64) {
    const h = hits.find(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2 && r.wheel !== undefined)
    if (h) focus = h.wheel
    return moveIn(button & 1 ? 1 : -1)
  }
  if (up || (button & 3) !== 0 || button & 32) return
  const h = hits.find(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2)
  void h?.act()
}

// ------------------------------------------------------------ main

function draw() {
  hits = []
  let lines = listMode() ? drawList() : drawBoard()
  if (dialog) {
    hits = []
    lines = drawDialog(lines)
  }
  paint(lines)
}

// Follows the open session: drops it once its pane is gone, and when you
// switch tabs in it (its tab bar, or the tab keys), moves the list's ▶ and
// selection to the agent in the tab it now shows.
async function watchPeek() {
  if (!peek) return
  const p = peek
  if (!(await paneAlive(p.pane))) {
    if (peek === p) peek = null
    return draw()
  }
  if (!p.window) return
  const name = `peek-${p.pane.slice(1)}`
  const [session, win] = (await tabs('display', '-p', '-t', `=${name}:`, '#{session_name} #{window_id}')).out.trim().split(' ')
  if (peek !== p || session !== name || !win || win === p.window) return
  p.window = win
  const a = agents.find(x => x.pane?.window === win)
  p.id = a?.id ?? null
  if (a) listSel = a.id
  draw()
}

if (!process.stdin.isTTY) {
  console.error('hub.mjs needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.mouse) {
      if (dialog && !t.mouse.up && !(t.mouse.button & 64)) {
        const h = hits.find(r => t.mouse.x >= r.x1 && t.mouse.x <= r.x2 && t.mouse.y >= r.y1 && t.mouse.y <= r.y2)
        void h?.act()
      } else if (!dialog) onMouse(t.mouse)
    } else if (dialog) dialogKey(t.key ?? '', t.paste)
    else if (t.key) onKey(t.key)
  }
  draw()
})
// After the new size is read; a SIGWINCH handler can run before that.
process.stdout.on('resize', draw)
const bye = () => {
  leave()
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGHUP', bye)
enter()
follow(s => {
  agents = s.agents ?? []
  draw()
})
draw()
setInterval(draw, 1000)
setInterval(() => void watchPeek(), 400)
