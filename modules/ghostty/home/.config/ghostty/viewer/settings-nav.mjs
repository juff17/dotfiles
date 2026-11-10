// The ⚙ settings panel's state and what keys do to it, apart from the
// terminal so it can be tested; settings-view.mjs draws it. The state is
// { sec, sel, flag, scroll, note, input }: the section, the setting in it,
// which flag ←/→ is on in a row of flags, the body's scroll, the footer's
// note (set when a save fails or a key can't do what it would), and the
// name and command being typed for a new viewer mode. Changes are saved to
// hub/settings.mjs's file as they're made. It's keys only: clicks do nothing.

import { BOLD, P, fg } from '../hub/term.mjs'
import { BUILTIN_MODES, SECTIONS, addedId, isAdded, load, modeName, reset, set, show, step, toggleFlag } from '../hub/settings.mjs'

export const NAV = 22
// Title, gap, the section's note, gap above the body; footer below it.
export const TOP = 4
export const BOTTOM = 1
// The value column's width, at the right of the body.
export const VALUE = 30

export const start = id => ({ sec: Math.max(0, SECTIONS.findIndex(s => s.id === id)), sel: 0, flag: 0, scroll: 0, note: null, input: null })

// A list of modes as the rows ↑/↓ moves between: one a mode, then one to add
// a mode. Each carries the list's key, so a row knows which setting it's in.
export const modeRows = (r, values = load()) => [
  ...values[r.key].map((m, index) => ({ key: r.key, type: 'mode', index, mode: m, label: modeName(m) })),
  { key: r.key, type: 'addMode', label: '+ Add a mode' },
]

// What a mode's second line says: what it shows, or for one you added, its
// command.
export const modeSub = m => BUILTIN_MODES.find(b => b.id === m.id)?.sub ?? `${m.cmd} · added by you, x removes it`

// The rows ↑/↓ moves between: the section's settings, not the lines that
// only say where an agent's instructions are; a list of modes is a row each.
export const items = s => SECTIONS[s.sec].rows.filter(r => r.key).flatMap(r => (r.type === 'modes' ? modeRows(r) : [r]))
export const current = s => items(s)[s.sel]

