// Alt+H's overlay state and what keys and clicks do to it, apart from the
// terminal so it can be tested; help-view.mjs draws it. The state is
// { sel, query, at, typing, scroll, maxScroll }: the selected section, the
// filter, its caret (hub/line.mjs; none is the end) and whether it's being
// typed, and the body's scroll, at most maxScroll (which drawing sets from
// the body's length).

import { editField, insertAt, length } from '../hub/line.mjs'
import { width } from '../hub/term.mjs'
import { SECTIONS, filter, startAt } from './help.mjs'
import { load } from '../hub/settings.mjs'

export const NAV = 24
// Title, gap, filter, gap above the body; footer below it.
export const TOP = 4
export const BOTTOM = 1
// The filter's row, counted from 1.
export const FILTER_ROW = 3

export const start = place => ({ sel: startAt(place), query: '', typing: false, scroll: 0, maxScroll: 0 })

export const filtering = s => s.query.trim() !== ''

// The sections the right side shows: the matches while filtering, else the
// selected one.
export const shown = s => (filtering(s) ? filter(s.query) : [SECTIONS[s.sel]])

// The key column's width: the longest key and a gap, between 15 and 22.
export const keyWidth = groups => Math.min(22, Math.max(12, ...groups.flatMap(g => g.keys.map(k => width(k.key)))) + 3)

// Sets the furthest the body can scroll, and pulls the scroll back to it.
export function fitScroll(s, lines, rows) {
  s.maxScroll = Math.max(0, lines - rows)
  s.scroll = Math.min(s.scroll, s.maxScroll)
}

export function pick(s, i) {
  s.sel = Math.max(0, Math.min(SECTIONS.length - 1, i))
  s.query = ''
  delete s.at
  s.typing = false
  s.scroll = 0
}

export const scrollBy = (s, n) => {
  s.scroll = Math.max(0, Math.min(s.maxScroll, s.scroll + n))
}

// A key while the filter is being typed. Changing it scrolls back to the
// top; moving the caret doesn't. ↑ and ↓ scroll instead of moving it.
export function onTyping(s, key) {
  if (key === '\x1b') {
    s.query = ''
    delete s.at
    s.typing = false
  } else if (key === '\r') s.typing = false
  else if (key === '\x1b[A') return scrollBy(s, -1)
  else if (key === '\x1b[B') return scrollBy(s, 1)
  else if (editField(s, 'query', key) !== 'text') return
  s.scroll = 0
}

// A key; true when it closes the overlay. `page` is half the body.
export function onKey(s, key, page) {
  // Alt+H opened it, or the key Settings › Keybinds moved it to.
  const own = load()['keys.help']
  if (key === '\x1bh' || key === '\x03' || (own && key === `\x1b${own.slice(-1)}`)) return true
  if (s.typing) return void onTyping(s, key)
  const on = filtering(s)
  const move = n => (on ? scrollBy(s, n) : pick(s, s.sel + n))
  const actions = {
    q: () => true,
    '\x1b': () => (on ? pick(s, s.sel) : true),
    '/': () => {
      s.typing = true
      delete s.at
    },
    j: () => move(1),
    k: () => move(-1),
    '\x1b[B': () => move(1),
    '\x1b[A': () => move(-1),
    '\t': () => pick(s, (s.sel + 1) % SECTIONS.length),
    '\x1b[Z': () => pick(s, (s.sel + SECTIONS.length - 1) % SECTIONS.length),
    g: () => (on ? scrollBy(s, -Infinity) : pick(s, 0)),
    G: () => (on ? scrollBy(s, Infinity) : pick(s, SECTIONS.length - 1)),
    J: () => scrollBy(s, 1),
    K: () => scrollBy(s, -1),
    '\x04': () => scrollBy(s, page),
    '\x15': () => scrollBy(s, -page),
    '\x1b[6~': () => scrollBy(s, page),
    '\x1b[5~': () => scrollBy(s, -page),
  }
  return Object.hasOwn(actions, key) ? actions[key]() === true : false
}

// A click picks a section on the left, or starts typing on the filter's row;
// the wheel scrolls.
export function onMouse(s, { button, x, y, up }) {
  if (up) return
  if (button === 64) return scrollBy(s, -3)
  if (button === 65) return scrollBy(s, 3)
  if ((button & 3) !== 0 || button & 96) return
  const i = y - TOP - 1
  if (x < NAV && i >= 0 && i < SECTIONS.length) pick(s, i)
  else if (y === FILTER_ROW) {
    s.typing = true
    delete s.at
  }
}

// Pasted text goes into the filter only while it's being typed, on one line.
export const onPaste = (s, text) => {
  if (!s.typing) return
  const { text: query, at } = insertAt(s.query, s.at, text.replace(/\s+/g, ' '))
  s.query = query
  if (at < length(query)) s.at = at
  else delete s.at
}

// The footer's keys for the state it's in.
export const footerHints = s =>
  s.typing
    ? [['↵', 'keep'], ['esc', 'clear'], ['↑ ↓', 'scroll']]
    : [['j k', filtering(s) ? 'scroll' : 'section'], ['/', 'filter'], ['esc', filtering(s) ? 'clear' : 'close']]
