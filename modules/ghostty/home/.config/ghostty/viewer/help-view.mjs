#!/usr/bin/env node
// Alt+H's keys overlay, as the canvas's K2 draws it: the features down the
// left, the selected one's keys on the right, and / to filter every key at
// once. Keys that are easy to forget are peach. It runs in a tmux popup
// (bin/ghostty-help), where tmux's own bindings don't apply, so it reads
// Alt+H itself as close.
//   help-view.mjs [place]   the tmux window Alt+H was pressed in (work, hub,
//                           diagrams), which picks the section it opens on

import { BOLD, P, bg, enter, fg, leave, paint, render, split, tokens, width } from '../hub/term.mjs'
import { SECTIONS, filter, startAt } from './help.mjs'

const NAV = 24
// Title, gap, filter, gap above the body; footer below it.
const TOP = 4
const BOTTOM = 1

let sel = startAt(process.argv[2])
let query = ''
let typing = false
let scroll = 0

const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24
const bodyRows = () => Math.max(1, rows() - TOP - BOTTOM)
const BASE = bg(P.base)
const shown = () => (query.trim() ? filter(query) : [SECTIONS[sel]])

// The right side's lines: each section's name and where it applies, then a
// row per key, the keys in one column as wide as the longest.
function content(groups, w) {
  const keyW = Math.min(22, Math.max(12, ...groups.flatMap(g => g.keys.map(k => width(k.key)))) + 3)
  const lines = []
  for (const g of groups) {
    if (lines.length) lines.push([])
    lines.push([
      [g.name, BOLD + fg(g.color)],
      [`  ${g.where}`, fg(P.overlay1)],
    ])
    for (const k of g.keys) {
      lines.push([
        [k.key.padEnd(keyW - (width(k.key) - k.key.length)), BOLD + fg(k.rare ? P.peach : P.text)],
        [k.what, fg(P.text)],
      ])
    }
  }
  if (!groups.length) lines.push([[`No key matches “${query.trim()}”`, '\x1b[3m' + fg(P.sub)]])
  return lines.map(spans => render(spans, w, BASE))
}

function navRow(i, counts) {
  const s = SECTIONS[i]
  const filtering = query.trim() !== ''
  const n = filtering ? (counts.get(s.id) ?? 0) : s.keys.length
  const on = !filtering && i === sel
  const dim = filtering && !n
  const fill = on ? bg(P.surface0) : BASE
  const label = fg(dim ? P.surface1 : on ? P.text : P.sub) + (on ? BOLD : '')
  return split(
    [
      [' ● ', fg(dim ? P.surface1 : s.color)],
      [s.name, label],
    ],
    [[`${n} `, fg(P.overlay1)]],
    NAV - 1,
    fill,
  )
}

