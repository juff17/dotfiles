// The one-line text input every typing field shares: the hub's filter and
// new-agent form, the help filter, and the todo prompts. Only the editing
// and the fitting live here; each field keeps its own keys around them
// (Enter, Esc, Tab, field moves, suggestions) and its own look.
//
// The caret is `at` code points into the text, not UTF-16 units, so an
// emoji is one step and is never cut in half; widths are in terminal cells,
// so a CJK character or an emoji takes two.

import { charWidth, width as cells } from './term.mjs'

export const length = text => [...text].length

// The most of text, from its start or its end, that fits in w cells.
export function head(text, w) {
  let out = ''
  let used = 0
  for (const ch of text) {
    if (used + charWidth(ch) > w) break
    out += ch
    used += charWidth(ch)
  }
  return out
}
export function tail(text, w) {
  let out = ''
  let used = 0
  for (const ch of [...text].reverse()) {
    if (used + charWidth(ch) > w) break
    out = ch + out
    used += charWidth(ch)
  }
  return out
}

const LEFT = ['\x1b[D']
const RIGHT = ['\x1b[C']
const WORD_LEFT = ['\x1b[1;5D', '\x1b[1;3D', '\x1bb']
const WORD_RIGHT = ['\x1b[1;5C', '\x1b[1;3C', '\x1bf']
const HOME = ['\x1b[H', '\x1b[1~', '\x01']
const END = ['\x1b[F', '\x1b[4~', '\x05']

// Pasted or typed text put in at the caret.
export function insertAt(text, at, s) {
  const chars = [...text]
  const i = Math.max(0, Math.min(at ?? chars.length, chars.length))
  return { text: chars.toSpliced(i, 0, ...s).join(''), at: i + length(s) }
}

// The line after one key, with the caret `at` in (undefined is the end).
// The arrows, Home and End (or Ctrl+A and Ctrl+E) move the caret, Ctrl or
// Alt with an arrow a word; backspace and Delete take the character before
// or under it, Ctrl+U everything before it, Ctrl+K everything after, Ctrl+W
// the word before; any other printable key goes in at the caret. Any other
// key changes nothing. The caret steps over zero-width marks, so it never
// sits on one.
export function editLine(text, at, key) {
  const chars = [...text]
  let i = Math.max(0, Math.min(at ?? chars.length, chars.length))
  const zero = j => j < chars.length && charWidth(chars[j]) === 0
  const done = (out, to) => ({ text: out.join(''), at: to })
  if (LEFT.includes(key)) {
    i = Math.max(0, i - 1)
    while (i > 0 && zero(i)) i--
    return done(chars, i)
  }
  if (RIGHT.includes(key)) {
    i = Math.min(chars.length, i + 1)
    while (zero(i)) i++
    return done(chars, i)
  }
  if (WORD_LEFT.includes(key)) {
    while (i > 0 && /\s/.test(chars[i - 1])) i--
    while (i > 0 && !/\s/.test(chars[i - 1])) i--
    return done(chars, i)
  }
  if (WORD_RIGHT.includes(key)) {
    while (i < chars.length && /\s/.test(chars[i])) i++
    while (i < chars.length && !/\s/.test(chars[i])) i++
    return done(chars, i)
  }
  if (HOME.includes(key)) return done(chars, 0)
  if (END.includes(key)) return done(chars, chars.length)
  if (key === '\x7f' || key === '\b') return i ? done(chars.toSpliced(i - 1, 1), i - 1) : done(chars, 0)
  if (key === '\x1b[3~') return done(chars.toSpliced(i, 1), i)
  if (key === '\x15') return done(chars.slice(i), 0)
  if (key === '\x0b') return done(chars.slice(0, i), i)
  if (key === '\x17') {
    const before = chars.slice(0, i).join('').replace(/\S*\s*$/, '')
    return done([...before, ...chars.slice(i)], length(before))
  }
  if (!key.startsWith('\x1b') && key >= ' ') return insertAt(text, i, key)
  return done(chars, i)
}

// editLine on `state[field]`, with the caret kept in `state.at`. The caret
// at the end leaves `at` off, so a state that never moved it has none. Says
// what changed: 'text', 'caret', or '' when the key did nothing.
export function editField(state, field, key) {
  const was = state[field]
  const wasAt = state.at ?? length(was)
  const { text, at } = editLine(was, state.at, key)
  state[field] = text
  if (at < length(text)) state.at = at
  else delete state.at
  return text !== was ? 'text' : at !== wasAt ? 'caret' : ''
}

// The text either side of the caret, for a field that draws its caret as a
// bar between characters.
export function splitAt(text, at) {
  const chars = [...text]
  const i = at ?? chars.length
  return [chars.slice(0, i).join(''), chars.slice(i).join('')]
}

// A line cut to w cells around the caret, for a field that draws its caret
// as a block on a character: the text before it, the character under it
// (with any marks on it; a space at the end), and the text after. All of it
// when it fits; else cut from the start up to just before the caret, leaving
// the character under it and one more, and cut at the end.
export function caretParts(text, at, w) {
  const chars = [...text]
  let i = Math.max(0, Math.min(at ?? chars.length, chars.length))
  const before = chars.slice(0, i).join('')
  let j = i + 1
  while (j < chars.length && charWidth(chars[j]) === 0) j++
  const under = i < chars.length ? chars.slice(i, j).join('') : ' '
  const after = chars.slice(j).join('')
  if (cells(before) + cells(under) + cells(after) <= w) return { before, under, after }
  const lead = tail(before, Math.max(0, w - cells(under) - cells(head(after, 1))))
  return { before: lead, under, after: head(after, Math.max(0, w - cells(lead) - cells(under))) }
}

// Marks the caret in a line, for a field that wraps: a one-cell stand-in
// that wraps with the text, which caretShown then draws as the caret.
export const CARET_MARK = ''
export const withCaret = (text, at) => {
  const chars = [...text]
  return chars.toSpliced(at ?? chars.length, 0, CARET_MARK).join('')
}

// A line with the caret mark in it, drawn: the character after the mark in
// reverse video, or a reverse-video space when nothing follows it on the line.
export const caretShown = line =>
  line.replace(new RegExp(`${CARET_MARK}(.[\\p{Mn}\\p{Me}\\u200b-\\u200f\\ufe0f]*)?`, 'u'), (_, ch) => `\x1b[7m${ch ?? ' '}\x1b[27m`)
