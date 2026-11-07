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
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUN, follow, markReviewed } from './client.mjs'
import { HUB_OPEN } from './tray.mjs'
import { cardHeights, counts, lanes, launch, monitorProcess, monitorsOf, scrollTo } from './model.mjs'
import { POPUP } from './newagent.mjs'
import { BOLD, CAP_L, CAP_R, ITALIC, MONITOR, P, STATE, ago, bar, bg, clean, enter, fg, leave, mix, paint, pill, render, split, tokens, width } from './term.mjs'

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
// Choices that outlive the hub and a reboot, such as questions you said not
// to ask again: state, not cache or the runtime folder, which a reboot clears.
const PREFS = join(process.env.XDG_STATE_HOME || join(HOME, '.local', 'state'), 'agent-hub', 'prefs.json')
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
// What Alt+N (layout.conf) and the rail's + new send the hub to open New
// agent, whatever it's in the middle of.
const NEW_AGENT_KEY = '\x1b[9100~'
// What Ctrl+Shift+B and Ctrl+] send just before they close the open session,
// so the hub draws the board, not the list, once its pane widens.
const PEEK_CLOSING_KEY = '\x1b[9101~'
// What the tray sends to have the hub open an agent's session, after writing
// the agent's id to HUB_OPEN (tray.mjs): a background agent has no tab to go to.
const OPEN_AGENT_KEY = '\x1b[9102~'

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
let confirm = null // { text, yes, skip }: skip names a question you can stop being asked
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

// The monitor selected in the strip, or in the list beside an open session.
function focusedMonitor() {
  if (listMode()) return listItems().find(x => x.id === listSel)?.monitor ?? null
  return focus === 4 ? current('monitors').item : null
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

// The New agent button: a solid blue pill with its global key in it, and a
// space after; `cells` is how wide that all is, for its click area.
function newButton(label) {
  const spans = [
    [CAP_L, fg(P.blue) + bg(P.base)],
    [label, BOLD + fg(P.crust) + bg(P.blue)],
    ['alt+n ', fg(P.surface1) + bg(P.blue)],
    [CAP_R, fg(P.blue) + bg(P.base)],
    [' ', ''],
  ]
  return { spans, cells: spans.reduce((n, [t]) => n + width(t), 0) }
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

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
    [` ${plural(c.needs + c.working + c.done + c.idle, 'task')} · ${plural(c.monitors, 'monitor')}   `, BOLD + fg(P.text)],
    [`▲ ${c.needs} need you`, BOLD + fg(P.peach)],
    [`  ✻ ${c.working} working`, fg(P.blue)],
    [`  ✓ ${c.done} done`, fg(P.green)],
    [`  ○ ${c.idle} idle`, fg(P.sub)],
    [`  ◉ ${c.watching} watching`, fg(P.teal)],
  ]
  const right = []
  if (filtering || filter) right.push([`/${filter}${filtering ? '▏' : ''}  `, fg(P.yellow)])
  const button = newButton(' + New agent  ')
  right.push(...button.spans)
  hits.push({ x1: width_ - button.cells + 1, x2: width_, y1: 1, y2: 1, act: () => openDialog() })
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
    // A line is its spans, or { left, right } with right set flush right.
    ...lines.map(
      l => side('│') + (Array.isArray(l) ? render([[' '], ...l], w - 2, fill) : split([[' '], ...l.left], [...l.right, [' ', '']], w - 2, fill)) + side('│'),
    ),
    render([[`╰${'─'.repeat(Math.max(0, w - 2))}╯`, b]], w, LANE_BG),
  ]
}

