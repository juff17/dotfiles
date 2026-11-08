#!/usr/bin/env node
// dv: shows the diagrams that the claude module's diagram-pane mod draws. The mod renders
// each to a PNG and lists a session's tabs in a file per tmux pane beside the
// PNGs (panes/); dv shows one of those files, so it runs outside Claude Code.
// Closing a tab rewrites that file, and the mod picks the change up before its
// next. It runs in two places:
//   - the viewer pane of the Ghostty layout, following the window's active
//     tab (DV_TABS), as one of the pane's modes;
//   - the diagrams window that Alt+D opens (bin/ghostty-diagrams), framed in
//     the middle of the window it came from (DV_UNDER, dimmed) and
//     titled (DV_FRAME), following a tab session (DV_TABS) or pinned to one
//     tab's pane (DV_PANE).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import { BOLD, CAP_L, CAP_R, ITALIC, P, bg, clean, fg, pill, render, split, width } from '../hub/term.mjs'
import { compose, frameBox, slice } from './backdrop.mjs'
import {
  cellAt,
  clampIndex,
  dropPicture as dropIds,
  dropTab,
  fitHints,
  hints,
  keyAction,
  modeAt as modeIn,
  newestPane,
  paneFile as paneFileFor,
  parseInput,
  picture,
  placeIn,
  pointer as pointerAt,
  reread,
  showFile,
  tabTitle as titleOf,
  truncate,
} from './diagram.mjs'
import { gridRow } from './kitty.mjs'
import { clampView, fitChips, home, panBy, placement, zoomAt } from './view.mjs'

const DIR = `${process.env.XDG_CACHE_HOME || `${homedir()}/.cache`}/claude-diagram-pane`
const PANES = `${DIR}/panes`
// The tab session to follow as `socket:session` (bin/ghostty-claude-start
// sets it for the viewer pane): dv shows its active tab.
const [TABS_SOCKET, TABS_SESSION] = (process.env.DV_TABS ?? '').split(':')
// One tab's pane as `socket:%id`, which dv shows whatever tab is active: the
// tab of the card selected on the hub's board.
const [PIN_SOCKET, PIN_PANE] = (process.env.DV_PANE ?? '').split(':')
// With neither, dv shows whichever pane's tabs changed last.
const FOLLOWS = Boolean(TABS_SESSION || PIN_PANE)
// The tab session touches this file when the active tab changes (tmux.conf).
const TAB_CHANGED = `${process.env.XDG_RUNTIME_DIR || '/tmp'}/ghostty-layout/tab-changed`
// The diagrams window draws a rounded frame round the whole screen, titled
// with the tab it shows, like the hub's popups.
const FRAME = Boolean(process.env.DV_FRAME)
const ZOOM_STEP = 1.15
const PAN_STEP = 0.2
const TAB_EXIT = Number(process.env.DV_TAB_EXIT) || 0
const DIFF_EXIT = Number(process.env.DV_DIFF_EXIT) || 0
const TODO_EXIT = Number(process.env.DV_TODO_EXIT) || 0
// The mode header names the viewer pane's other modes when it shares the pane
// with them: Files (DV_TAB_EXIT, which Tab goes to), Diff (DV_DIFF_EXIT) and
// Todo (DV_TODO_EXIT).
// Clicking one exits with its code.
const MODES = [
  { label: ' Diagrams ', exit: 0 },
  { label: ' Files ', exit: TAB_EXIT },
  { label: ' Diff ', exit: DIFF_EXIT },
  { label: ' Todo ', exit: TODO_EXIT },
].filter((m, i) => i === 0 || m.exit)
const HEADER = !FRAME && MODES.length > 1
// The frame's width on each side.
const EDGE = FRAME ? 1 : 0
// The frame's share of the screen each way. Round it, the window Alt+D was
// pressed in (DV_UNDER, a layout window id), dimmed (backdrop.mjs).
const SHARE = FRAME ? 85 : 100
const UNDER = process.env.DV_UNDER
const DIM = fg(P.surface1) + bg(P.crust)
let backdrop = []
// Rows inside the frame above the picture (the frame's top, the mode header,
// the row of diagram chips) and below it (the hint row, the frame's bottom).
const ABOVE = EDGE + (HEADER ? 1 : 0) + 1
const BELOW = 1 + EDGE
// The picture sits on a darker panel than the text around it.
const PANEL = bg(P.mantle)

