#!/usr/bin/env node
// The rail's ⚙ settings panel, laid out like Alt+H's keys: the sections down
// the left, the selected one's settings on the right. Every change is saved
// to hub/settings.mjs's file as it's made; a setting changed from its default
// carries a peach dot, and r puts it back. It runs in a tmux popup
// (bin/ghostty-settings), where tmux's own bindings don't apply. What keys do
// is in settings-nav.mjs; it takes no clicks.
//   settings-view.mjs [section id]   the section it opens on

import { spawnSync } from 'node:child_process'

import { BOLD, P, bg, enter, fg, leave, paint, render, split, tokens, width } from '../hub/term.mjs'
import { SECTIONS, settingsFile, load, show } from '../hub/settings.mjs'
import { AGENTS, ensureFile, instructions, skillOf } from '../hub/prompts.mjs'
import { BOTTOM, NAV, TOP, VALUE, current, fixedPart, fullPrompt, isPrompts, onKey, start, valueSpans, wrap } from './settings-nav.mjs'

const s = start(process.argv[2])

const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24
const bodyRows = () => Math.max(1, rows() - TOP - BOTTOM)
const BASE = bg(P.base)
const SEL = bg(P.surface0)
const tilde = p => p.replace(process.env.HOME ?? '\0', '~')

