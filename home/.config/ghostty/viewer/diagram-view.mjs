#!/usr/bin/env node
// dv: shows the diagrams that jstack's diagram-pane mod draws, in the viewer
// pane of the Ghostty layout. The mod renders each to a PNG and lists a
// session's tabs in a file per tmux pane beside the PNGs (panes/); dv shows the
// file of the window's active tab, so it runs outside Claude Code. Closing a
// tab rewrites that file, and the mod picks the change up before its next.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import { deleteImage, gridRow, placeGrid, transmitFile } from './kitty.mjs'
import { clampView, home, panBy, placement, zoomAt } from './view.mjs'

const DIR = `${process.env.XDG_CACHE_HOME || `${homedir()}/.cache`}/claude-diagram-pane`
const PANES = `${DIR}/panes`
// The window's tab session as `socket:session` (bin/ghostty-claude-start sets
// it). Without it, dv shows whichever pane's tabs changed last.
const [TABS_SOCKET, TABS_SESSION] = (process.env.DV_TABS ?? '').split(':')
// The tab session touches this file when the active tab changes (tmux.conf).
const TAB_CHANGED = `${process.env.XDG_RUNTIME_DIR || '/tmp'}/ghostty-layout/tab-changed`
const ZOOM_STEP = 1.15
const PAN_STEP = 0.2
const TAB_MAX = 18
const TAB_EXIT = Number(process.env.DV_TAB_EXIT) || 0
const DIFF_EXIT = Number(process.env.DV_DIFF_EXIT) || 0
// Rows around the picture: the mode header and the tab row above, the hint
// row below.
const TOP = 3
const CHROME_ROWS = 3
// The mode header names the viewer pane's other modes when it shares the pane
// with them: Files (DV_TAB_EXIT, which Tab goes to) and Diff (DV_DIFF_EXIT).
// Clicking one exits with its code.
const MODES = [
  { label: ' Diagrams ', exit: 0 },
  { label: ' Files ', exit: TAB_EXIT },
  { label: ' Diff ', exit: DIFF_EXIT },
].filter((m, i) => i === 0 || m.exit)

const out = s => process.stdout.write(s)

let state = { diagrams: [], current: 0 }
// The pane file dv is showing.
let paneFile = ''
let index = 0
let view
// Cell size in pixels, until the terminal answers the size query.
let cell = { cw: 10, ch: 20 }
let pixelMouse = false
let drag
let tabs = []
// Two ids taken in turn, so a new picture lands before the old one goes.
let shownId = 0
let shownFile = ''
// The grid the picture was last placed in, so a pan doesn't place it again.
// A new grid goes to the other of two placements: tmux sends a placement on to
// the terminal at once but the cells only at its next redraw, and old cells
// naming the old placement keep drawing the right slice until then.
let placedGrid = ''
let placedId = 1

const region = () => ({
  cols: process.stdout.columns,
  rows: Math.max(1, process.stdout.rows - CHROME_ROWS),
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

// The active tab's pane file, or the pane file written last.
function activePaneFile() {
  if (TABS_SESSION) {
    try {
      const args = ['-L', TABS_SOCKET, 'display', '-p', '-t', `${TABS_SESSION}:`, '#{pane_id}']
      const pane = execFileSync('tmux', args, { encoding: 'utf8' }).trim()
      return `${PANES}/${TABS_SOCKET}-${pane.replace('%', '')}.json`
    } catch {
      return ''
    }
  }
  const newest = readdirSync(PANES)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ name, at: statSync(`${PANES}/${name}`).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]
  return newest ? `${PANES}/${newest.name}` : ''
}

function readState() {
  paneFile = activePaneFile()
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
    const jumped = next.current !== state.current || next.diagrams.length !== state.diagrams.length
    state = next
    if (jumped || !diagram()) select(Math.min(state.current, state.diagrams.length - 1))
    else schedule()
  } catch {
    // Read while Claude Code was still writing it; the next change event reads it whole.
  }
}

function select(i) {
  index = Math.max(0, Math.min(i, state.diagrams.length - 1))
  view = diagram() ? home(diagram()) : undefined
  schedule()
}

