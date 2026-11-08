#!/usr/bin/env node
// The rail's ⚙ settings panel, laid out like Alt+H's keys: the sections down
// the left, the selected one's settings on the right. Every change is saved
// to hub/settings.mjs's file as it's made; a setting changed from its default
// carries a peach dot, and r puts it back. It runs in a tmux popup
// (bin/ghostty-settings), where tmux's own bindings don't apply.
//   settings-view.mjs [section id]   the section it opens on

import { BOLD, P, bg, enter, fg, leave, paint, render, split, tokens, width } from '../hub/term.mjs'
import { FILE, SECTIONS, load, reset, set, show, step, toggleFlag } from '../hub/settings.mjs'

const NAV = 22
// Title, gap, the section's note, gap above the body; footer below it.
const TOP = 4
const BOTTOM = 1
const VALUE = 30

let sec = Math.max(0, SECTIONS.findIndex(s => s.id === process.argv[2]))
let sel = 0
// Which flag ←/→ is on, in a row of flags.
let flag = 0
let scroll = 0
let note = null

const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24
const bodyRows = () => Math.max(1, rows() - TOP - BOTTOM)
const BASE = bg(P.base)
const SEL = bg(P.surface0)
const items = () => SECTIONS[sec].rows.filter(r => r.key)
const current = () => items()[sel]
const tilde = p => p.replace(process.env.HOME ?? '\0', '~')

