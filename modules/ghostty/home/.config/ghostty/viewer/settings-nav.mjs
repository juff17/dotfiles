// The ⚙ settings panel's state and what keys do to it, apart from the
// terminal so it can be tested; settings-view.mjs draws it. The state is
// { sec, sel, flag, scroll, note, capture, input }: the section, the setting
// in it, which flag ←/→ is on in a row of flags, the body's scroll, the
// footer's note (set when a save fails or a key can't do what it would),
// whether a Keybinds row waits for its new key, and what the footer is
// typing: the name and command for a new viewer mode, or a file's path.
// Changes are saved to hub/settings.mjs's file as they're made. It's keys
// only: clicks do nothing. On a Keybinds row ↵ waits for the new key
// (s.capture) and backspace unbinds it.

import { statSync } from 'node:fs'

import { BOLD, P, fg } from '../hub/term.mjs'
import { editField, insertAt, length } from '../hub/line.mjs'
import { complete, suggestion } from '../hub/paths.mjs'
import { BUILTIN_MODES, SECTIONS, addedId, expandHome, isAdded, load, modeName, reset, row, set, show, step, toggleFlag } from '../hub/settings.mjs'
import { apply, captured, clash } from '../hub/keybinds.mjs'

// What a saved keybind does next; tests put a stand-in here.
export const effects = { applyKeys: apply }

export const NAV = 22
// Title, gap, the section's note, gap above the body; footer below it.
export const TOP = 4
export const BOTTOM = 1
// The value column's width, at the right of the body.
export const VALUE = 30

export const start = id => ({ sec: Math.max(0, SECTIONS.findIndex(s => s.id === id)), sel: 0, flag: 0, scroll: 0, note: null, capture: false, input: null })

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
export function valueSpans(r, v, on, flag, capture) {
  if (r.type === 'key') {
    if (on && capture) return [['press a key… ', BOLD + fg(P.peach)], ['esc cancels', fg(P.sub)]]
    return [[show(r, v), v ? (on ? BOLD : '') + fg(P.text) : fg(P.overlay1)]]
  }
  if (r.type === 'bool') return [[v ? '● on' : '○ off', fg(v ? P.green : P.sub)]]
  // A long path keeps its end, which names the file.
  if (r.type === 'file') {
    const text = v.length > VALUE - 1 ? `…${v.slice(-(VALUE - 2))}` : show(r, v)
    return [[text, v ? (on ? BOLD : '') + fg(P.text) : fg(P.overlay1)]]
  }
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
    if (current(s).type === 'key') effects.applyKeys()
  } catch (err) {
    s.note = { text: `Couldn't save: ${err.code ?? err.message}`, color: P.red }
  }
}

// A keybind set to spec ('' unbinds it), unless another key has it.
function bindKey(s, spec) {
  const r = current(s)
  const why = clash(r, spec)
  if (why) s.note = { text: `${why}; not saved`, color: P.red }
  else save(s, () => set(r.key, spec))
}