const truncate = title => (title.length > TAB_MAX ? `${title.slice(0, TAB_MAX - 1)}…` : title)

// Keys in blue, what they do dimmed.
const hint = pairs => pairs.map(([key, what]) => `\x1b[34m${key}\x1b[0;2m ${what}\x1b[0m`).join('  ')

function header() {
  const line = MODES.map((m, i) => (i === 0 ? `\x1b[7;1m${m.label}\x1b[0m` : `\x1b[2m${m.label}\x1b[0m`)).join(' ')
  if (!TAB_EXIT) return line
  return `${line}\x1b[${process.stdout.columns - 'tab switch'.length + 1}G${hint([['tab', 'switch']])}`
}

// The mode under a column of the header, counted from 1.
function modeAt(col) {
  let from = 1
  for (const m of MODES) {
    if (col >= from && col < from + m.label.length) return m
    from += m.label.length + 1
  }
}

// The diagrams, the current one underlined in blue, each with a × that
// closes it.
function tabRow() {
  tabs = []
  let line = ''
  let col = 1
  state.diagrams.forEach((d, i) => {
    const label = ` ${truncate(d.title)} `
    const width = label.length + 2
    if (col + width > process.stdout.columns) return
    tabs.push({ i, from: col, to: col + width - 1, close: col + label.length })
    const title = i === index ? `\x1b[4;58;5;4m${label}\x1b[0m` : `\x1b[2m${label}\x1b[0m`
    line += `${title}\x1b[2m×\x1b[0m  `
    col += width + 1
  })
  return line
}

function hintRow() {
  const zoom = view && view.zoom > 1 ? `  \x1b[2m${view.zoom.toFixed(1)}x\x1b[0m` : ''
  return hint([['[ ]', 'tabs'], ['scroll', 'zoom'], ['drag', 'pan'], ['q', 'quit']]) + zoom
}

// The picture region's rows: a message on the first, or the picture's
// placeholder cells, centered.
function pictureRows() {
  const rows = Array(region().rows).fill('')
  const d = diagram()
  if (!d) {
    rows[0] = '\x1b[2mAsk Claude for a diagram and it shows here.\x1b[0m'
    return { rows, setup: dropPicture() }
  }
  if (!existsSync(d.file)) {
    rows[0] = '\x1b[2mThis PNG is gone from the cache. Open its tab in Claude to draw it again.\x1b[0m'
    return { rows, setup: dropPicture() }
  }
  let setup = ''
  if (d.file !== shownFile) {
    const id = shownId === 1 ? 2 : 1
    setup += transmitFile(id, d.file)
    if (shownId) setup += deleteImage(shownId)
    shownId = id
    shownFile = d.file
    placedGrid = ''
  }
  view = clampView(d, region(), view ?? home(d))
  const at = placement(d, region(), view)
  const grid = `${shownId} ${at.gridCols} ${at.gridRows}`
  if (grid !== placedGrid) {
    placedId = placedId === 1 ? 2 : 1
    setup += placeGrid(shownId, placedId, at.gridCols, at.gridRows)
    placedGrid = grid
  }
  for (let r = 0; r < at.rows; r++) {
    rows[at.row + r] = `\x1b[${at.col + 1}G${gridRow(shownId, placedId, at.gridRow + r, at.gridCol, at.cols)}`
  }
  return { rows, setup }
}

// Each frame goes out in one write, inside synchronized output, and every row
// overwrites itself instead of the screen being cleared first, so the terminal
// never shows a half-drawn frame while zooming or panning.
function draw() {
  const { rows, setup } = pictureRows()
  const lines = [header(), tabRow(), ...rows, hintRow()]
  let frame = `\x1b[?2026h${setup}`
  lines.forEach((line, i) => {
    frame += `\x1b[${i + 1};1H\x1b[2K${line}`
  })
  out(`${frame}\x1b[?2026l`)
}

