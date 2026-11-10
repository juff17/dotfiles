#!/usr/bin/env node
// The agent hub: every Claude session on the machine, as the H4 design draws
// it. Task agents sit in four lanes (Needs you, Working, Done, Idle) with the
// command each one is running; monitors (pr-babysit, logger) sit in a strip
// below, and one that needs you also raises a card in Needs you.
//   - Enter opens an agent's live session beside a list of the rest (a tmux
//     pane attached to its tab, or `claude attach` for a background one).
//   - n starts a new agent: a task in a new tab, a worktree or the
//     background, or a monitor (a skill such as pr-babysit or logger).
//   - Alt+D shows the diagrams of the open session's tab, or of the selected
//     agent's tab, in a window of their own (bin/ghostty-diagrams).
// It runs in the hub window of the window's outer tmux (layout.conf), next to
// the rail. HUB_WIN is the Ghostty window number; GHOSTTY_CONF the config
// folder. State comes from agentd through client.mjs.

import { execFile, spawn } from 'node:child_process'
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LANES, LANE_GAP, shownLanes, activeWindow, boardRows, closeQuestion, keptFocus, laneColumns, listItems as itemsOf, listMode as isListMode,
  listScroll, listSelection, markedPane, nextLane, selection, showsPermission, shq, step, stepList, tabFocus, trayWindow, visible as matching, where as whereOf,
} from './board.mjs'
import { RUN, follow, markReviewed, markStopped } from './client.mjs'
import { splitAt } from './line.mjs'
import { DIAGRAMS_KEY, NEW_AGENT_KEY, OPEN_AGENT_KEY, PEEK_CLOSING_KEY, answerConfirm, filterKey, hitAt, keyAction, mouseAction } from './keys.mjs'
import { HUB_OPEN } from './tray.mjs'
import { attentionTags, brokeTags, cardHeights, counts, lanes, launch, monitorProcess, monitorsOf, scrollTo } from './model.mjs'
import { load as settings, set as setSetting } from './settings.mjs'
import { POPUP } from './newagent.mjs'
import { recents as recentsOf, remember as rememberIn, storePaths } from './prefs.mjs'
import { BOLD, CAP_L, CAP_R, ITALIC, MONITOR, P, STATE, ago, bar, bg, clean, enter, fg, leave, mix, paint, pill, render, split, tokens, width, wrap } from './term.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONF = process.env.GHOSTTY_CONF || dirname(HERE)
const WIN = Number(process.env.HUB_WIN) || 0
// Ghostty's own PATH may lack claude; bin/ghostty-hub finds it.
const CLAUDE = process.env.AGENT_HUB_CLAUDE || 'claude'
// AGENT_HUB_TABS_SOCKET points the hub at another tab server, for tests.
const TABS = ['-L', process.env.AGENT_HUB_TABS_SOCKET || 'ghostty']
const HOME = homedir()
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude')
const { recents: RECENTS } = storePaths(process.env, HOME)
const listCols = () => settings()['hub.listCols']

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
let filterAt // the filter's caret, as hub/line.mjs keeps it; none is the end
let peek = null // { pane, id }
let listSel = null // id in the list beside an open session
let confirm = null // { text, yes, skip }: skip names the setting that asks it, which answering a turns off
let note = null // { text, color, until }
let hits = [] // clickable regions of the last frame

const cols = () => process.stdout.columns || 120
const rows = () => process.stdout.rows || 40

// How long a result stays in the footer: Settings' hub.noteSecs.
const noteMs = () => settings()['hub.noteSecs'] * 1000
function say(text, color = P.sub, ms = 5000) {
  note = { text, color, until: Date.now() + ms }
  draw()
}

const visible = () => matching(agents, filter)
const board = () => lanes(visible())
const strip = () => monitorsOf(visible())
const where = a => whereOf(a, WIN)