// The key pressed while a Keybinds row waits for one.
function onCapture(s, key) {
  s.capture = false
  if (key === '\x1b' || key === '\x03') return
  if (key === '\x7f') return bindKey(s, '')
  const spec = captured(current(s), key)
  if (spec) bindKey(s, spec)
  else s.note = { text: `Not a key it takes: ${current(s).kind === 'alt' ? 'alt' : 'ctrl+shift'} and a letter or digit`, color: P.red }
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
  if (input.field === 'file' && key !== '\r') return pathKey(s, key)
  if (key === '\x7f' || key === '\b') {
    input.text = [...input.text].slice(0, -1).join('')
    return
  }
  if (key === '\r') {
    const text = input.text.trim()
    if (input.field === 'file') return saveFile(s, input.key, text)
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

// ↵ on a typed path: saved if a file (or for a dir row, a folder) is there,
// or cleared when it's empty. A path that's wrong keeps the footer open to fix it.
function saveFile(s, key, path) {
  if (path && !/^(\/|~\/)/.test(path)) return say(s, 'Give the whole path, from / or ~/')
  const { dir } = row(key)
  let there = !path
  try {
    const st = statSync(expandHome(path))
    there ||= dir ? st.isDirectory() : st.isFile()
  } catch {}
  if (!there) return say(s, `No ${dir ? 'folder' : 'file'} at ${path}`)
  s.input = null
  // A completed folder ends in a slash; the setting is the folder itself.
  save(s, () => set(key, dir ? path.replace(/(.)\/+$/, '$1') : path))
}

// ↵ on a file row: the footer takes its path, starting from the one it has.
// `files` is whether completion offers files, or only folders.
function startFile(s) {
  const r = current(s)
  s.input = { field: 'file', key: r.key, label: r.label, text: load()[r.key], files: !r.dir, menu: null }
  s.note = null
}

// A key while a path is typed, as in a shell: Tab completes it and steps
// through the matches (Shift+Tab back), → or End at the end takes the dim
// suggestion, and the rest edit the line (hub/line.mjs: arrows, Ctrl+W,
// Ctrl+U and the like).
function pathKey(s, key) {
  const input = s.input
  const opts = { files: input.files }
  if (key === '\t' || (key === '\x1b[Z' && input.menu)) {
    const r = complete(input.text, input.menu, key === '\x1b[Z', opts)
    input.text = r.text
    input.menu = r.menu
    delete input.at
    return
  }
  input.menu = null
  const rest = pathGhost(input)
  if (rest && ['\x1b[C', '\x1b[F', '\x1b[4~', '\x05'].includes(key)) {
    input.text += rest
    return
  }
  // Ctrl+W takes back one part of the path, as zsh does, not the whole word.
  if (key === '\x17') {
    const chars = [...input.text]
    const at = input.at ?? chars.length
    const before = chars.slice(0, at).join('')
    const kept = before.replace(/[^/]*\/?$/, '')
    input.text = kept + chars.slice(at).join('')
    if (input.at !== undefined) input.at = length(kept)
    return
  }
  editField(input, 'text', key)
}

// The dim rest of the first match, while the caret is at the end and no
// menu is open.
export const pathGhost = input =>
  input.field === 'file' && !input.menu && (input.at ?? length(input.text)) === length(input.text) ? suggestion(input.text, { files: input.files }) : ''

// Typed or pasted text, tabs and line breaks left out.
export function typeText(s, text) {
  if (!s.input) return
  const most = s.input.field === 'name' ? 24 : 500
  const clean = text.replace(/[\t\r\n]/g, ' ')
  if (s.input.field === 'file') {
    s.input.menu = null
    const r = insertAt(s.input.text, s.input.at, clean)
    s.input.text = r.text.slice(0, most)
    if (r.at < length(s.input.text)) s.input.at = r.at
    else delete s.input.at
    return
  }
  s.input.text = (s.input.text + clean).slice(0, most)
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
  if (r.type === 'key' || r.type === 'file') return
  if (r.type === 'mode') flipMode(s)
  else if (r.type === 'addMode') return
  else if (r.type === 'flags') s.flag = (s.flag + dir + r.choices.length) % r.choices.length
  else save(s, () => set(r.key, step(r, load()[r.key], dir)))
}

// Space or ↵: a switch or flag turned over, else the next value.
export function toggle(s) {
  const r = current(s)
  if (r.type === 'key') {
    s.capture = true
    s.note = null
    return
  }
  if (r.type === 'mode') return flipMode(s)
  if (r.type === 'addMode') return startAdd(s)
  if (r.type === 'file') return startFile(s)
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
  if (s.capture) return void onCapture(s, key)
  // Alt+S (or the key it's rebound to) opened it; in the popup it reaches here.
  const own = load()['keys.settings']
  if (own && key === `\x1b${own.slice(-1)}`) return 'quit'
  const modes = items(s).some(i => i.type === 'addMode')
  const actions = {
    q: () => 'quit',
    '\x1b': () => 'quit',
    '\x03': () => 'quit',
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
    r: () => (current(s).type === 'key' ? bindKey(s, current(s).default) : resetRow(s)),
    '\x7f': () => (current(s).type === 'key' ? bindKey(s, '') : current(s).type === 'file' && save(s, () => set(current(s).key, ''))),
    ...(modes && { a: () => startAdd(s), x: () => current(s).type === 'mode' && removeMode(s) }),
  }
  return Object.hasOwn(actions, key) && actions[key]() === 'quit' ? 'quit' : undefined
}
