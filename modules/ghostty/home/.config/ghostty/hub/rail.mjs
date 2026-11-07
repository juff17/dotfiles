#!/usr/bin/env node
// The rail: a few columns down the left of a Ghostty window, as the S3.1
// design draws it. work and hub switch the window between the workspace and
// the agent hub; under them, counts of the agents that need you, are
// working, are done and are idle; + new opens the hub's New agent dialog.
// The hub button carries an orange dot while anything needs you.
//   rail.mjs <work|hub>     which of the two windows this rail sits in
// HUB_WIN is the Ghostty window number. The outer tmux passes clicks on the
// rail through without moving focus to it (layout.conf), so it never takes
// keys meant for the workspace.

import { execFile } from 'node:child_process'
import { follow } from './client.mjs'
import { counts } from './model.mjs'
import { BOLD, P, bg, enter, fg, leave, paint, render, tokens } from './term.mjs'

const VIEW = process.argv[2] === 'hub' ? 'hub' : 'work'
const WIN = Number(process.env.HUB_WIN) || 0
const session = `layout-${WIN}`
let c = { needs: 0, working: 0, done: 0, idle: 0 }

const tmux = (...args) => new Promise(r => execFile('tmux', args, () => r()))
const show = view => tmux('select-window', '-t', `${session}:${view}`)

// The hub's pane, to hand it the key that opens New agent (hub.mjs).
const NEW_AGENT_KEY = '\x1b[9100~'
async function newAgent() {
  await show('hub')
  execFile('tmux', ['list-panes', '-t', `${session}:hub`, '-F', '#{pane_id} #{@hub}'], (err, out) => {
    const pane = (out ?? '').split('\n').find(l => l.endsWith(' 1'))?.split(' ')[0]
    if (pane) void tmux('send-keys', '-t', pane, '-l', NEW_AGENT_KEY)
  })
}

const BG = bg(P.crust)
const cols = () => process.stdout.columns || 6
const rows = () => process.stdout.rows || 24
let buttons = []

function button(icon, label, on, dot = false) {
  const w = cols()
  const fill = on ? bg(P.surface0) : BG
  const color = fg(on ? P.blue : P.sub)
  return [
    render([[` ${icon}`, color], ...(dot ? [[' ●', fg(P.peach)]] : [])], w, fill),
    render([[` ${label}`, color]], w, fill),
  ]
}

function draw() {
  const w = cols()
  const lines = [render([], w, BG)]
  buttons = []
  const add = (act, ls) => {
    buttons.push({ y1: lines.length + 1, y2: lines.length + ls.length, act })
    lines.push(...ls, render([], w, BG))
  }
  add(() => show('work'), button('▣', 'work', VIEW === 'work'))
  add(() => show('hub'), button('◫', 'hub', VIEW === 'hub', c.needs > 0))
  lines.push(render([[` ${'─'.repeat(Math.max(1, w - 2))}`, fg(P.surface1)]], w, BG))
  const count = (glyph, n, color, bold = false) => render([[` ${glyph} ${n}`, (bold ? BOLD : '') + fg(color)]], w, BG)
  lines.push(count('▲', c.needs, c.needs ? P.peach : P.overlay1, c.needs > 0))
  lines.push(count('✻', c.working, P.blue))
  lines.push(count('✓', c.done, P.green))
  lines.push(count('○', c.idle, P.sub))
  const bottom = [render([[' +', fg(P.sub)]], w, BG), render([[' new', fg(P.sub)]], w, BG)]
  while (lines.length < rows() - bottom.length - 1) lines.push(render([], w, BG))
  buttons.push({ y1: lines.length + 1, y2: lines.length + 2, act: newAgent })
  lines.push(...bottom, render([], w, BG))
  paint(lines.slice(0, rows()))
}

if (!process.stdin.isTTY) {
  console.error('rail.mjs needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (!t.mouse || t.mouse.up || (t.mouse.button & 3) !== 0 || t.mouse.button & 96) continue
    const b = buttons.find(b => t.mouse.y >= b.y1 && t.mouse.y <= b.y2)
    void b?.act()
  }
})
// tmux shares a resize out between the panes, the rail included, and the
// layout's window-resized hook only reaches the window being resized. So the
// rail puts its own width back. On 'resize' rather than SIGWINCH, since a
// SIGWINCH handler can run before the new size is read.
const WANT = Number(process.env.GHOSTTY_RAIL_COLS) || 6
process.stdout.on('resize', () => {
  if (cols() !== WANT && process.env.TMUX_PANE) void tmux('resize-pane', '-t', process.env.TMUX_PANE, '-x', String(WANT))
  draw()
})
const bye = () => {
  leave()
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGHUP', bye)
enter()
follow(s => {
  c = counts(s.agents ?? [])
  draw()
})
draw()
