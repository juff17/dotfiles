// dv's logic, apart from the terminal so it can be tested: which pane file and
// diagram it shows, how the list changes when the mod rewrites the file or a
// tab closes, the picture's kitty ids, and what each key and click does.
// diagram-view.mjs draws it.

import { readdirSync, statSync } from 'node:fs'

import { P, fg, width } from '../hub/term.mjs'
import { deleteImage, placeGrid, transmitFile } from './kitty.mjs'

export const TAB_MAX = 24

// The tab's title for the frame: its folder, and its name when that isn't
// just the folder tmux named it after.
export const tabTitle = (dir, tab, name) => (name === dir ? `${dir} · tab ${tab}` : `${dir} · ${tab}:${name}`)

// The mod's file for a tmux pane, `%12` on socket `s` being `s-12.json`.
export const paneFile = (panes, socket, pane) => `${panes}/${socket}-${pane.replace('%', '')}.json`

// The pane file written last in panes, or '' when there's none.
export function newestPane(panes) {
  const newest = readdirSync(panes)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ name, at: statSync(`${panes}/${name}`).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]
  return newest ? `${panes}/${newest.name}` : ''
}

export const clampIndex = (i, count) => Math.max(0, Math.min(i, count - 1))

// After the pane file is read again: the diagram to select, or undefined to
// keep the one showing. The mod moving its current one, the list growing or
// shrinking, or another tab's file (switched) jumps to the mod's current one,
// which select() shows from its home view.
export function reread(prev, next, index, switched = false) {
  const jumped = switched || next.current !== prev.current || next.diagrams.length !== prev.diagrams.length
  if (jumped || !next.diagrams[index]) return Math.min(next.current, next.diagrams.length - 1)
}

// The pane file's state with diagram i closed. The one showing stays showing,
// or its neighbour does when it's the one closed.
export function dropTab(state, i, index) {
  const diagrams = state.diagrams.filter((_, n) => n !== i)
  const current = Math.max(0, Math.min(i < index ? index - 1 : index, diagrams.length - 1))
  return { ...state, diagrams, current }
}

export const truncate = title => (title.length > TAB_MAX ? `${title.slice(0, TAB_MAX - 1)}…` : title)

// The mode under a column of the header, counted from 1.
export function modeAt(modes, col) {
  let from = 1
  for (const m of modes) {
    if (col >= from && col < from + m.label.length) return m
    from += m.label.length + 1
  }
}

// Keys in the text color, what they do dimmed, as the hub's footer has them.
export const hints = pairs => pairs.flatMap(([key, what], i) => [[`${i ? '  ' : ''}${key}`, fg(P.text)], [` ${what}`, fg(P.sub)]])

// The footer's hints that fit in room cells: whole hints only, dropped from the
// end, but always the first.
export function fitHints(keys, room) {
  let shown = keys
  while (shown.length > 1 && hints(shown).reduce((n, [t]) => n + width(t), 0) > room) shown = shown.slice(0, -1)
  return shown
}

// The picture's kitty state. Two image ids taken in turn, so a new picture
// lands before the old one goes. The grid it was last placed in, so a pan
// doesn't place it again; a new grid goes to the other of two placements:
// tmux sends a placement on to the terminal at once but the cells only at its
// next redraw, and old cells naming the old placement keep drawing the right
// slice until then.
export const picture = () => ({ shownId: 0, shownFile: '', placedGrid: '', placedId: 1 })

// The commands that show file, when it isn't the one showing already.
export function showFile(pic, file) {
  if (file === pic.shownFile) return ''
  const id = pic.shownId === 1 ? 2 : 1
  let setup = transmitFile(id, file)
  if (pic.shownId) setup += deleteImage(pic.shownId)
  pic.shownId = id
  pic.shownFile = file
  pic.placedGrid = ''
  return setup
}

// The command that places the picture in a grid of cols × rows, when it isn't
// placed in that grid already.
export function placeIn(pic, cols, rows) {
  const grid = `${pic.shownId} ${cols} ${rows}`
  if (grid === pic.placedGrid) return ''
  pic.placedId = pic.placedId === 1 ? 2 : 1
  pic.placedGrid = grid
  return placeGrid(pic.shownId, pic.placedId, cols, rows)
}

export function dropPicture(pic) {
  const s = pic.shownId ? deleteImage(pic.shownId) : ''
  pic.shownId = 0
  pic.shownFile = ''
  pic.placedGrid = ''
  return s
}

// Pointer position in pixels from the picture region's top left, given the
// region's left column and top row (from 1 for the row). With pixel reports
// x and y are pixels from 1; otherwise cells, taken at their middle.
export const pointer = (x, y, { left, top, cell, pixelMouse }) =>
  pixelMouse
    ? { px: x - 1 - left * cell.cw, py: y - 1 - (top - 1) * cell.ch }
    : { px: (x - left - 0.5) * cell.cw, py: (y - top + 0.5) * cell.ch }

// The screen cell, from 1, a click is in.
export const cellAt = (x, y, { cell, pixelMouse }) =>
  pixelMouse ? { col: Math.floor((x - 1) / cell.cw) + 1, row: Math.floor((y - 1) / cell.ch) + 1 } : { col: x, row: y }

// What a key does, as [action, ...args]: `quit`, `tab` (DV_TAB_EXIT's mode),
// `pan` by a share of the region each way, `zoom` in (1) or out (-1), `home`
// to fit, `step` to the previous or next diagram, `jump` to one, `close` it.
// In the diagrams window (frame), Esc and Alt+D close it, as they close the
// hub's popups; layout.conf passes Alt+D through to it.
export function keyAction(key, { frame, count }) {
  if (frame && (key === '\x1b' || key === '\x1bd')) return ['quit']
  if (/^[1-9]$/.test(key)) return Number(key) <= count ? ['jump', Number(key) - 1] : undefined
  const actions = {
    q: ['quit'],
    '\x03': ['quit'],
    '\t': ['tab'],
    h: ['pan', 1, 0],
    l: ['pan', -1, 0],
    k: ['pan', 0, 1],
    j: ['pan', 0, -1],
    '\x1b[D': ['pan', 1, 0],
    '\x1b[C': ['pan', -1, 0],
    '\x1b[A': ['pan', 0, 1],
    '\x1b[B': ['pan', 0, -1],
    '+': ['zoom', 1],
    '=': ['zoom', 1],
    '-': ['zoom', -1],
    0: ['home'],
    '[': ['step', -1],
    ']': ['step', 1],
    x: ['close'],
  }
  return Object.hasOwn(actions, key) ? actions[key] : undefined
}

const INPUT =
  /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[6;(\d+);(\d+)t|\x1b\[\?1016;(\d)\$y|\x1b\[[ABCD]|\x1b\[[^a-zA-Z]*[a-zA-Z~]|\x1b[a-z]|[\s\S]/g

// Terminal input, one token at a time: SGR mouse reports, the answer to the
// cell size query (`cell`, a 0 meaning the terminal didn't say), the answer
// to whether pixel mouse positions took (`pixels`), and keys.
export function* parseInput(text) {
  for (const m of text.matchAll(INPUT)) {
    if (m[1] !== undefined) yield { mouse: { button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), released: m[4] === 'm' } }
    else if (m[5] !== undefined) yield { cell: { ch: Number(m[5]), cw: Number(m[6]) } }
    else if (m[7] !== undefined) yield { pixels: m[7] === '1' || m[7] === '3' }
    else yield { key: m[0] }
  }
}
