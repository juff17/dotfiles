// The rail's frame and its buttons, apart from the terminal, so where each
// button sits and what a click reaches can be tested (rail.test.mjs).

import { BOLD, P, bg, fg, render } from './term.mjs'

const BG = bg(P.crust)

function button(icon, label, on, w, dot = false) {
  const fill = on ? bg(P.surface0) : BG
  const color = fg(on ? P.blue : P.sub)
  return [
    render([[` ${icon}`, color], ...(dot ? [[' ●', fg(P.peach)]] : [])], w, fill),
    render([[` ${label}`, color]], w, fill),
  ]
}

// The rail `w` columns by `h` rows, in `view` (work or hub), with the counts
// `c`: work, hub and view (the viewer pane) at the top, the counts under them,
// and + new, ? help and ⚙ set kept to the bottom. `acts` are what the buttons do, by name; each button
// is the rows it covers, counted from 1, and its act.
export function frame(w, h, view, c, acts) {
  const lines = [render([], w, BG)]
  const buttons = []
  const add = (act, ls) => {
    buttons.push({ y1: lines.length + 1, y2: lines.length + ls.length, act })
    lines.push(...ls, render([], w, BG))
  }
  add(acts.work, button('▣', 'work', view === 'work', w))
  add(acts.hub, button('◫', 'hub', view === 'hub', w, c.needs > 0))
  add(acts.viewer, button('◧', 'view', false, w))
  lines.push(render([[` ${'─'.repeat(Math.max(1, w - 2))}`, fg(P.surface1)]], w, BG))
  const count = (glyph, n, color, bold = false) => render([[` ${glyph} ${n}`, (bold ? BOLD : '') + fg(color)]], w, BG)
  lines.push(count('▲', c.needs, c.needs ? P.peach : P.overlay1, c.needs > 0))
  lines.push(count('✻', c.working, P.blue))
  lines.push(count('✓', c.done, P.green))
  lines.push(count('○', c.idle, P.sub))
  const tail = (icon, label) => [render([[` ${icon}`, fg(P.sub)]], w, BG), render([[` ${label}`, fg(P.sub)]], w, BG)]
  const bottom = [
    [acts.newAgent, tail('+', 'new')],
    [acts.help, tail('?', 'help')],
    [acts.settings, tail('⚙', 'set')],
  ]
  // A rail too short for them all drops ⚙ set, then ? help, then + new,
  // rather than drawing them past its bottom edge.
  const height = () => bottom.reduce((n, [, ls]) => n + ls.length + 1, 0)
  while (bottom.length && lines.length + height() > h) bottom.pop()
  while (lines.length < h - height()) lines.push(render([], w, BG))
  for (const [act, ls] of bottom) {
    buttons.push({ y1: lines.length + 1, y2: lines.length + ls.length, act })
    lines.push(...ls, render([], w, BG))
  }
  // Only buttons drawn whole can be clicked: on a very short rail the top
  // buttons can be cut off too.
  return { lines: lines.slice(0, h), buttons: buttons.filter(b => b.y2 <= h) }
}

// The button a mouse report presses: a left press on its rows. Releases,
// other buttons, the wheel and drags press nothing, and the column doesn't
// matter, the rail being one button wide.
export function pressed(buttons, mouse) {
  if (mouse.up || (mouse.button & 3) !== 0 || mouse.button & 96) return null
  return buttons.find(b => mouse.y >= b.y1 && mouse.y <= b.y2) ?? null
}
