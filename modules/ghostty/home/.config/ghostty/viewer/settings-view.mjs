#!/usr/bin/env node
// The rail's ⚙ settings panel, laid out like Alt+H's keys: the sections down
// the left, the selected one's settings on the right. Every change is saved
// to hub/settings.mjs's file as it's made; a setting changed from its default
// carries a peach dot, and r puts it back. It runs in a tmux popup
// (bin/ghostty-settings), where tmux's own bindings don't apply. What keys do
// is in settings-nav.mjs; it takes no clicks.
//   settings-view.mjs [section id]   the section it opens on

import { existsSync } from 'node:fs'

import { BOLD, P, bg, enter, fg, leave, paint, render, split, tokens, width } from '../hub/term.mjs'
import { SECTIONS, settingsFile, load, show } from '../hub/settings.mjs'
import { fileOf, instructions } from '../hub/prompts.mjs'
import { BOTTOM, NAV, TOP, VALUE, current, modeRows, modeSub, onKey, start, typeText, valueSpans } from './settings-nav.mjs'

const s = start(process.argv[2])

const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24
const bodyRows = () => Math.max(1, rows() - TOP - BOTTOM)
const BASE = bg(P.base)
const SEL = bg(P.surface0)
const tilde = p => p.replace(process.env.HOME ?? '\0', '~')

// The right side: each heading, then two lines a setting: its name and value,
// and what it does. An agent with instructions of yours has two lines too:
// how many there are, and the file they're in. A list of modes has two lines
// a mode and two to add one, then a line on what turning one off does. `at`
// maps a setting to its first line, for scrolling.
function content(w, values) {
  const lines = []
  const at = []
  let i = 0
  for (const r of SECTIONS[s.sec].rows) {
    if (r.type === 'modes') {
      for (const m of modeRows(r, values)) {
        const on = i === s.sel
        const fill = on ? SEL : BASE
        const add = m.type === 'addMode'
        const name = add ? m.label : `⠿ ${m.index + 1}  ${m.label}`
        const value = add ? [['a', fg(P.blue)], [' add', fg(P.sub)]] : valueSpans({ type: 'bool' }, m.mode.on, on)
        at.push(lines.length)
        lines.push(render([['  '], [name, (on ? BOLD : '') + fg(add ? P.blue : P.text)]], w - VALUE, fill) + render(value, VALUE, fill))
        const sub = add ? 'a name, then any command to run in the left pane' : modeSub(m.mode)
        lines.push(render([[`  ${sub}`, fg(P.overlay1)]], w, fill))
        i++
      }
      lines.push(render([[`  ${r.sub}`, fg(P.overlay1)]], w, BASE))
      continue
    }
    if (r.head) {
      if (lines.length) lines.push(render([], w, BASE))
      lines.push(render([[r.head.toUpperCase(), BOLD + fg(P.peach)]], w, BASE))
      continue
    }
    if (r.prompt) {
      const count = instructions(r.prompt).split('\n').filter(l => l.trim()).length
      // Install copies it from its .example (after-link.sh).
      const value = !existsSync(fileOf(r.prompt)) ? 'no file yet: run install' : count ? `${count} line${count === 1 ? '' : 's'}` : 'none'
      lines.push(
        render([['  Your instructions', fg(P.text)]], w - VALUE, BASE) + render([[value, fg(count ? P.text : P.overlay1)]], VALUE, BASE),
      )
      lines.push(render([[`  ${tilde(fileOf(r.prompt))}`, fg(P.overlay1)]], w, BASE))
      continue
    }
    const on = i === s.sel
    const fill = on ? SEL : BASE
    const v = values[r.key]
    const changed = JSON.stringify(v) !== JSON.stringify(r.default)
    const vw = r.type === 'flags' ? Math.min(w - 20, r.choices.reduce((n, c) => n + width(c.label) + 3, 0)) : VALUE
    at.push(lines.length)
    lines.push(
      render([[changed ? '• ' : '  ', fg(P.peach)], [r.label, (on ? BOLD : '') + fg(P.text)]], w - vw, fill) +
        render(valueSpans(r, v, on, s.flag), vw, fill),
    )
    const sub = changed ? [r.sub, `default ${show(r, r.default)}`].filter(Boolean).join(' · ') : r.sub
    lines.push(render([[`  ${sub}`, fg(P.overlay1)]], w, fill))
    i++
  }
  return { lines, at }
}