let maxScroll = 0
function draw() {
  const w = cols()
  const groups = shown()
  const counts = new Map(groups.map(g => [g.id, g.keys.length]))
  const right = w - NAV - 2
  const body = content(groups, right)
  maxScroll = Math.max(0, body.length - bodyRows())
  scroll = Math.min(scroll, maxScroll)

  const title = query.trim() ? `matching “${query.trim()}”` : SECTIONS[sel].name
  const lines = [
    split([[` Keys · ${title}`, BOLD + fg(P.blue)]], [['alt+h', fg(P.text)], [' close ', fg(P.sub)]], w, BASE),
    render([], w, BASE),
    render(
      [
        [' / ', BOLD + fg(P.blue)],
        ...(query || typing
          ? [[query, fg(P.text)], ...(typing ? [['▏', fg(P.blue)]] : [])]
          : [['filter every key: try close, tab, todo', fg(P.overlay1)]]),
      ],
      w,
      BASE,
    ),
    render([], w, BASE),
  ]
  for (let y = 0; y < bodyRows(); y++) {
    const nav = y < SECTIONS.length ? navRow(y, counts) : render([], NAV - 1, BASE)
    const more = y === bodyRows() - 1 && scroll < maxScroll
    const line = more ? render([['▾ more', fg(P.overlay1)]], right, BASE) : (body[scroll + y] ?? render([], right, BASE))
    lines.push(`${nav}${render([['│', fg(P.surface0)]], 1, BASE)}${BASE}  ${line}`)
  }
  const total = groups.reduce((n, g) => n + g.keys.length, 0)
  const hints = typing
    ? [['↵', 'keep'], ['esc', 'clear'], ['↑ ↓', 'scroll']]
    : [['j k', query.trim() ? 'scroll' : 'section'], ['/', 'filter'], ['esc', query.trim() ? 'clear' : 'close']]
  lines.push(
    split(
      [
        [' '],
        ...hints.flatMap(([k, what]) => [
          [k, fg(P.text)],
          [` ${what}  `, fg(P.sub)],
        ]),
        ['peach', BOLD + fg(P.peach)],
        [' easy to forget', fg(P.sub)],
      ],
      [[`${query.trim() ? `${total} keys` : `${sel + 1} / ${SECTIONS.length}`} `, fg(P.sub)]],
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

function pick(i) {
  sel = Math.max(0, Math.min(SECTIONS.length - 1, i))
  query = ''
  typing = false
  scroll = 0
}

const scrollBy = n => {
  scroll = Math.max(0, Math.min(maxScroll, scroll + n))
}

function onTyping(key) {
  if (key === '\x1b') {
    query = ''
    typing = false
  } else if (key === '\r') typing = false
  else if (key === '\x7f' || key === '\b') query = [...query].slice(0, -1).join('')
  else if (key === '\x15') query = ''
  else if (key === '\x17') query = query.replace(/\S*\s*$/, '')
  else if (key === '\x1b[A') scrollBy(-1)
  else if (key === '\x1b[B') scrollBy(1)
  else if (!key.startsWith('\x1b') && key >= ' ') query += key
  else return
  if (key !== '\x1b[A' && key !== '\x1b[B') scroll = 0
}

function onKey(key) {
  if (key === '\x1bh' || key === '\x03') return quit()
  if (typing) return onTyping(key)
  const filtering = query.trim() !== ''
  const page = Math.max(1, Math.floor(bodyRows() / 2))
  const move = n => (filtering ? scrollBy(n) : pick(sel + n))
  const actions = {
    q: quit,
    '\x1b': () => (filtering ? pick(sel) : quit()),
    '/': () => {
      typing = true
    },
    j: () => move(1),
    k: () => move(-1),
    '\x1b[B': () => move(1),
    '\x1b[A': () => move(-1),
    '\t': () => pick((sel + 1) % SECTIONS.length),
    '\x1b[Z': () => pick((sel + SECTIONS.length - 1) % SECTIONS.length),
    g: () => (filtering ? scrollBy(-Infinity) : pick(0)),
    G: () => (filtering ? scrollBy(Infinity) : pick(SECTIONS.length - 1)),
    J: () => scrollBy(1),
    K: () => scrollBy(-1),
    '\x04': () => scrollBy(page),
    '\x15': () => scrollBy(-page),
    '\x1b[6~': () => scrollBy(page),
    '\x1b[5~': () => scrollBy(-page),
  }
  actions[key]?.()
}

function onMouse({ button, x, y, up }) {
  if (up) return
  if (button === 64) return scrollBy(-3)
  if (button === 65) return scrollBy(3)
  if ((button & 3) !== 0 || button & 96) return
  const i = y - TOP - 1
  if (x < NAV && i >= 0 && i < SECTIONS.length) pick(i)
  else if (y === 3) typing = true
}

if (!process.stdin.isTTY) {
  console.error('help-view needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.paste !== undefined) {
      if (typing) query += t.paste.replace(/\s+/g, ' ')
    } else if (t.mouse) onMouse(t.mouse)
    else onKey(t.key)
  }
  draw()
})
process.stdout.on('resize', draw)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
enter()
draw()