// A card leads with where the agent runs, its repo and branch (or worktree),
// in the top border; its name takes the first line and what it's doing the
// second, with its context size or the keys that answer it on the right.
function card(name, a, hgt, w, on) {
  // A card a monitor raised is named after what it watches.
  const raised = a.need === 'monitor' ? a.monitors.find(m => m.state === 'action') : null
  const label = clean(raised ? raised.description : a.title)
  const place = a.worktree ? ` ⑂ ${a.worktree}` : a.branch ? ` ⎇ ${a.branch}` : ''
  const age = ago(name === 'working' ? a.stateSince : a.since)
  const cmd = clean(a.cmd)
  if (hgt === 1) {
    const fill = on ? SEL_BG : LANE_BG
    const done = name === 'done'
    return [
      split(
        [[on ? ' ▌' : '  ', fg(P.blue)], ...(done ? [['✓ ', fg(P.green)]] : []), [clean(a.repo), fg(P.sub)], [` ${label}`, (done ? '' : BOLD) + fg(P.text)]],
        [[done ? `  ${age} ` : `  ${where(a)} · ${age} `, fg(P.sub)]],
        w,
        fill,
      ),
    ]
  }
  const title = [[` ${clean(a.repo)}`, BOLD + fg(on ? P.blue : P.text)], [`${clean(place)} `, fg(P.sub)]]
  const right = [[` ${where(a)} · ${age} `, fg(P.sub)]]
  const cmdColor = {
    needs: a.need === 'monitor' ? (/^\[(failed|error|crash|conflict)/.test(a.cmd) ? P.red : P.peach) : P.peach,
    working: P.blue,
    done: P.text,
    idle: P.sub,
  }[name]
  const toolAge = name === 'working' && a.cmd !== 'Thinking…' ? ` ${ago(a.since)}` : ''
  const doing = [[cmd, fg(cmdColor)], [toolAge, fg(P.sub)]]
  let lines
  if (hgt >= 4) {
    const extra =
      name !== 'needs'
        ? a.ctx
          ? [[`ctx ${kilo(a.ctx)}`, fg(P.overlay1)]]
          : []
        : a.need === 'monitor'
          ? [[`◉ ${raised?.kind ?? 'monitor'}`, fg(P.teal)]]
          : a.need === 'permission'
            ? hint([['a', 'allow'], ['d', 'deny'], ['↵', 'open']])
            : hint([['↵', a.need === 'question' ? 'answer' : 'open']])
    lines = [[[label, BOLD + fg(P.text)]], { left: doing, right: [['  ', ''], ...extra] }]
  } else lines = [[[label, BOLD + fg(P.text)], [' · ', fg(P.overlay1)], ...doing]]
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
  // A question waiting for y or n comes first: it's what the next key answers.
  if (confirm)
    return render(
      [
        [` ${confirm.text} `, BOLD + fg(P.peach)],
        ['y', fg(P.text)],
        [' yes  ', fg(P.sub)],
        ['n', fg(P.text)],
        [' no', fg(P.sub)],
        ...(confirm.skip ? [['  a', fg(P.text)], [" yes, don't ask again", fg(P.sub)]] : []),
      ],
      w,
    )
  if (note && note.until > Date.now()) return render([[` ${note.text}`, fg(note.color)]], w)
  const keys = listMode()
    ? [['j/k', 'move'], ['↵', 'open'], ...(peek ? [['alt+s', 'session'], ['ctrl+shift+b', 'board']] : [['esc', 'workspace']]), ['a/d', 'allow/deny'], ['n', 'new']]
    : [['h/l', 'lane'], ['j/k', 'agent'], ['tab', 'monitors'], ['↵', 'open'], ['a/d', 'allow/deny'], ['e', 'reviewed'], ['o', 'go to tab'], ['x', focus === 4 ? 'stop monitor' : 'close'], ['n', 'new'], ['/', 'filter']]
  return render([[' '], ...hint(keys)], w)
}

function drawBoard() {
  keepFocus()
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
  const button = newButton(' + New  ')
  const W = cols()
  const H = rows()
  const lines = [
    split(
      // Back to the board: a solid pill with its key in it, so it reads as a
      // button and says how to press it.
      peek ? [[' ', ''], ...pill(' ◂ Board  ', P.surface1, P.base, BOLD + fg(P.text)).slice(0, 2), ['ctrl+shift+b ', fg(P.sub) + bg(P.surface1)], pill('', P.surface1, P.base)[2]] : [[' agents', BOLD + fg(P.blue)]],
      button.spans,
      W,
    ),
    render([], W),
  ]
  hits.push({ x1: W - button.cells + 1, x2: W, y1: 1, y2: 1, act: () => openDialog() })
  hits.push({ x1: 1, x2: 26, y1: 1, y2: 1, act: () => closePeek() })
  const items = listItems()
  const pickable = items.filter(x => x.id)
  if (!pickable.some(x => x.id === listSel)) listSel = (pickable.find(x => x.agent.id === peek?.id) ?? pickable[0])?.id ?? null
  // Each item's rows: an agent takes two, its name and age, then its repo,
  // branch and what it's doing; scrolling counts rows, not items.
  const drawn = items.map(it => {
    if (it.spacer) return [render([], W)]
    if (it.group) return [header(it.group === 'monitors' ? { glyph: '◉', color: P.teal, name: 'Monitors' } : STATE[it.group], it.count, W)]
    if (it.empty) return [render([[`   ${EMPTY[it.empty]}`, ITALIC + fg(P.overlay1)]], W)]
    const fill = it.id === listSel ? SEL_BG : ''
    if (it.monitor) {
      const look = MONITOR[it.monitor.state]
      const head = [[` ${look.glyph} `, fg(look.color)], [clean(it.monitor.description), BOLD + fg(P.text)]]
      return [split(head, [[` ${ago(it.monitor.event?.at ?? it.monitor.startedAt)} `, fg(P.sub)]], W, fill)]
    }
    const a = it.agent
    const open = peek && a.id === peek.id
    const place = a.worktree ? ` ⑂ ${a.worktree}` : a.branch ? ` ⎇ ${a.branch}` : ''
    return [
      split([[open ? ' ▶ ' : '   ', fg(P.blue)], [clean(a.title), BOLD + fg(P.text)]], [[` ${ago(a.since)} `, fg(P.sub)]], W, fill),
      render([['   '], [clean(a.repo), fg(P.sub)], [clean(place), fg(P.overlay1)], [` · ${clean(a.cmd)}`, fg(P.overlay1)]], W, fill),
    ]
  })
  const room = H - 3
  const sel = items.findIndex(x => x.id === listSel)
  if (sel >= 0) {
    const top = drawn.slice(0, sel).reduce((n, r) => n + r.length, 0)
    const bottom = top + drawn[sel].length
    if (top < scroll.list) scroll.list = top
    if (bottom > scroll.list + room) scroll.list = bottom - room
  }
  let row = 0
  items.forEach((it, i) => {
    for (const line of drawn[i]) {
      if (row >= scroll.list && row < scroll.list + room) {
        const y = lines.length + 1
        if (it.id) hits.push({ x1: 1, x2: W, y1: y, y2: y, act: () => ((listSel = it.id), openSession(it.agent)) })
        lines.push(line)
      }
      row++
    }
  })
  while (lines.length < H - 1) lines.push(render([], W))
  lines.push(footer(W))
  return lines.slice(0, H)
}

// ------------------------------------------------------------ new agent

// The form runs in a tmux popup over the whole window (newagent.mjs), the
// form's own size, so it has room beside an open session as well as over
// the board. It writes what you chose to a file; the hub starts the agent
// from that.
let asking = false

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

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

async function openDialog() {
  if (asking) return
  if (!process.env.TMUX) return say('The hub is not running in tmux, so it has nowhere to show New agent', P.red)
  asking = true
  const result = join(RUN, `new-agent-${process.pid}.json`)
  try {
    try {
      unlinkSync(result)
    } catch {}
    const [W, H] = (await outer('display', '-p', '-t', process.env.TMUX_PANE, '#{window_width} #{window_height}')).out.trim().split(' ').map(Number)
    const w = Math.min(POPUP.w, W - 2)
    const h = Math.min(POPUP.h, H - 2)
    const opts = JSON.stringify({ folder: focused()?.cwd ?? '', recents: recents() })
    const cmd = [process.execPath, join(HERE, 'newagent.mjs'), result, opts].map(shq).join(' ')
    // display-popup returns once the popup closes.
    const shown = await outer(
      'display-popup', '-E', '-t', process.env.TMUX_PANE, '-w', String(w), '-h', String(h),
      '-b', 'rounded', '-S', `fg=${P.blue}`, '-s', `bg=${P.base}`, '-T', `#[fg=${P.blue},bold] New agent `, cmd,
    )
    if (!shown.ok) return say(`Couldn't show New agent: ${clean(shown.err).slice(0, 120)}`, P.red)
    let spec = null
    try {
      spec = JSON.parse(readFileSync(result, 'utf8'))
      unlinkSync(result)
    } catch {}
    if (spec) await start(spec)
  } finally {
    asking = false
  }
}

async function start(spec) {
  const plan = launch(spec)
  remember(spec.cwd)
  if (plan.where === 'bg') {
    say(`Starting ${plan.name} in the background…`, P.sub, 30000)
    const child = spawn(CLAUDE, plan.argv.slice(1), { cwd: spec.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let outText = ''
    child.stdout.on('data', b => (outText += b))
    child.stderr.on('data', b => (outText += b))
    child.on('error', err => say(`Couldn't start claude: ${err.message}`, P.red))
    child.on('close', code => {
      say(code === 0 ? `Started ${plan.name} in the background ${clean(outText).trim().slice(0, 60)}` : `claude --bg failed: ${clean(outText).trim().slice(0, 120)}`, code === 0 ? P.green : P.red, 8000)
    })
    child.unref()
    return
  }
  const session = WIN ? `ghostty-${WIN}` : null
  if (!session) return say('Not in a Ghostty layout window, so there is no tab session to open a tab in', P.red)
  const made = await tabs('new-window', '-d', '-t', `${session}:`, '-c', spec.cwd, '-P', '-F', '#{window_id} #{pane_id}')
  if (!made.ok) return say(`Couldn't open a tab: ${made.err}`, P.red)
  const [window, pane] = made.out.trim().split(' ')
  // The shell reads this once its prompt is up; typing it rather than running
  // claude as the tab's command keeps the shell when Claude exits.
  await tabs('send-keys', '-t', pane, '-l', plan.line)
  await tabs('send-keys', '-t', pane, 'Enter')
  await openSession({ id: `new:${pane}`, title: plan.name, pane: { session, window, pane, win: WIN } })
}

// ------------------------------------------------------------ actions

// A click on the board only selects; Enter opens the session.
function pick(laneIndex, id) {
  focus = laneIndex
  selected[LANES[laneIndex]] = id
}

function pickMonitor(key) {
  focus = 4
  selected.monitors = key
}

// Whether lane i (4: the monitors strip) has anything to select.
const filled = i => (i === 4 ? strip() : board()[LANES[i]]).length > 0

// h/l and the arrows step to the next lane with cards in it, skipping empty
// ones, where nothing would show as selected.
function moveLane(n) {
  for (let step = 1; step < 5; step++) {
    const next = (((focus + n * step) % 5) + 5) % 5
    if (filled(next)) return (focus = next)
  }
}

// When the focused lane is empty (at start, or its last card moved on),
// focus goes to the next lane that has cards.
function keepFocus() {
  if (filled(focus)) return
  for (let step = 1; step < 5; step++) {
    const next = (focus + step) % 5
    if (filled(next)) return (focus = next)
  }
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
  if (!peek) await findPeek()
  if (peek && (await paneAlive(peek.pane))) {
    // A tab of the session the pane already shows is one tab switch away;
    // anything else (a background agent, another window's tab) restarts it.
    const switched =
      a.pane?.window && peek.window && (await tabs('select-window', '-t', `=peek-${peek.pane.slice(1)}:${a.pane.window}`)).ok
    if (!switched) await outer('respawn-pane', '-k', '-t', peek.pane, cmd)
    await outer('select-pane', '-t', peek.pane)
    peek.id = a.id
    peek.window = a.pane?.window ?? null
  } else {
    const size = Math.max(20, cols() - LIST_COLS - 1)
    const made = await outer('split-window', '-h', '-t', process.env.TMUX_PANE, '-l', String(size), '-P', '-F', '#{pane_id}', cmd)
    if (!made.ok) return say(`Couldn't open the session: ${made.err}`, P.red)
    peek = { pane: made.out.trim(), id: a.id, window: a.pane?.window ?? null }
    await outer('set', '-p', '-t', peek.pane, '@peek', '1')
    // The window remembers its open session, so Ctrl+Shift+B can close it
    // from any pane (layout.conf).
    await outer('set', '-w', '-t', peek.pane, '@peek_pane', peek.pane)
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
  await forgetPeek()
  draw()
}

const forgetPeek = () => outer('set', '-wu', '-t', process.env.TMUX_PANE, '@peek_pane')

// The hub restarts in a loop (bin/ghostty-hub), and a new one starts with
// no open session in mind while the old one's pane may still be beside it.
// That pane is marked @peek, so the hub takes it back rather than splitting
// off a second one.
async function findPeek() {
  if (peek || !process.env.TMUX) return
  const list = (await outer('list-panes', '-t', process.env.TMUX_PANE, '-F', '#{pane_id} #{@peek}')).out
  const pane = list.split('\n').map(l => l.split(' ')).find(([, mark]) => mark === '1')?.[0]
  if (!pane) return
  // The window the pane shows, when it shows a tab; empty for `claude attach`.
  const shown = await tabs('list-windows', '-t', `=peek-${pane.slice(1)}`, '-F', '#{window_active} #{window_id}')
  const window = shown.ok ? (shown.out.split('\n').find(l => l.startsWith('1 '))?.slice(2) ?? null) : null
  peek = { pane, id: agents.find(a => window && a.pane?.window === window)?.id ?? null, window }
  await outer('set', '-w', '-t', pane, '@peek_pane', pane)
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
  if (!a) return
  if (!a.pane && a.jobId) return toTab(a)
  if (!a.pane) return say(`${a.title} runs outside the layout's tabs`, P.sub)
  // By session as well: a bare window id picks whichever session used it last,
  // which can be the hub's own peek session.
  await tabs('select-window', '-t', `${a.pane.session}:${a.pane.window}`)
  if (a.pane.win === WIN || !WIN) await outer('select-window', '-t', `layout-${WIN}:work`)
  else say(`Switched ${a.title}'s tab in Ghostty window ${a.pane.win}`, P.sub)
}

// A background agent has no tab; o gives it one: a new tab in this window
// that attaches to it, typed into the tab's shell so the shell stays after.
async function toTab(a) {
  if (!WIN) return say('Not in a Ghostty layout window, so there is no tab session to open a tab in', P.red)
  const made = await tabs('new-window', '-t', `ghostty-${WIN}:`, '-c', a.cwd, '-P', '-F', '#{pane_id}')
  if (!made.ok) return say(`Couldn't open a tab: ${made.err}`, P.red)
  const pane = made.out.trim()
  await tabs('send-keys', '-t', pane, '-l', `${CLAUDE.replace(/[^\w./-]/g, '\\$&')} attach ${a.jobId}`)
  await tabs('send-keys', '-t', pane, 'Enter')
  await outer('select-window', '-t', `layout-${WIN}:work`)
}

// x closes a done or idle agent: a tab agent's tab, or a background agent,
// stopped with its conversation kept (`claude attach <id>` resumes it). The
// footer says whether it worked; the card leaves once agentd sees it gone.
// Closing a session ends every monitor it armed, so the question says how
// many.
function closeAgent() {
  const a = focused()
  if (!a) return
  if (a.state === 'working' || a.state === 'needs') return say('Only Done and Idle agents close from here', P.sub)
  const done = (r, what) => say(r.ok ? what : `Couldn't close ${a.title}: ${clean(r.err).slice(0, 120)}`, r.ok ? P.green : P.red, 8000)
  const live = a.monitors.filter(m => m.state !== 'ended').length
  const also = live ? ` and its ${live === 1 ? 'monitor' : `${live} monitors`}` : ''
  if (a.pane)
    confirm = {
      text: `Close ${where(a)} (${a.title})${also}?`,
      yes: async () => done(await tabs('kill-window', '-t', a.pane.window), `Closed ${where(a)} (${a.title})`),
    }
  else if (a.jobId)
    confirm = {
      text: `Stop background agent ${a.title}${also}? Its conversation is kept.`,
      yes: async () => done(await run([CLAUDE, 'stop', a.jobId]), `Stopped ${a.title}; claude attach ${a.jobId} resumes it`),
    }
  else say(`${a.title} runs outside the layout; close it where it runs`, P.sub)
}

// The processes on the machine, for finding a monitor's: pid, parent,
// process group, start time and command line. The fields after the command
// name in /proc/<pid>/stat, which can itself hold spaces and parentheses.
function processes() {
  const list = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
      list.push({ pid: Number(pid), ppid: Number(f[1]), pgid: Number(f[2]), start: Number(f[19]), cmdline })
    } catch {}
  }
  return list
}

// x on a monitor stops only that monitor: it ends the monitor's own process
// group, which leaves the session and its other monitors running. The
// session gets the exit as a task notification, so the monitor ends there
// too.
function stopMonitor(m) {
  if (m.state === 'ended') return say(`${clean(m.description)} has already ended`, P.sub)
  const kill = () => {
    let p = null
    try {
      p = monitorProcess(processes(), m.agent.pid, m.command)
    } catch {}
    if (!p) return say(`Couldn't find the process for ${clean(m.description)}; it may have just ended`, P.peach, 8000)
    try {
      // A group of its own: the whole pipeline goes (tail, sleep, grep).
      process.kill(p.pgid === p.pid ? -p.pid : p.pid, 'SIGTERM')
      say(`Stopped ${clean(m.description)}; ${m.agent.title} keeps running`, P.green, 8000)
    } catch (err) {
      say(`Couldn't stop ${clean(m.description)}: ${err.code ?? err.message}`, P.red, 8000)
    }
  }
  if (prefs().skip?.['stop-monitor']) return kill()
  confirm = { text: `Stop monitor ${clean(m.description)}? ${m.agent.title} and its other monitors keep running.`, yes: kill, skip: 'stop-monitor' }
}

function prefs() {
  try {
    return JSON.parse(readFileSync(PREFS, 'utf8'))
  } catch {
    return {}
  }
}

function dontAsk(name) {
  const p = prefs()
  p.skip = { ...p.skip, [name]: true }
  try {
    mkdirSync(dirname(PREFS), { recursive: true })
    writeFileSync(PREFS, `${JSON.stringify(p, null, 2)}\n`)
  } catch (err) {
    say(`Couldn't save that choice: ${err.code ?? err.message}`, P.red, 8000)
  }
}

function onKey(key) {
  if (confirm) {
    const c = confirm
    confirm = null
    if (key === 'y') void c.yes()
    else if (key === 'a' && c.skip) {
      dontAsk(c.skip)
      void c.yes()
    }
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
    x: () => {
      const m = focusedMonitor()
      return m ? stopMonitor(m) : closeAgent()
    },
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
  paint(listMode() ? drawList() : drawBoard())
}

// Follows the open session: drops it once its pane is gone, and when you
// switch tabs in it (its tab bar, or the tab keys), moves the list's ▶ and
// selection to the agent in the tab it now shows.
async function watchPeek() {
  if (!peek) return
  const p = peek
  if (!(await paneAlive(p.pane))) {
    if (peek === p) peek = null
    await forgetPeek()
    return draw()
  }
  if (!p.window) return
  // One taken back at startup may predate the first state from agentd.
  if (!p.id) {
    const a = agents.find(x => x.pane?.window === p.window)
    if (a) {
      p.id = a.id
      listSel = a.id
      draw()
    }
  }
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
    if (t.key === NEW_AGENT_KEY) {
      confirm = null
      filtering = false
      void openDialog()
    } else if (t.key === OPEN_AGENT_KEY) {
      let id = ''
      try {
        id = readFileSync(HUB_OPEN, 'utf8').trim()
        unlinkSync(HUB_OPEN)
      } catch {}
      const a = agents.find(x => x.id === id)
      if (a) void openSession(a)
    } else if (t.key === PEEK_CLOSING_KEY) {
      if (peek) {
        peek = null
        void forgetPeek()
      }
    } else if (t.mouse) onMouse(t.mouse)
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
void findPeek().then(draw)
setInterval(draw, 1000)
setInterval(() => void watchPeek(), 400)