function navRow(i) {
  const on = i === s.sec
  return render([[` ${on ? '▸' : ' '} `, fg(P.blue)], [SECTIONS[i].name, on ? BOLD + fg(P.text) : fg(P.sub)]], NAV - 1, on ? SEL : BASE)
}

function draw() {
  const w = cols()
  const right = w - NAV - 2
  const { lines: body, at } = content(right, load())
  // Keep the selected setting's two lines in view, with the line above it,
  // which is its heading for the first under one; the first setting scrolls
  // to the top.
  const first = at[s.sel] ?? 0
  if (s.sel === 0 || first - 1 < s.scroll) s.scroll = s.sel === 0 ? 0 : first - 1
  if (first + 1 >= s.scroll + bodyRows()) s.scroll = first + 2 - bodyRows()
  s.scroll = Math.max(0, Math.min(s.scroll, Math.max(0, body.length - bodyRows())))

  const lines = [
    split([[` Settings · ${SECTIONS[s.sec].name}`, BOLD + fg(P.blue)]], [['esc', fg(P.text)], [' close ', fg(P.sub)]], w, BASE),
    render([], w, BASE),
    render([[` ${SECTIONS[s.sec].where}`, fg(P.sub)]], w, BASE),
    render([], w, BASE),
  ]
  for (let y = 0; y < bodyRows(); y++) {
    const nav = y < SECTIONS.length ? navRow(y) : render([], NAV - 1, BASE)
    const more = y === bodyRows() - 1 && s.scroll + bodyRows() < body.length
    const line = more ? render([['▾ more', fg(P.overlay1)]], right, BASE) : (body[s.scroll + y] ?? render([], right, BASE))
    lines.push(`${nav}${render([['│', fg(P.surface0)]], 1, BASE)}${BASE} ${line}`)
  }
  const r = current(s)
  const keys =
    r.type === 'mode'
      ? [['space', 'on/off'], ['J K', 'move'], ['x', 'remove'], ['a', 'add']]
      : r.type === 'addMode'
        ? [['↵', 'add a mode']]
        : r.type === 'flags'
      ? [['←→', 'pick'], ['space', 'turn on/off']]
      : r.type === 'bool'
        ? [['space', 'turn on/off']]
        : [['←→', 'change']]
  const hints = [['↑↓', 'setting'], ['tab', 'section'], ...keys, ['r', 'default']]
  lines.push(
    s.input
      ? promptLine(w)
      : split(
          [
            [' '],
            ...hints.flatMap(([k, what]) => [
              [k, fg(P.text)],
              [` ${what}  `, fg(P.sub)],
            ]),
          ],
          s.note ? [[`${s.note.text} `, fg(s.note.color)]] : [[`saved to ${tilde(settingsFile())} `, fg(P.overlay1)]],
          w,
          BASE,
        ),
  )
  paint(lines.slice(0, rows()))
}

// The footer while a new mode is typed: what it asks, the text so far with
// a cursor, and the keys.
function promptLine(w) {
  const { field, name, text } = s.input
  const ask = field === 'name' ? ' New mode’s name: ' : ` Command for ${name}: `
  const keys = [['↵', field === 'name' ? 'next' : 'add'], ['esc', 'cancel']].flatMap(([k, what]) => [
    [k, fg(P.text)],
    [` ${what}  `, fg(P.sub)],
  ])
  const right = s.note ? [[`${s.note.text} `, fg(s.note.color)], ...keys] : keys
  return split([[ask, BOLD + fg(P.blue)], [text, fg(P.text)], ['▏', fg(P.blue)]], right, w, BASE)
}

const quit = () => {
  leave()
  process.exit(0)
}

if (!process.stdin.isTTY) {
  console.error('settings-view needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.paste !== undefined) typeText(s, t.paste)
    else if (t.key && onKey(s, t.key) === 'quit') quit()
  }
  draw()
})
process.stdout.on('resize', draw)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
enter()
draw()