// A setting's value as spans, `on` when it's the selected one.
export function valueSpans(r, v, on, flag) {
  if (r.type === 'bool') return [[v ? '● on' : '○ off', fg(v ? P.green : P.sub)]]
  if (r.type === 'flags')
    return r.choices.flatMap((c, i) => {
      const has = v.includes(c.value)
      const here = on && i === flag
      return [
        [`${has ? '■' : '□'} ${c.label}`, here ? BOLD + fg(P.blue) : fg(has ? P.text : P.sub)],
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

const say = (s, text) => {
  s.note = { text, color: P.peach }
}

// The modes with one changed by fn(list), which returns the new list, or a
// note to show instead.
function editModes(s, fn) {
  const r = current(s)
  const out = fn(load()[r.key].map(m => ({ ...m })))
  if (typeof out === 'string') return say(s, out)
  save(s, () => set(r.key, out))
}

// Space, ↵, ← or → on a mode: on or off, keeping one on.
function flipMode(s) {
  const { index } = current(s)
  editModes(s, list => {
    list[index].on = !list[index].on
    return list.some(m => m.on) ? list : 'One mode has to stay on'
  })
}

// J or K on a mode: it swaps places with the one above or below, and stays
// selected.
function moveMode(s, dir) {
  const { index, key } = current(s)
  const to = index + dir
  if (to < 0 || to >= load()[key].length) return
  editModes(s, list => {
    ;[list[index], list[to]] = [list[to], list[index]]
    return list
  })
  if (!s.note) pickRow(s, s.sel + dir)
}

// x on a mode you added takes it out of the list.
function removeMode(s) {
  const { index, mode } = current(s)
  if (!isAdded(mode.id)) return say(s, `${modeName(mode)} is built in: space turns it off`)
  editModes(s, list => {
    list.splice(index, 1)
    return list.some(m => m.on) ? list : 'One mode has to stay on'
  })
  pickRow(s, s.sel)
}

// r on a mode: the built-in modes back in their order and on; ones you added
// stay, after them, as they were.
function resetModes(s) {
  editModes(s, list => [...BUILTIN_MODES.map(b => ({ id: b.id, on: true })), ...list.filter(m => isAdded(m.id))])
}

// a, or ↵ on Add a mode: the footer asks for a name, then the command.
export function startAdd(s) {
  const at = items(s).findIndex(i => i.type === 'addMode')
  if (at < 0) return
  s.sel = at
  s.input = { field: 'name', name: '', text: '' }
  s.note = null
}

// A key while the footer asks for a mode: typing, ⌫, ↵ for the next step
// and esc to give up.
function inputKey(s, key) {
  const input = s.input
  if (key === '\x1b' || key === '\x03') {
    s.input = null
    return
  }
  if (key === '\x7f' || key === '\b') {
    input.text = [...input.text].slice(0, -1).join('')
    return
  }
  if (key === '\r') {
    const text = input.text.trim()
    if (!text) return say(s, input.field === 'name' ? 'Give it a name first' : 'Give it a command to run')
    if (input.field === 'name') {
      s.input = { field: 'cmd', name: text.slice(0, 24), text: '' }
      s.note = null
      return
    }
    s.input = null
    editModes(s, list => [...list, { id: addedId(input.name, list), name: input.name, cmd: text.slice(0, 500), on: true }])
    if (!s.note) pickRow(s, items(s).findIndex(i => i.type === 'addMode') - 1)
    return
  }
  if (key.length === 1 && key >= ' ') typeText(s, key)
}

// Typed or pasted text, tabs and line breaks left out.
export function typeText(s, text) {
  if (!s.input) return
  const most = s.input.field === 'name' ? 24 : 500
  s.input.text = (s.input.text + text.replace(/[\t\r\n]/g, ' ')).slice(0, most)
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
  if (r.type === 'mode') flipMode(s)
  else if (r.type === 'addMode') return
  else if (r.type === 'flags') s.flag = (s.flag + dir + r.choices.length) % r.choices.length
  else save(s, () => set(r.key, step(r, load()[r.key], dir)))
}

// Space or ↵: a switch or flag turned over, else the next value.
export function toggle(s) {
  const r = current(s)
  if (r.type === 'mode') return flipMode(s)
  if (r.type === 'addMode') return startAdd(s)
  const v = load()[r.key]
  if (r.type === 'flags') save(s, () => set(r.key, toggleFlag(r, v, r.choices[s.flag].value)))
  else save(s, () => set(r.key, step(r, v, 1)))
}

// J/K: on a mode, moves it; anywhere else, the next or previous section.
const shift = (s, dir) => (current(s)?.type === 'mode' ? moveMode(s, dir) : pickSection(s, s.sec + dir))

// r: the setting's default.
function resetRow(s) {
  const r = current(s)
  if (r.type === 'mode' || r.type === 'addMode') resetModes(s)
  else save(s, () => reset(r.key))
}

// A key; 'quit' when it closes the panel.
export function onKey(s, key) {
  if (s.input) return void inputKey(s, key)
  const modes = items(s).some(i => i.type === 'addMode')
  const actions = {
    q: () => 'quit',
    '\x1b': () => 'quit',
    '\x03': () => 'quit',
    // Alt+S opened it; in the popup it reaches here.
    '\x1bs': () => 'quit',
    j: () => pickRow(s, s.sel + 1),
    k: () => pickRow(s, s.sel - 1),
    '\x1b[B': () => pickRow(s, s.sel + 1),
    '\x1b[A': () => pickRow(s, s.sel - 1),
    g: () => pickRow(s, 0),
    G: () => pickRow(s, Infinity),
    '\t': () => pickSection(s, s.sec + 1),
    '\x1b[Z': () => pickSection(s, s.sec - 1),
    J: () => shift(s, 1),
    K: () => shift(s, -1),
    h: () => change(s, -1),
    l: () => change(s, 1),
    '\x1b[D': () => change(s, -1),
    '\x1b[C': () => change(s, 1),
    ' ': () => toggle(s),
    '\r': () => toggle(s),
    r: () => resetRow(s),
    ...(modes && { a: () => startAdd(s), x: () => current(s).type === 'mode' && removeMode(s) }),
  }
  return Object.hasOwn(actions, key) && actions[key]() === 'quit' ? 'quit' : undefined
}