function valueSpans(r, v, on) {
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

// The right side: each heading, then two lines a setting: its name and value,
// and what it does. `at` maps a setting to its first line, for scrolling and
// clicks.
function content(w, values) {
  const lines = []
  const at = []
  let i = 0
  for (const r of SECTIONS[sec].rows) {
    if (r.head) {
      if (lines.length) lines.push(render([], w, BASE))
      lines.push(render([[r.head.toUpperCase(), BOLD + fg(P.peach)]], w, BASE))
      continue
    }
    const on = i === sel
    const fill = on ? SEL : BASE
    const v = values[r.key]
    const changed = JSON.stringify(v) !== JSON.stringify(r.default)
    const vw = r.type === 'flags' ? Math.min(w - 20, r.choices.reduce((n, c) => n + width(c.label) + 3, 0)) : VALUE
    at.push(lines.length)
    lines.push(
      render([[changed ? '• ' : '  ', fg(P.peach)], [r.label, (on ? BOLD : '') + fg(P.text)]], w - vw, fill) +
        render(valueSpans(r, v, on), vw, fill),
    )
    const sub = changed ? [r.sub, `default ${show(r, r.default)}`].filter(Boolean).join(' · ') : r.sub
    lines.push(render([[`  ${sub}`, fg(P.overlay1)]], w, fill))
    i++
  }
  return { lines, at }
}

function navRow(i) {
  const s = SECTIONS[i]
  const on = i === sec
  return render([[` ${on ? '▸' : ' '} `, fg(P.blue)], [s.name, on ? BOLD + fg(P.text) : fg(P.sub)]], NAV - 1, on ? SEL : BASE)
}

let layout = { at: [], right: 0 }
function draw() {
  const w = cols()
  const right = w - NAV - 2
  const values = load()
  const { lines: body, at } = content(right, values)
  layout = { at, right }
  // Keep the selected setting's two lines in view, with the line above it,
  // which is its heading for the first under one; the first setting scrolls
  // to the top.
  const first = at[sel] ?? 0
  if (sel === 0 || first - 1 < scroll) scroll = sel === 0 ? 0 : first - 1
  if (first + 1 >= scroll + bodyRows()) scroll = first + 2 - bodyRows()
  scroll = Math.max(0, Math.min(scroll, Math.max(0, body.length - bodyRows())))

  const lines = [
    split([[` Settings · ${SECTIONS[sec].name}`, BOLD + fg(P.blue)]], [['esc', fg(P.text)], [' close ', fg(P.sub)]], w, BASE),
    render([], w, BASE),
    render([[` ${SECTIONS[sec].where}`, fg(P.sub)]], w, BASE),
    render([], w, BASE),
  ]
  for (let y = 0; y < bodyRows(); y++) {
    const nav = y < SECTIONS.length ? navRow(y) : render([], NAV - 1, BASE)
    const more = y === bodyRows() - 1 && scroll + bodyRows() < body.length
    const line = more ? render([['▾ more', fg(P.overlay1)]], right, BASE) : (body[scroll + y] ?? render([], right, BASE))
    lines.push(`${nav}${render([['│', fg(P.surface0)]], 1, BASE)}${BASE} ${line}`)
  }
  const r = current()
  const keys =
    r.type === 'flags'
      ? [['←→', 'pick'], ['space', 'turn on/off']]
      : r.type === 'bool'
        ? [['space', 'turn on/off']]
        : [['←→', 'change']]
  const hints = [['j k', 'setting'], ['tab', 'section'], ...keys, ['r', 'default']]
  lines.push(
    split(
      [
        [' '],
        ...hints.flatMap(([k, what]) => [
          [k, fg(P.text)],
          [` ${what}  `, fg(P.sub)],
        ]),
      ],
      note ? [[`${note.text} `, fg(note.color)]] : [[`saved to ${tilde(FILE)} `, fg(P.overlay1)]],
      w,
      BASE,
    ),
  )
  paint(lines.slice(0, rows()))
}

const quit = () => {
  leave()
  process.exit(0)
}

function save(fn) {
  try {
    fn()
    note = null
  } catch (err) {
    note = { text: `Couldn't save: ${err.code ?? err.message}`, color: P.red }
  }
}

function pickSection(i) {
  sec = (i + SECTIONS.length) % SECTIONS.length
  sel = 0
  flag = 0
  scroll = 0
}

function pickRow(i) {
  sel = Math.max(0, Math.min(items().length - 1, i))
  flag = 0
}

function change(dir) {
  const r = current()
  const v = load()[r.key]
  if (r.type === 'flags') flag = (flag + dir + r.choices.length) % r.choices.length
  else save(() => set(r.key, step(r, v, dir)))
}

function toggle() {
  const r = current()
  const v = load()[r.key]
  if (r.type === 'flags') save(() => set(r.key, toggleFlag(r, v, r.choices[flag].value)))
  else save(() => set(r.key, step(r, v, 1)))
}

function onKey(key) {
  const actions = {
    q: quit,
    '\x1b': quit,
    '\x03': quit,
    j: () => pickRow(sel + 1),
    k: () => pickRow(sel - 1),
    '\x1b[B': () => pickRow(sel + 1),
    '\x1b[A': () => pickRow(sel - 1),
    g: () => pickRow(0),
    G: () => pickRow(Infinity),
    '\t': () => pickSection(sec + 1),
    '\x1b[Z': () => pickSection(sec - 1),
    J: () => pickSection(sec + 1),
    K: () => pickSection(sec - 1),
    h: () => change(-1),
    l: () => change(1),
    '\x1b[D': () => change(-1),
    '\x1b[C': () => change(1),
    ' ': toggle,
    '\r': toggle,
    r: () => save(() => reset(current().key)),
  }
  actions[key]?.()
}

function onMouse({ button, x, y, up }) {
  if (up) return
  if (button === 64) return pickRow(sel - 1)
  if (button === 65) return pickRow(sel + 1)
  if ((button & 3) !== 0 || button & 96) return
  const i = y - TOP - 1
  if (x < NAV) {
    if (i >= 0 && i < SECTIONS.length) pickSection(i)
    return
  }
  const line = scroll + i
  const hit = layout.at.findIndex(a => line === a || line === a + 1)
  if (hit < 0) return
  if (hit !== sel) return pickRow(hit)
  // A click on the value of the selected setting changes it, as space does.
  if (x > NAV + 1 + layout.right - VALUE && current().type !== 'flags') toggle()
}

if (!process.stdin.isTTY) {
  console.error('settings-view needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.mouse) onMouse(t.mouse)
    else if (t.key) onKey(t.key)
  }
  draw()
})
process.stdout.on('resize', draw)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
enter()
draw()
