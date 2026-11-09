#!/usr/bin/env node
// Alt+H's keys overlay, as the canvas's K2 draws it: the features down the
// left, the selected one's keys on the right, and / to filter every key at
// once. Keys that are easy to forget are peach. It runs in a tmux popup
// (bin/ghostty-help), where tmux's own bindings don't apply, so it reads
// Alt+H itself as close.
//   help-view.mjs [place]   the tmux window Alt+H was pressed in (work, hub,
//                           diagrams), which picks the section it opens on

import { splitAt } from '../hub/line.mjs'
import { BOLD, P, bg, enter, fg, leave, paint, render, split, tokens, width } from '../hub/term.mjs'
import { SECTIONS } from './help.mjs'
import { BOTTOM, NAV, TOP, filtering, fitScroll, footerHints, keyWidth, onKey, onMouse, onPaste, shown, start } from './help-nav.mjs'

const s = start(process.argv[2])

const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24
const bodyRows = () => Math.max(1, rows() - TOP - BOTTOM)
const BASE = bg(P.base)

// The right side's lines: each section's name and where it applies, then a
// row per key, the keys in one column as wide as the longest.
function content(groups, w) {
  const keyW = keyWidth(groups)
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
  if (!groups.length) lines.push([[`No key matches “${s.query.trim()}”`, '\x1b[3m' + fg(P.sub)]])
  return lines.map(spans => render(spans, w, BASE))
}

function navRow(i, counts) {
  const section = SECTIONS[i]
  const filtered = filtering(s)
  const n = filtered ? (counts.get(section.id) ?? 0) : section.keys.length
  const on = !filtered && i === s.sel
  const dim = filtered && !n
  const fill = on ? bg(P.surface0) : BASE
  const label = fg(dim ? P.surface1 : on ? P.text : P.sub) + (on ? BOLD : '')
  return split(
    [
      [' ● ', fg(dim ? P.surface1 : section.color)],
      [section.name, label],
    ],
    [[`${n} `, fg(P.overlay1)]],
    NAV - 1,
    fill,
  )
}

function draw() {
  const w = cols()
  const groups = shown(s)
  const counts = new Map(groups.map(g => [g.id, g.keys.length]))
  const right = w - NAV - 2
  const body = content(groups, right)
  fitScroll(s, body.length, bodyRows())

  const title = filtering(s) ? `matching “${s.query.trim()}”` : SECTIONS[s.sel].name
  const lines = [
    split([[` Keys · ${title}`, BOLD + fg(P.blue)]], [['alt+h', fg(P.text)], [' close ', fg(P.sub)]], w, BASE),
    render([], w, BASE),
    render(
      [
        [' / ', BOLD + fg(P.blue)],
        ...(s.query || s.typing
          ? s.typing
            ? [[splitAt(s.query, s.at)[0], fg(P.text)], ['▏', fg(P.blue)], [splitAt(s.query, s.at)[1], fg(P.text)]]
            : [[s.query, fg(P.text)]]
          : [['filter every key: try close, tab, todo', fg(P.overlay1)]]),
      ],
      w,
      BASE,
    ),
    render([], w, BASE),
  ]
  for (let y = 0; y < bodyRows(); y++) {
    const nav = y < SECTIONS.length ? navRow(y, counts) : render([], NAV - 1, BASE)
    const more = y === bodyRows() - 1 && s.scroll < s.maxScroll
    const line = more ? render([['▾ more', fg(P.overlay1)]], right, BASE) : (body[s.scroll + y] ?? render([], right, BASE))
    lines.push(`${nav}${render([['│', fg(P.surface0)]], 1, BASE)}${BASE}  ${line}`)
  }
  const total = groups.reduce((n, g) => n + g.keys.length, 0)
  const hints = footerHints(s)
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
      [[`${filtering(s) ? `${total} keys` : `${s.sel + 1} / ${SECTIONS.length}`} `, fg(P.sub)]],
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

if (!process.stdin.isTTY) {
  console.error('help-view needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.paste !== undefined) onPaste(s, t.paste)
    else if (t.mouse) onMouse(s, t.mouse)
    else if (onKey(s, t.key, Math.max(1, Math.floor(bodyRows() / 2)))) quit()
  }
  draw()
})
process.stdout.on('resize', draw)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
enter()
draw()
