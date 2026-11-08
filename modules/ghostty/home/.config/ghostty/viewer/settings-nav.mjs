// The ⚙ settings panel's state and what keys do to it, apart from the
// terminal so it can be tested; settings-view.mjs draws it. The state is
// { sec, sel, flag, scroll, note }: the section, the setting in it, which
// flag ←/→ is on in a row of flags, the body's scroll, and the footer's note
// (set when a save fails). Changes are saved to hub/settings.mjs's file as
// they're made. It's keys only: clicks do nothing.

import { BOLD, P, bg, fg } from '../hub/term.mjs'
import { SECTIONS, load, reset, set, show, step, toggleFlag } from '../hub/settings.mjs'

export const NAV = 22
// Title, gap, the section's note, gap above the body; footer below it.
export const TOP = 4
export const BOTTOM = 1
// The value column's width, at the right of the body.
export const VALUE = 30

export const start = id => ({ sec: Math.max(0, SECTIONS.findIndex(s => s.id === id)), sel: 0, flag: 0, scroll: 0, note: null })

export const items = s => SECTIONS[s.sec].rows.filter(r => r.key)
export const current = s => items(s)[s.sel]

// A setting's value as spans, `on` when it's the selected one.
export function valueSpans(r, v, on, flag) {
  if (r.type === 'bool') return [[v ? '● on' : '○ off', fg(v ? P.green : P.sub)]]
  if (r.type === 'flags')
    return r.choices.flatMap((c, i) => {
      const has = v.includes(c.value)
      const here = on && i === flag
      return [
        [`${has ? '■' : '□'} ${c.label}`, here ? BOLD + fg(P.crust) + bg(P.blue) : fg(has ? P.text : P.sub)],
        [' ', ''],
      ]
    })
  const text = show(r, v)
  return on ? [['‹ ', fg(P.blue)], [text, BOLD + fg(P.text)], [' ›', fg(P.blue)]] : [[text, fg(P.text)]]
}

function save(s, fn) {
  try {
    fn()
    s.note = null
  } catch (err) {
    s.note = { text: `Couldn't save: ${err.code ?? err.message}`, color: P.red }
  }
}

export function pickSection(s, i) {
  s.sec = (i + SECTIONS.length) % SECTIONS.length
  s.sel = 0
  s.flag = 0
  s.scroll = 0
}

export function pickRow(s, i) {
  s.sel = Math.max(0, Math.min(items(s).length - 1, i))
  s.flag = 0
}

// ←/→: the next value, or in a row of flags the next flag.
export function change(s, dir) {
  const r = current(s)
  if (r.type === 'flags') s.flag = (s.flag + dir + r.choices.length) % r.choices.length
  else save(s, () => set(r.key, step(r, load()[r.key], dir)))
}

// Space or ↵: a switch or flag turned over, else the next value.
export function toggle(s) {
  const r = current(s)
  const v = load()[r.key]
  if (r.type === 'flags') save(s, () => set(r.key, toggleFlag(r, v, r.choices[s.flag].value)))
  else save(s, () => set(r.key, step(r, v, 1)))
}

// A key; true when it closes the panel.
export function onKey(s, key) {
  const actions = {
    q: () => true,
    '\x1b': () => true,
    '\x03': () => true,
    j: () => pickRow(s, s.sel + 1),
    k: () => pickRow(s, s.sel - 1),
    '\x1b[B': () => pickRow(s, s.sel + 1),
    '\x1b[A': () => pickRow(s, s.sel - 1),
    g: () => pickRow(s, 0),
    G: () => pickRow(s, Infinity),
    '\t': () => pickSection(s, s.sec + 1),
    '\x1b[Z': () => pickSection(s, s.sec - 1),
    J: () => pickSection(s, s.sec + 1),
    K: () => pickSection(s, s.sec - 1),
    h: () => change(s, -1),
    l: () => change(s, 1),
    '\x1b[D': () => change(s, -1),
    '\x1b[C': () => change(s, 1),
    ' ': () => toggle(s),
    '\r': () => toggle(s),
    r: () => save(s, () => reset(current(s).key)),
  }
  return Object.hasOwn(actions, key) ? actions[key]() === true : false
}