const box = () => frameBox(process.stdout.columns, process.stdout.rows, SHARE)
// The picture's first screen row, counted from 1, and the chips' row above it.
const pictureTop = () => box().top + ABOVE + 1
const chipLine = () => pictureTop() - 1

const out = s => process.stdout.write(s)

let state = { diagrams: [], current: 0 }
// The pane file dv is showing, and the tab it belongs to for the frame's title.
let paneFile = ''
let tabTitle = ''
// The followed tab's pane is gone (its tab closed).
let gone = false
let index = 0
let view
// Cell size in pixels, until the terminal answers the size query.
let cell = { cw: 10, ch: 20 }
let pixelMouse = false
let drag
let chips = []
// The picture's kitty ids (diagram.mjs).
const pic = picture()

const inner = () => box().w - 2 * EDGE

const region = () => ({
  cols: inner(),
  rows: Math.max(1, box().h - ABOVE - BELOW),
  ...cell,
})

const diagram = () => state.diagrams[index]

// tmux may not answer the cell size query, but it knows the size itself.
function tmuxCell() {
  if (!process.env.TMUX) return
  try {
    const out = execFileSync('tmux', ['display', '-p', '#{client_cell_width} #{client_cell_height}'], { encoding: 'utf8' })
    const [cw, ch] = out.trim().split(' ').map(Number)
    if (cw && ch) cell = { cw, ch }
  } catch {
    // An older tmux without the formats; the size query or the default stands.
  }
}

// The pane file to show and the title of its tab: the pinned pane's, the
// followed session's active tab's, or the pane file written last.
function source() {
  if (FOLLOWS) {
    const [socket, target] = PIN_PANE ? [PIN_SOCKET, PIN_PANE] : [TABS_SOCKET, `${TABS_SESSION}:`]
    try {
      const args = ['-L', socket, 'display', '-p', '-t', target, '#{pane_id}\t#{b:pane_current_path}\t#{window_index}\t#{window_name}']
      const [pane, dir, tab, name] = execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim()
        .split('\t')
      if (!pane) return { file: '', title: '', gone: true }
      return { file: paneFileFor(PANES, socket, pane), title: titleOf(dir, tab, name), gone: false }
    } catch {
      return { file: '', title: '', gone: true }
    }
  }
  return { file: newestPane(PANES), title: '', gone: false }
}

function readState() {
  const s = source()
  paneFile = s.file
  tabTitle = s.title
  gone = s.gone
  if (!paneFile || !existsSync(paneFile)) {
    const had = state.diagrams.length > 0
    state = { diagrams: [], current: 0 }
    if (had) select(0)
    else schedule()
    return
  }
  try {
    const next = JSON.parse(readFileSync(paneFile, 'utf8'))
    if (!Array.isArray(next.diagrams)) return
    const to = reread(state, next, index)
    state = next
    if (to !== undefined) select(to)
    else schedule()
  } catch {
    // Read while Claude Code was still writing it; the next change event reads it whole.
  }
}

function select(i) {
  index = clampIndex(i, state.diagrams.length)
  view = diagram() ? home(diagram()) : undefined
  schedule()
}


function header() {
  const line = MODES.map((m, i) => (i === 0 ? `\x1b[7;1m${m.label}\x1b[0m` : `\x1b[2m${m.label}\x1b[0m`)).join(' ')
  if (!TAB_EXIT) return line
  return `${line}\x1b[${process.stdout.columns - 'tab switch'.length + 1}G\x1b[34mtab\x1b[0;2m switch\x1b[0m`
}

const modeAt = col => modeIn(MODES, col)