// The right side: each heading, then two lines a setting: its name and value,
// and what it does. `at` and `end` are each setting's first and last line,
// for scrolling.
function content(w, values) {
  const lines = []
  const at = []
  const end = []
  let i = 0
  for (const r of SECTIONS[s.sec].rows) {
    if (r.head) {
      if (lines.length) lines.push(render([], w, BASE))
      lines.push(render([[r.head.toUpperCase(), BOLD + fg(P.peach)]], w, BASE))
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
    end.push(lines.length - 1)
    i++
  }
  return { lines, at, end }
}

// Prompts: a block per agent, in three bands: its skill, the fixed part
// (dimmed, its first lines) and your instructions (bright).
const BAND = 8
const ACT = 10
const FIXED_LINES = 3
function promptBlocks(w) {
  const lines = []
  const at = []
  const end = []
  const tw = w - BAND - ACT
  AGENTS.forEach((a, i) => {
    const on = i === s.sel
    const fill = on ? SEL : BASE
    const dim = fg(on ? P.sub : P.overlay1)
    const band = (name, spans, act = '') =>
      lines.push(render([[`  ${name}`, dim]], BAND, fill) + render(spans, tw, fill) + render([[act, dim]], ACT, fill))
    if (lines.length) lines.push(render([], w, BASE))
    at.push(lines.length)
    lines.push(render([[a.name.toUpperCase(), BOLD + fg(P.peach)]], w, fill))
    if (a.linked) band('skill', [[fixedPart(a.id), dim]], 'linked')
    else {
      const skill = skillOf(a.id)
      const text = skill ? `/${skill}` : 'none'
      band('skill', on ? [['‹ ', fg(P.blue)], [text, BOLD + fg(P.text)], [' ›', fg(P.blue)]] : [[text, fg(skill ? P.text : P.overlay1)]])
      const fixed = wrap(fixedPart(a.id), tw)
      fixed.slice(0, FIXED_LINES).forEach((l, n) => {
        const more = n === FIXED_LINES - 1 && fixed.length > FIXED_LINES
        band(n === 0 ? 'fixed' : '', [[more ? `${l.slice(0, -2)} …` : l, dim]], n === 0 ? 'locked' : '')
      })
    }
    const yours = instructions(a.id)
    const first = wrap(yours, tw)
    band('yours', yours ? [[first[0] + (first.length > 1 ? ' …' : ''), fg(P.text)]] : [['(none)', fg(P.overlay1)]], 'e edit')
    end.push(lines.length - 1)
  })
  return { lines, at, end }
}

function navRow(i) {
  const on = i === s.sec
  return render([[` ${on ? '▸' : ' '} `, fg(P.blue)], [SECTIONS[i].name, on ? BOLD + fg(P.text) : fg(P.sub)]], NAV - 1, on ? SEL : BASE)
}

const hintSpans = hints => [
  [' '],
  ...hints.flatMap(([k, what]) => [
    [k, fg(P.text)],
    [` ${what}  `, fg(P.sub)],
  ]),
]

function footerRight() {
  if (s.note) return [[`${s.note.text} `, fg(s.note.color)]]
  // The prompts folder's full path is too long beside the keys; it's in the
  // dotfiles repo, beside hub/.
  const id = s.view ?? (isPrompts(s) && current(s).id)
  return [[`${id ? `prompts/${id}.md` : `saved to ${tilde(settingsFile())}`} `, fg(P.overlay1)]]
}

// An agent's whole prompt over the panel, as Claude gets it.
function drawView(w) {
  const a = AGENTS.find(x => x.id === s.view)
  const tw = w - 4
  const body = []
  for (const part of fullPrompt(a.id)) {
    if (body.length) body.push(render([], w, BASE))
    body.push(render([[`  ${part.tag}`, BOLD + fg(P.peach)]], w, BASE))
    for (const l of wrap(part.text, tw)) body.push(render([[`  ${l}`, fg(P.text)]], w, BASE))
  }
  const room = bodyRows()
  s.viewScroll = Math.max(0, Math.min(s.viewScroll, body.length - room))
  const lines = [
    split([[` Settings · Prompts › ${a.name}`, BOLD + fg(P.blue)]], [['esc', fg(P.text)], [' back ', fg(P.sub)]], w, BASE),
    render([], w, BASE),
    render([[` what ${a.about} is sent; {braces} are filled in when it starts`, fg(P.sub)]], w, BASE),
    render([], w, BASE),
  ]
  for (let y = 0; y < room; y++) {
    const more = y === room - 1 && s.viewScroll + room < body.length
    lines.push(more ? render([['  ▾ more', fg(P.overlay1)]], w, BASE) : (body[s.viewScroll + y] ?? render([], w, BASE)))
  }
  lines.push(split(hintSpans([['↑↓', 'scroll'], ['e', 'edit yours'], ['esc', 'back']]), footerRight(), w, BASE))
  paint(lines.slice(0, rows()))
}

function draw() {
  const w = cols()
  if (s.view) return drawView(w)
  const right = w - NAV - 2
  const { lines: body, at, end } = isPrompts(s) ? promptBlocks(right) : content(right, load())
  // Keep the selected setting in view, with the line above it, which is its
  // heading for the first under one; the first setting scrolls to the top.
  const first = at[s.sel] ?? 0
  const last = end[s.sel] ?? first
  if (s.sel === 0 || first - 1 < s.scroll) s.scroll = s.sel === 0 ? 0 : first - 1
  if (last >= s.scroll + bodyRows()) s.scroll = last + 1 - bodyRows()
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
  const keys = isPrompts(s)
    ? [...(r.linked ? [] : [['←→', 'skill']]), ['e', 'edit yours'], ['v', 'full prompt'], ['r', 'clear yours']]
    : r.type === 'flags'
      ? [['←→', 'pick'], ['space', 'turn on/off'], ['r', 'default']]
      : r.type === 'bool'
        ? [['space', 'turn on/off'], ['r', 'default']]
        : [['←→', 'change'], ['r', 'default']]
  lines.push(split(hintSpans([['↑↓', isPrompts(s) ? 'agent' : 'setting'], ['tab', 'section'], ...keys]), footerRight(), w, BASE))
  paint(lines.slice(0, rows()))
}

const quit = () => {
  leave()
  process.exit(0)
}

// Your instructions for the selected agent (or the open one) in $VISUAL or
// $EDITOR, else nvim or vi, on the panel's terminal; back to the panel after.
function edit() {
  const id = s.view ?? current(s).id
  let file
  try {
    file = ensureFile(id)
  } catch (err) {
    s.note = { text: `Couldn't make the file: ${err.code ?? err.message}`, color: P.red }
    return
  }
  const editor =
    process.env.VISUAL || process.env.EDITOR || (spawnSync('sh', ['-c', 'command -v nvim'], { encoding: 'utf8' }).stdout.trim() ? 'nvim' : 'vi')
  leave()
  process.stdin.setRawMode(false)
  // Through sh so an editor given with its options (`code -w`) works.
  const run = spawnSync('sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' })
  process.stdin.setRawMode(true)
  enter()
  s.note = run.status === 0 ? null : { text: `${editor} exited with ${run.error?.code ?? run.status}`, color: P.red }
}

if (!process.stdin.isTTY) {
  console.error('settings-view needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (!t.key) continue
    const action = onKey(s, t.key)
    if (action === 'quit') quit()
    if (action === 'edit') edit()
  }
  draw()
})
process.stdout.on('resize', draw)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
enter()
draw()