function dropPicture() {
  const s = shownId ? deleteImage(shownId) : ''
  shownId = 0
  shownFile = ''
  placedGrid = ''
  return s
}

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
  if (!paneFile) return
  const diagrams = state.diagrams.filter((_, n) => n !== i)
  const current = Math.max(0, Math.min(i < index ? index - 1 : index, diagrams.length - 1))
  state = { ...state, diagrams, current }
  writeFileSync(`${paneFile}.tmp`, JSON.stringify(state))
  renameSync(`${paneFile}.tmp`, paneFile)
  select(current)
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
const pointer = (x, y) =>
  pixelMouse ? { px: x - 1, py: y - 1 - (TOP - 1) * cell.ch } : { px: (x - 0.5) * cell.cw, py: (y - TOP + 0.5) * cell.ch }

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
  const row = pixelMouse ? Math.floor((y - 1) / cell.ch) + 1 : y
  const col = pixelMouse ? Math.floor((x - 1) / cell.cw) + 1 : x
  const mode = row === 1 && modeAt(col)
  if (mode?.exit) return quit(mode.exit)
  const tab = row === 2 && tabs.find(t => col >= t.from && col <= t.to)
  if (tab && col >= tab.close) return closeTab(tab.i)
  if (tab) return select(tab.i)
  drag = { px, py }
}

function onKey(key) {
  const r = region()
  const stepX = r.cols * r.cw * PAN_STEP
  const stepY = r.rows * r.ch * PAN_STEP
  const center = [(r.cols * r.cw) / 2, (r.rows * r.ch) / 2]
  const actions = {
    q: () => quit(),
    '\x03': () => quit(),
    // A wrapper that shares the split with another program (the Ghostty
    // viewer) sets DV_TAB_EXIT to the exit code it switches on.
    '\t': () => TAB_EXIT && quit(TAB_EXIT),
    h: () => pan(stepX, 0),
    l: () => pan(-stepX, 0),
    k: () => pan(0, stepY),
    j: () => pan(0, -stepY),
    '\x1b[D': () => pan(stepX, 0),
    '\x1b[C': () => pan(-stepX, 0),
    '\x1b[A': () => pan(0, stepY),
    '\x1b[B': () => pan(0, -stepY),
    '+': () => zoom(ZOOM_STEP, ...center),
    '=': () => zoom(ZOOM_STEP, ...center),
    '-': () => zoom(1 / ZOOM_STEP, ...center),
    0: () => select(index),
    '[': () => select(index - 1),
    ']': () => select(index + 1),
  }
  actions[key]?.()
}

const INPUT =
  /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[6;(\d+);(\d+)t|\x1b\[\?1016;(\d)\$y|\x1b\[[ABCD]|\x1b\[[^a-zA-Z]*[a-zA-Z~]|[\s\S]/g

function onInput(data) {
  for (const m of data.toString('utf8').matchAll(INPUT)) {
    if (m[1] !== undefined) onMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'm')
    else if (m[5] !== undefined) {
      const ch = Number(m[5]) || cell.ch
      const cw = Number(m[6]) || cell.cw
      cell = { cw, ch }
      schedule()
    } else if (m[7] !== undefined) pixelMouse = m[7] === '1' || m[7] === '3'
    else onKey(m[0])
  }
}

function quit(code = 0) {
  out(dropPicture())
  out('\x1b[?1016l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  process.exit(code)
}

if (!process.stdin.isTTY) {
  console.error('diagram-view needs a terminal.')
  process.exit(1)
}

mkdirSync(PANES, { recursive: true })
tmuxCell()
process.stdin.setRawMode(true)
process.stdin.on('data', onInput)
process.on('SIGWINCH', () => {
  out('\x1b[16t')
  schedule()
})
process.on('SIGTERM', () => quit())
// Alternate screen, no cursor, button and drag reports in SGR form with pixel
// positions where the terminal has them; then ask for the cell size and
// whether pixel positions took.
out('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1016h\x1b[16t\x1b[?1016$p')

watch(PANES, (_, name) => {
  if (!TABS_SESSION || `${PANES}/${name}` === paneFile) setTimeout(readState, 30)
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