// One diagram's chip: a pill with its number for the 1–9 keys, its title and
// a × that closes it, solid blue when it's the one showing.
function chip(d, i) {
  const on = i === index
  const color = on ? P.blue : P.surface0
  const dim = fg(on ? P.surface0 : P.overlay1) + bg(color)
  const spans = [
    [CAP_L, fg(color)],
    [i < 9 ? `${i + 1} ` : '', dim],
    [`${truncate(clean(d.title))} `, (on ? BOLD + fg(P.crust) : fg(P.text)) + bg(color)],
    ['×', dim],
    [CAP_R, fg(color)],
    [' ', ''],
  ]
  return { spans, cells: spans.reduce((n, [t]) => n + width(t), 0) }
}

// The diagrams as chips, scrolled to keep the current one in view, with how
// many are hidden either side and where in the list it is. Records each
// chip's columns for clicks.
function chipRow(w) {
  chips = []
  const n = state.diagrams.length
  if (!n) return render([], w)
  const pos = [[`${index + 1}/${n}`, fg(P.sub)]]
  const all = state.diagrams.map(chip)
  // Room for the position and a "+N" either side.
  const room = w - width(pos[0][0]) - 2 * 4
  const { start, end } = fitChips(
    all.map(c => c.cells),
    index,
    room,
  )
  const left = []
  if (start) left.push([`‹${start} `, fg(P.overlay1)])
  let col = box().left + EDGE + 1 + (start ? width(left[0][0]) : 0)
  for (let i = start; i < end; i++) {
    const c = all[i]
    chips.push({ i, from: col, close: col + c.cells - 3, to: col + c.cells - 2 })
    left.push(...c.spans)
    col += c.cells
  }
  if (end < n) left.push([`+${n - end}`, fg(P.overlay1)])
  return split(left, pos, w)
}

function footer(w) {
  const keys = FRAME
    ? [['[ ]', 'prev/next'], ['1–9', 'jump'], ['scroll', 'zoom'], ['drag', 'pan'], ['0', 'fit'], ['x', 'close diagram'], ['esc', 'close']]
    : [['[ ]', 'diagrams'], ['scroll', 'zoom'], ['drag', 'pan'], ['x', 'close diagram'], ['q', 'quit']]
  const d = diagram()
  const right = d
    ? [[`${d.width}×${d.height} `, fg(P.overlay1)], ...pill(view && view.zoom > 1 ? ` ${view.zoom.toFixed(1)}× ` : ' fit ', P.surface0, P.base, fg(P.text))]
    : []
  const rw = right.reduce((n, [t]) => n + width(t), 0)
  return split(hints(fitHints(keys, w - rw - 2)), right, w)
}

// Lines of text in the middle of the picture panel.
function panelMessage(lines, rows, w) {
  const out = Array(rows).fill(render([], w, PANEL))
  const from = Math.max(0, Math.floor((rows - lines.length) / 2))
  lines.forEach(([text, style], k) => {
    if (from + k >= rows) return
    const pad = Math.max(0, Math.floor((w - width(text)) / 2))
    out[from + k] = render([[' '.repeat(pad)], [text, style]], w, PANEL)
  })
  return out
}

// The picture region's rows: a message, or the picture's placeholder cells,
// centered on the panel.
function pictureRows() {
  const r = region()
  const d = diagram()
  if (!d) {
    const lines = gone
      ? [['That tab has closed, so it has no diagrams to show.', ITALIC + fg(P.sub)]]
      : [
          [`No diagrams${tabTitle ? ` in ${tabTitle}` : ''} yet`, ITALIC + fg(P.sub)],
          ['Ask Claude for a diagram and it shows here.', fg(P.overlay1)],
        ]
    return { rows: panelMessage(lines, r.rows, r.cols), setup: dropPicture() }
  }
  if (!existsSync(d.file)) {
    const lines = [['This PNG is gone from the cache. Open its tab in Claude to draw it again.', ITALIC + fg(P.sub)]]
    return { rows: panelMessage(lines, r.rows, r.cols), setup: dropPicture() }
  }
  let setup = showFile(pic, d.file)
  view = clampView(d, r, view ?? home(d))
  const at = placement(d, r, view)
  setup += placeIn(pic, at.gridCols, at.gridRows)
  // The panel's color stays on under the placeholders, so it shows through
  // the PNG's transparent background.
  const rows = Array(r.rows).fill(render([], r.cols, PANEL))
  for (let k = 0; k < at.rows; k++) {
    const cells = gridRow(pic.shownId, pic.placedId, at.gridRow + k, at.gridCol, at.cols)
    rows[at.row + k] = `${PANEL}${' '.repeat(r.cols)}\x1b[${box().left + EDGE + at.col + 1}G${PANEL}${cells}\x1b[0m`
  }
  return { rows, setup }
}