const kilo = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// The selected item of a lane, kept by id so it stays put as cards move.
function current(lane) {
  const list = lane === 'monitors' ? strip() : board()[lane]
  const sel = selection(list, x => (lane === 'monitors' ? x.key : x.id), selected[lane])
  selected[lane] = sel.id
  return sel
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

const listMode = () => isListMode(peek, cols())

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

// Key and label pairs; no-break spaces inside a pair, so a wrapped footer
// breaks only between pairs.
function hint(pairs) {
  const nb = s => s.replaceAll(' ', '\u00a0')
  return pairs.flatMap(([k, v], i) => [[`${i ? '  ' : ''}${nb(k)}`, fg(P.text)], [nb(` ${v}`), fg(P.sub)]])
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
  if (filtering || filter) right.push([`/${filtering ? splitAt(filter, filterAt).join('▏') : filter}  `, fg(P.yellow)])
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
  const heights = cardHeights(name, items.length, room, settings()['hub.doneCards'])
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
    needs: a.need === 'monitor' && brokeTags().has(a.cmd.match(/^\[([\w-]+)/)?.[1]) ? P.red : P.peach,
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
  if (!list.length) out.push(empty(`${EMPTY.monitors} · n → Monitor a PR or logs`, w))
  // Like the lanes, a full tray says how many it hides.
  const { top, room } = trayWindow(list.length, h - out.length, sel)
  list.slice(top, top + room).forEach((m, k) => {
    const i = top + k
    const on = focus === 4 && i === sel
    const fill = on ? SEL_BG : LANE_BG
    const mlook = MONITOR[m.state]
    const ev = m.event
    // Red for broke, peach for needing you, as the tray and the lanes have them.
    const tagColor = !ev
      ? P.sub
      : brokeTags().has(ev.tag)
        ? P.red
        : attentionTags().has(ev.tag)
          ? P.peach
          : /comment|review/.test(ev.tag)
            ? P.mauve
            : P.teal
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

// The footer's rows: one, or up to FOOTER_ROWS when its question, note or
// keys need more to be read whole, as they do in the list beside a session.
const FOOTER_ROWS = 4
const wrapped = (spans, w) => wrap(spans, w - 1, FOOTER_ROWS).map(l => render([[' '], ...l], w))

function footer(w) {
  // A question waiting for y or n comes first: it's what the next key answers.
  // Each answer is a key and its word, kept together on a line.
  if (confirm)
    return wrapped(
      [
        [`${confirm.text}  `, BOLD + fg(P.peach)],
        ['y', fg(P.text)],
        ['\u00a0yes  ', fg(P.sub)],
        ['n', fg(P.text)],
        ['\u00a0no', fg(P.sub)],
        ...(confirm.skip ? [['  a', fg(P.text)], ["\u00a0yes,\u00a0don't\u00a0ask\u00a0again", fg(P.sub)]] : []),
      ],
      w,
    )
  if (note && note.until > Date.now()) return wrapped([[note.text, fg(note.color)]], w)
  const keys = listMode()
    ? [['↵', 'open'], peek ? ['alt+→', 'session'] : ['esc', 'workspace'], ['ctrl+x', focusedMonitor() ? 'stop monitor' : 'close']]
    : [['h/l', 'lane'], ['j/k', 'agent'], ['tab', 'monitors'], ['↵', 'open'], ['a/d', 'allow/deny'], ['e', 'reviewed'], ['o', 'go to tab'], ['x', focus === 4 ? 'stop monitor' : 'close'], ['alt+d', 'diagrams'], ['n', 'new'], ['/', 'filter']]
  return wrapped(hint(keys), w)
}

function drawBoard() {
  keepFocus()
  const W = cols()
  const H = rows()
  const c = counts(visible())
  const lines = [summary(c, W), render([], W)]
  const { stripH, laneH } = boardRows(H, strip().length, settings()['hub.monitorRows'])
  const shown = shownLanes()
  const at = laneColumns(W, shown.length)
  const cols_ = shown.map((name, i) => lane(name, at[i].w, laneH, i, at[i].x))
  for (let r = 0; r < laneH; r++) lines.push(cols_.map(c => c[r]).join(' '.repeat(LANE_GAP)))
  lines.push(render([], W))
  lines.push(...monitorRows(W, stripH, lines.length + 1))
  const foot = footer(W)
  return [...lines.slice(0, H - foot.length), ...foot]
}

// ------------------------------------------------------------ list

// The board as one column, beside an open session (board.mjs listItems).
const listItems = () => itemsOf(board(), strip())

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
  listSel = listSelection(items, listSel, peek?.id)
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
  const foot = footer(W)
  const room = H - 2 - foot.length
  const sel = items.findIndex(x => x.id === listSel)
  scroll.list = listScroll(drawn.map(r => r.length), sel, scroll.list, room)
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
  while (lines.length < H - foot.length) lines.push(render([], W))
  return [...lines, ...foot].slice(0, H)
}

// ------------------------------------------------------------ new agent

// The form runs in a tmux popup over the whole window (newagent.mjs), the
// form's own size, so it has room beside an open session as well as over
// the board. It writes what you chose to a file; the hub starts the agent
// from that.
let asking = false

const recents = () => recentsOf(RECENTS, agents, HOME)
const remember = dir => rememberIn(RECENTS, dir, agents, HOME)

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
      say(code === 0 ? `Started ${plan.name} in the background ${clean(outText).trim().slice(0, 60)}` : `claude --bg failed: ${clean(outText).trim().slice(0, 120)}`, code === 0 ? P.green : P.red, noteMs())
    })
    child.unref()
    return
  }
  // The tab goes to the hub's tab session, so it shows in the hub and not
  // in the workspace (hub_tab_new in ghostty-lib.sh).
  if (!WIN) return say('Not in a Ghostty layout window, so there is no tab session to open a tab in', P.red)
  const made = await run([join(CONF, 'bin', 'ghostty-hub'), 'tab', String(WIN), spec.cwd])
  const [session, window, pane] = made.out.trim().split(' ')
  if (!made.ok || !pane) return say(`Couldn't open a tab: ${clean(made.err).slice(0, 120) || 'no workspace tabs'}`, P.red)
  // The shell reads this once its prompt is up; typing it rather than running
  // claude as the tab's command keeps the shell when Claude exits.
  await tabs('send-keys', '-t', pane, '-l', plan.line)
  await tabs('send-keys', '-t', pane, 'Enter')
  await openSession({ id: `new:${pane}`, title: plan.name, pane: { session, window, pane, win: WIN, hub: true } })
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
const filled = i => (i === 4 ? strip() : i < shownLanes().length ? board()[LANES[i]] : []).length > 0
const moveLane = n => (focus = nextLane(focus, n, filled))
const keepFocus = () => (focus = keptFocus(focus, filled))

function moveIn(n) {
  if (listMode()) {
    listSel = stepList(listItems(), listSel, n)
    return
  }
  const name = focus === 4 ? 'monitors' : LANES[focus]
  const { list, i } = current(name)
  const next = step(list, i, n)
  if (next) selected[name] = name === 'monitors' ? next.key : next.id
}

// Opens a's session beside the list: a pane in this window that attaches to
// the agent's tmux tab through its own session, grouped with the hub's tab
// session, so looking at a tab here doesn't switch tabs in the workspace and
// a tab opened here stays out of it. A background agent opens with
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
  if (a.pane?.win && a.pane.window) cmd = `${bin} peek ${a.pane.win} ${a.pane.window}`
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
    const size = Math.max(20, cols() - listCols() - 1)
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

// Claude's diagrams for a tab, in their own window (bin/ghostty-diagrams).
// With a session open beside the list, the tab it shows, followed as you
// switch tabs in it; otherwise the selected agent's tab. The diagram mod
// keeps diagrams per tmux pane, so a background agent has none.
async function showDiagrams() {
  if (!WIN) return say('Not in a Ghostty layout window, so there is nowhere to show diagrams', P.red)
  let from
  if (peek?.window && (await paneAlive(peek.pane))) from = `peek-${peek.pane.slice(1)}`
  else {
    const a = focused()
    if (!a) return say('Select an agent to see its diagrams')
    if (!a.pane?.pane) return say(`${a.title} runs in the background, with no tab, so it has no diagrams to show`, P.peach)
    from = a.pane.pane
  }
  const shown = await run([join(CONF, 'bin', 'ghostty-diagrams'), String(WIN), from])
  if (!shown.ok) say(`Couldn't show the diagrams: ${clean(shown.err).slice(0, 120)}`, P.red)
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
  const pane = markedPane((await outer('list-panes', '-t', process.env.TMUX_PANE, '-F', '#{pane_id} #{@peek}')).out)
  if (!pane) return
  // The window the pane shows, when it shows a tab; empty for `claude attach`.
  const shown = await tabs('list-windows', '-t', `=peek-${pane.slice(1)}`, '-F', '#{window_active} #{window_id}')
  const window = shown.ok ? activeWindow(shown.out) : null
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
  if (!waiting || !showsPermission(screen.out)) return say(`${a.title} isn't showing a permission prompt right now`, P.peach)
  await tabs('send-keys', '-t', a.pane.pane, allow ? '1' : 'Escape')
  say(`${allow ? 'Allowed' : 'Denied'} ${a.cmd.replace(/^Allow |\?$/g, '')}`, allow ? P.green : P.peach)
}

async function goToTab() {
  const a = focused()
  if (!a) return
  if (!a.pane && a.jobId) return toTab(a)
  if (!a.pane) return say(`${a.title} runs outside the layout's tabs`, P.sub)
  // A tab opened from the hub isn't in the workspace, so it opens here.
  if (a.pane.hub) return openSession(a)
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

// x closes a done or idle agent (board.mjs closeQuestion says which way),
// stopped with its conversation kept (`claude attach <id>` resumes it). A
// tab parked on a background job loses the job first, so the tab isn't left
// showing a job that's still running. The footer says whether it worked; the
// card leaves once agentd sees it gone.
function closeAgent() {
  const a = focused()
  if (!a) return
  const q = closeQuestion(a, where(a))
  if (q.refuse) return say(q.refuse, P.sub)
  const done = (r, what) => say(r.ok ? what : `Couldn't close ${a.title}: ${clean(r.err).slice(0, 120)}`, r.ok ? P.green : P.red, noteMs())
  const yes = {
    'tab+job': async () => {
      const stop = await run([CLAUDE, 'stop', a.jobId])
      if (!stop.ok) return done(stop)
      done(await tabs('kill-window', '-t', a.pane.window), `Closed ${where(a)} and stopped ${a.title}; claude attach ${a.jobId} resumes it`)
    },
    tab: async () => done(await tabs('kill-window', '-t', a.pane.window), `Closed ${where(a)} (${a.title})`),
    job: async () => done(await run([CLAUDE, 'stop', a.jobId]), `Stopped ${a.title}; claude attach ${a.jobId} resumes it`),
  }[q.how]
  confirm = { text: q.text, yes }
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
    if (!p) return say(`Couldn't find the process for ${clean(m.description)}; it may have just ended`, P.peach, noteMs())
    try {
      // A group of its own: the whole pipeline goes (tail, sleep, grep).
      process.kill(p.pgid === p.pid ? -p.pid : p.pid, 'SIGTERM')
      markStopped(m.agent.id, m.task)
      say(`Stopped ${clean(m.description)}; ${m.agent.title} keeps running`, P.green, noteMs())
    } catch (err) {
      say(`Couldn't stop ${clean(m.description)}: ${err.code ?? err.message}`, P.red, noteMs())
    }
  }
  if (!settings()['hub.askStopMonitor']) return kill()
  confirm = { text: `Stop monitor ${clean(m.description)}? ${m.agent.title} and its other monitors keep running.`, yes: kill, skip: 'hub.askStopMonitor' }
}

// "Don't ask again" turns the question's setting off, which Settings can
// turn back on.
function dontAsk(key) {
  try {
    setSetting(key, false)
  } catch (err) {
    say(`Couldn't save that choice: ${err.code ?? err.message}`, P.red, noteMs())
  }
}

const actions = {
  laneLeft: () => moveLane(-1),
  laneRight: () => moveLane(1),
  down: () => moveIn(1),
  up: () => moveIn(-1),
  tab: () => (focus = tabFocus(focus, filled)),
  open: () => openSession(focused()),
  allow: () => answer(true),
  deny: () => answer(false),
  reviewed: () => {
    const a = focused()
    if (a?.state === 'done') markReviewed(a.id)
  },
  reviewAll: () => board().done.forEach(a => markReviewed(a.id)),
  goToTab: () => goToTab(),
  close: () => {
    const m = focusedMonitor()
    return m ? stopMonitor(m) : closeAgent()
  },
  new: () => openDialog(),
  filter: () => ((filtering = true), (filter = ''), (filterAt = undefined)),
  back: () => (peek ? closePeek() : outer('select-window', '-t', `layout-${WIN}:work`)),
  workspace: () => outer('select-window', '-t', `layout-${WIN}:work`),
}

function onKey(key) {
  if (confirm) {
    const c = confirm
    confirm = null
    const r = answerConfirm(c, key)
    if (r.remember) dontAsk(r.remember)
    if (r.yes) void c.yes()
    return
  }
  if (filtering) {
    const f = filterKey(filter, key, filterAt)
    filter = f.filter
    filtering = f.filtering
    filterAt = f.at
    return
  }
  void actions[keyAction(key)]?.()
}

function onMouse(m) {
  const act = mouseAction(m)
  if (act?.wheel) {
    const h = hitAt(hits, m.x, m.y, true)
    if (h) focus = h.wheel
    return moveIn(act.wheel)
  }
  if (act?.click) void hitAt(hits, m.x, m.y)?.act()
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
    } else if (t.key === DIAGRAMS_KEY) {
      void showDiagrams()
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
// Beside an open session the list keeps its width: tmux shares a window
// resize out between the panes, so the hub puts its own width back, as the
// rail does. Not once the session's pane is gone, when the hub should widen.
process.stdout.on('resize', async () => {
  draw()
  if (peek && cols() !== listCols() && (await paneAlive(peek.pane)))
    await outer('resize-pane', '-t', process.env.TMUX_PANE, '-x', String(listCols()))
})
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
