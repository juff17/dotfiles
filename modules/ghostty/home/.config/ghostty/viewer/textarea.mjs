// A multi-line text field, apart from the terminal so it can be tested: its
// state is { lines, row, col }, the cursor's line and its place in it, in
// characters (code points, so an emoji is one).

import { charWidth } from '../hub/term.mjs'

const chars = s => [...s]
const len = s => chars(s).length

// Starts with the cursor at the end.
export function fromText(text) {
  const lines = text.split('\n')
  return { lines, row: lines.length - 1, col: len(lines.at(-1)) }
}

export const toText = t => t.lines.join('\n')

// Text typed or pasted at the cursor, newlines and all.
export function insert(t, text) {
  const parts = text.replace(/\r\n?/g, '\n').split('\n')
  const line = chars(t.lines[t.row])
  const before = line.slice(0, t.col).join('')
  const after = line.slice(t.col).join('')
  const last = parts.length - 1
  t.lines.splice(t.row, 1, ...parts.map((p, i) => (i === 0 ? before : '') + p + (i === last ? after : '')))
  t.row += last
  t.col = (last === 0 ? len(before) : 0) + len(parts[last])
  return t
}

function backspace(t) {
  if (t.col > 0) {
    const line = chars(t.lines[t.row])
    line.splice(t.col - 1, 1)
    t.lines[t.row] = line.join('')
    t.col--
  } else if (t.row > 0) {
    t.col = len(t.lines[t.row - 1])
    t.lines.splice(t.row - 1, 2, t.lines[t.row - 1] + t.lines[t.row])
    t.row--
  }
}

function del(t) {
  if (t.col < len(t.lines[t.row])) {
    const line = chars(t.lines[t.row])
    line.splice(t.col, 1)
    t.lines[t.row] = line.join('')
  } else if (t.row < t.lines.length - 1) t.lines.splice(t.row, 2, t.lines[t.row] + t.lines[t.row + 1])
}

// Ctrl+U drops the line before the cursor; Ctrl+W the word before it.
function cut(t, pattern) {
  const line = chars(t.lines[t.row])
  const before = line.slice(0, t.col).join('').replace(pattern, '')
  t.lines[t.row] = before + line.slice(t.col).join('')
  t.col = len(before)
}

const moves = {
  '\x1b[D': t => (t.col > 0 ? t.col-- : t.row > 0 && ((t.row -= 1), (t.col = len(t.lines[t.row])))),
  '\x1b[C': t => (t.col < len(t.lines[t.row]) ? t.col++ : t.row < t.lines.length - 1 && ((t.row += 1), (t.col = 0))),
  '\x1b[A': t => t.row > 0 && ((t.row -= 1), (t.col = Math.min(t.col, len(t.lines[t.row])))),
  '\x1b[B': t => t.row < t.lines.length - 1 && ((t.row += 1), (t.col = Math.min(t.col, len(t.lines[t.row])))),
  '\x1b[H': t => (t.col = 0),
  '\x01': t => (t.col = 0),
  '\x1b[F': t => (t.col = len(t.lines[t.row])),
  '\x05': t => (t.col = len(t.lines[t.row])),
}

// A key: 'save' for Ctrl+S, 'cancel' for Esc, else it edits the field.
export function textKey(t, key) {
  if (key === '\x13') return 'save'
  if (key === '\x1b') return 'cancel'
  if (key === '\r') insert(t, '\n')
  else if (key === '\x7f' || key === '\b') backspace(t)
  else if (key === '\x1b[3~') del(t)
  else if (key === '\x15') cut(t, /[\s\S]*$/)
  else if (key === '\x17') cut(t, /\S*\s*$/)
  else if (Object.hasOwn(moves, key)) moves[key](t)
  else if (!key.startsWith('\x1b') && key >= ' ') insert(t, key)
  return undefined
}

// The field as rows `cols` cells wide, a long line carried on to the next
// row, and where the cursor is in them: its row, and how many characters of
// that row come before it.
export function layout(t, cols) {
  const rows = []
  let cursor = { y: 0, i: 0 }
  t.lines.forEach((line, r) => {
    let row = ''
    let used = 0
    let count = 0
    chars(line).forEach((ch, i) => {
      const w = charWidth(ch)
      if (used + w > cols) {
        rows.push(row)
        row = ''
        used = 0
        count = 0
      }
      if (r === t.row && i === t.col) cursor = { y: rows.length, i: count }
      row += ch
      used += w
      count++
    })
    if (r === t.row && t.col >= len(line)) {
      // The cursor past the end takes a cell of its own.
      if (used >= cols) {
        rows.push(row)
        row = ''
        count = 0
      }
      cursor = { y: rows.length, i: count }
    }
    rows.push(row)
  })
  return { rows, cursor }
}