// The frame: a rounded blue border, with the tab's title in its top edge and
// the key that closes it on the right.
const EDGE_STYLE = fg(P.blue)

function frameTop(w) {
  const title = ` Diagrams${tabTitle ? ` · ${tabTitle}` : ''} `
  const close = [[' alt+d', fg(P.text)], [' close ', fg(P.sub)]]
  const fill = Math.max(0, w - 4 - width(title) - close.reduce((n, [t]) => n + width(t), 0))
  return render([['╭─', EDGE_STYLE], [title, BOLD + fg(P.blue)], ['─'.repeat(fill), EDGE_STYLE], ...close, ['─╮', EDGE_STYLE]], w)
}

const frameBottom = w => render([[`╰${'─'.repeat(Math.max(0, w - 2))}╯`, EDGE_STYLE]], w)

// A row inside the frame; its right edge is placed by column, since the
// picture's rows place their cells by column too.
const framed = b => line => `${EDGE_STYLE}│\x1b[0m${line}\x1b[0m\x1b[${b.left + b.w}G${EDGE_STYLE}│\x1b[0m`

// The backdrop's cells from to to (not included) on screen row r, dimmed.
const dim = (r, from, to) => (from < to ? `${DIM}${slice(backdrop[r], from, to)}\x1b[0m` : '')

