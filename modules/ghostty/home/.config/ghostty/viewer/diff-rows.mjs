// The Diff mode's rows as the terminal draws them, shared by the left pane's
// Diff (diff-view.mjs) and the Alt+A popup's diff of a push
// (approvals-view.mjs): a file with ▸ or ▾ for whether its diff is open, its
// status, path, counts and change bar, and each line of its diff under it.

import { changeCells, fit, fitPath } from './diff.mjs'

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
const fg = hex => `\x1b[38;2;${rgb(hex)}m`
const bg = hex => `\x1b[48;2;${rgb(hex)}m`

export const C = {
  text: fg('#cdd6f4'),
  sub: fg('#a6adc8'),
  overlay: fg('#6c7086'),
  line: fg('#45475a'),
  track: fg('#313244'),
  blue: fg('#89b4fa'),
  green: fg('#a6e3a1'),
  red: fg('#f38ba8'),
  yellow: fg('#f9e2af'),
  mauve: fg('#cba6f7'),
  crust: fg('#11111b'),
  cursorBg: bg('#313244'),
  addBg: bg('#292e37'),
  delBg: bg('#2f2738'),
  pillBg: bg('#89b4fa'),
  tabBg: bg('#cdd6f4'),
  bold: '\x1b[1m',
  reset: '\x1b[0m',
}
export const STATUS_COLORS = { M: C.yellow, T: C.yellow, A: C.green, '?': C.green, D: C.red, U: C.red, R: C.mauve, C: C.mauve }

// The change bar's cells.
export const BAR = 10

// The change bar scale for a list of files: the square root of the biggest
// file's change, as changeCells takes it.
export const scaleOf = files => Math.sqrt(Math.max(1, ...files.map(f => f.add + f.del)))

export function changeBar(file, most) {
  const [green, red, track] = changeCells(file, most, BAR)
  return `${C.green}${'━'.repeat(green)}${C.red}${'━'.repeat(red)}${C.track}${'━'.repeat(track)}${C.reset}`
}

// One file, `width` cells wide: ▾ when its diff is open, on the cursor's
// background when `selected`.
export function fileRow(file, { open, selected, width, most }) {
  const back = selected ? C.cursorBg : ''
  const counts = file.binary ? 'binary' : `+${file.add} −${file.del}`
  const countsText = file.binary ? `${C.sub}binary` : `${C.green}+${file.add} ${file.del ? C.red : C.line}−${file.del}`
  const right = ` ${' '.repeat(Math.max(0, 11 - counts.length))}${countsText}${C.reset}${back} ${changeBar(file, most)}${back} `
  const room = Math.max(4, width - 5 - 11 - BAR - 3)
  const { dir, name } = fitPath(file.path, room)
  const nameColor = open ? C.blue : C.text
  const pad = ' '.repeat(Math.max(0, room - dir.length - name.length))
  const status = `${STATUS_COLORS[file.status] ?? C.text}${C.bold}${file.status}${C.reset}${back}`
  return `${back} ${C.overlay}${open ? '▾' : '▸'}${C.reset}${back} ${status} ${C.overlay}${dir}${C.reset}${back}${nameColor}${C.bold}${name}${C.reset}${back}${pad}${right}${C.reset}`
}

// One line of an open file's diff, from diff.mjs's parseDiff.
export function diffRow(row, width) {
  const edge = `   ${C.blue}▎${C.reset}`
  const room = Math.max(1, width - 4 - 5 - 2)
  switch (row.kind) {
    case 'hunk':
      return `${edge}     ${C.mauve}${fit(row.text, room + 2)}${C.reset}`
    case 'note':
      return `${edge}       ${C.overlay}${fit(row.text, room)}${C.reset}`
    case 'add':
      return `${edge}${C.addBg}${C.overlay}${String(row.num).padStart(4)} ${C.green}+ ${fit(row.text, room)}${C.reset}`
    case 'del':
      return `${edge}${C.delBg}${C.overlay}${String(row.num).padStart(4)} ${C.red}- ${fit(row.text, room)}${C.reset}`
    default:
      return `${edge}${C.overlay}${String(row.num).padStart(4)} ${C.text}  ${fit(row.text, room)}${C.reset}`
  }
}
