#!/usr/bin/env node
// The rail: a few columns down the left of a Ghostty window, as the S3.1
// design draws it. work and hub switch the window between the workspace and
// the agent hub; under them, counts of the agents that need you, are
// working, are done and are idle; view shows or hides the workspace's viewer
// pane, as Alt+V does (from the hub it shows the workspace with it open);
// + new opens the hub's New agent dialog,
// ? help the keys overlay (Alt+H), and ⚙ set the settings panel.
// The hub button carries an orange dot while anything needs you.
//   rail.mjs <work|hub>     which of the two windows this rail sits in
// HUB_WIN is the Ghostty window number. The outer tmux passes clicks on the
// rail through without moving focus to it (layout.conf), so it never takes
// keys meant for the workspace.

import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { follow } from './client.mjs'
import { counts } from './model.mjs'
import { NEW_AGENT_KEY } from './keys.mjs'
import { frame, pressed } from './railview.mjs'
import { load as settings } from './settings.mjs'
import { enter, leave, paint, tokens } from './term.mjs'

const VIEW = process.argv[2] === 'hub' ? 'hub' : 'work'
const WIN = Number(process.env.HUB_WIN) || 0
const session = `layout-${WIN}`
let c = { needs: 0, working: 0, done: 0, idle: 0 }

const tmux = (...args) => new Promise(r => execFile('tmux', args, () => r()))
const show = view => tmux('select-window', '-t', `${session}:${view}`)

// The hub's pane, to hand it the key that opens New agent (keys.mjs).
async function newAgent() {
  await show('hub')
  execFile('tmux', ['list-panes', '-t', `${session}:hub`, '-F', '#{pane_id} #{@hub}'], (err, out) => {
    const pane = (out ?? '').split('\n').find(l => l.endsWith(' 1'))?.split(' ')[0]
    if (pane) void tmux('send-keys', '-t', pane, '-l', NEW_AGENT_KEY)
  })
}

// The keys overlay and the settings panel, on this window's client: a click
// doesn't say which client made it, but each outer session has one, its
// Ghostty window.
const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin')
function popup(cmd, ...args) {
  execFile('tmux', ['list-clients', '-t', session, '-F', '#{client_name}'], (err, out) => {
    const client = (out ?? '').split('\n')[0]
    if (client) execFile(join(BIN, cmd), [client, ...args], () => {})
  })
}
const help = () => popup('ghostty-help', VIEW)

async function viewer() {
  if (VIEW === 'hub') await show('work')
  execFile(join(BIN, 'ghostty-viewer-toggle'), [String(WIN), VIEW === 'hub' ? 'show' : 'toggle'], () => {})
}
const openSettings = () => popup('ghostty-settings')

const cols = () => process.stdout.columns || 6
const rows = () => process.stdout.rows || 24
let buttons = []

function draw() {
  const f = frame(cols(), rows(), VIEW, c, { work: () => show('work'), hub: () => show('hub'), viewer, newAgent, help, settings: openSettings })
  buttons = f.buttons
  paint(f.lines)
}

if (!process.stdin.isTTY) {
  console.error('rail.mjs needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.mouse) void pressed(buttons, t.mouse)?.act()
  }
})
// tmux shares a resize out between the panes, the rail included, and the
// layout's window-resized hook only reaches the window being resized. So the
// rail puts its own width back: GHOSTTY_RAIL_COLS, else Settings'
// layout.railCols. It checks on every update too, so a change in Settings
// shows within a second. On 'resize' rather than SIGWINCH, since a SIGWINCH
// handler can run before the new size is read.
const want = () => Number(process.env.GHOSTTY_RAIL_COLS) || settings()['layout.railCols']
function fit() {
  if (cols() !== want() && process.env.TMUX_PANE) void tmux('resize-pane', '-t', process.env.TMUX_PANE, '-x', String(want()))
}
process.stdout.on('resize', () => {
  fit()
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
  fit()
  draw()
})
draw()