// The window Alt+D was pressed in, as it looked then: each of its panes'
// text, laid out on the screen.
function captureBackdrop() {
  if (!FRAME || !UNDER) return
  try {
    const list = execFileSync('tmux', ['list-panes', '-t', UNDER, '-F', '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const panes = list
      .trim()
      .split('\n')
      .map(line => {
        const [id, left, top, width_, height] = line.split(' ')
        const text = execFileSync('tmux', ['capture-pane', '-p', '-t', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        return { left: Number(left), top: Number(top), width: Number(width_), height: Number(height), lines: text.split('\n') }
      })
    backdrop = compose(panes, process.stdout.columns, process.stdout.rows)
  } catch {
    // The window closed meanwhile: the frame sits on a blank screen.
  }
}

// Each frame goes out in one write, inside synchronized output, and every row
// overwrites itself instead of the screen being cleared first, so the terminal
// never shows a half-drawn frame while zooming or panning.
function draw() {
  const w = inner()
  const b = box()
  const cols = process.stdout.columns
  const { rows, setup } = pictureRows()
  const body = [...(HEADER ? [header()] : []), chipRow(w), ...rows, footer(w)]
  const boxed = FRAME ? [frameTop(b.w), ...body.map(framed(b)), frameBottom(b.w)] : body
  let frame = `\x1b[?2026h${setup}`
  for (let r = 0; r < process.stdout.rows; r++) {
    const k = r - b.top
    const line =
      k >= 0 && k < boxed.length
        ? `${dim(r, 0, b.left)}\x1b[${b.left + 1}G${boxed[k]}${b.left + b.w < cols ? `\x1b[${b.left + b.w + 1}G${dim(r, b.left + b.w, cols)}` : ''}`
        : dim(r, 0, cols)
    frame += `\x1b[${r + 1};1H\x1b[2K${line}`
  }
  out(`${frame}\x1b[?2026l`)
}

const dropPicture = () => dropIds(pic)

let pending = false
function schedule() {
  if (pending) return
  pending = true
  setTimeout(() => {
    pending = false
    draw()
  }, 8)
}

// Drops the tab from the pane file, which the mod reads before its next
// change. Written whole and renamed in, so neither side reads half a file.
function closeTab(i) {
  if (!paneFile || !state.diagrams[i]) return
  state = dropTab(state, i, index)
  writeFileSync(`${paneFile}.tmp`, JSON.stringify(state))
  renameSync(`${paneFile}.tmp`, paneFile)
  select(state.current)
}

function zoom(factor, px, py) {
  const d = diagram()
  if (!d || !view) return
  view = zoomAt(d, region(), view, factor, px, py)
  schedule()
}

function pan(dx, dy) {
  const d = diagram()
  if (!d || !view) return
  view = panBy(d, region(), view, dx, dy)
  schedule()
}

// Pointer position in pixels from the picture region's top left.
const pointer = (x, y) => pointerAt(x, y, { left: box().left + EDGE, top: pictureTop(), cell, pixelMouse })

function onMouse(button, x, y, released) {
  const { px, py } = pointer(x, y)
  if (button & 64) return zoom((button & 1) === 0 ? ZOOM_STEP : 1 / ZOOM_STEP, px, py)
  if (released) {
    drag = undefined
    return
  }
  if (button & 32) {
    if (drag) pan(px - drag.px, py - drag.py)
    drag = { px, py }
    return
  }
  if ((button & 3) !== 0) return
  const { row, col } = cellAt(x, y, { cell, pixelMouse })
  // A click on the dimmed window round the frame closes it, as a click
  // outside a popup would.
  const b = box()
  if (col <= b.left || col > b.left + b.w || row <= b.top || row > b.top + b.h) return quit()
  const mode = HEADER && row === 1 && modeAt(col)
  if (mode?.exit) return quit(mode.exit)
  const c = row === chipLine() && chips.find(t => col >= t.from && col <= t.to)
  if (c && col >= c.close) return closeTab(c.i)
  if (c) return select(c.i)
  drag = { px, py }
}

function onKey(key) {
  const r = region()
  const stepX = r.cols * r.cw * PAN_STEP
  const stepY = r.rows * r.ch * PAN_STEP
  const center = [(r.cols * r.cw) / 2, (r.rows * r.ch) / 2]
  const [action, a, b] = keyAction(key, { frame: FRAME, count: state.diagrams.length }) ?? []
  if (action === 'quit') quit()
  // A wrapper that shares the split with another program (the Ghostty
  // viewer) sets DV_TAB_EXIT to the exit code it switches on.
  else if (action === 'tab') TAB_EXIT && quit(TAB_EXIT)
  else if (action === 'pan') pan(a * stepX, b * stepY)
  else if (action === 'zoom') zoom(a > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ...center)
  else if (action === 'home') select(index)
  else if (action === 'step') select(index + a)
  else if (action === 'jump') select(a)
  else if (action === 'close') closeTab(index)
}

function onInput(data) {
  for (const t of parseInput(data.toString('utf8'))) {
    if (t.mouse) onMouse(t.mouse.button, t.mouse.x, t.mouse.y, t.mouse.released)
    else if (t.cell) {
      cell = { cw: t.cell.cw || cell.cw, ch: t.cell.ch || cell.ch }
      schedule()
    } else if (t.pixels !== undefined) pixelMouse = t.pixels
    else onKey(t.key)
  }
}

function quit(code = 0) {
  try {
    out(dropPicture())
    out('\x1b[?1016l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  } catch {
    // The pane is already gone.
  }
  process.exit(code)
}

if (!process.stdin.isTTY) {
  console.error('diagram-view needs a terminal.')
  process.exit(1)
}

mkdirSync(PANES, { recursive: true })
tmuxCell()
captureBackdrop()
process.stdin.setRawMode(true)
process.stdin.on('data', onInput)
process.on('SIGWINCH', () => {
  out('\x1b[16t')
  schedule()
})
process.on('SIGTERM', () => quit())
process.on('SIGHUP', () => quit())
// Alternate screen, no cursor, button and drag reports in SGR form with pixel
// positions where the terminal has them; then ask for the cell size and
// whether pixel positions took.
out('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1016h\x1b[16t\x1b[?1016$p')

watch(PANES, (_, name) => {
  if (!FOLLOWS || `${PANES}/${name}` === paneFile) setTimeout(readState, 30)
})
try {
  watch(dirname(TAB_CHANGED), (_, name) => {
    if (name === 'tab-changed') setTimeout(readState, 30)
  })
} catch {
  // No layout state folder: outside the layout, nothing changes tabs.
}
readState()
schedule()
