#!/usr/bin/env node
// The viewer pane's modes, from Settings › Workspace (workspace.modes in
// hub/settings.mjs): which are on and in what order, which is the order of
// the header's tabs and of the Tab cycle.
//
// bin/ghostty-viewer runs one mode at a time and tells it the modes that are
// on through the environment: GV_MODES, their names joined by tabs, and
// GV_AT, which of them it is. A mode exits with FIRST_EXIT + i to switch the
// pane to mode i, or with GV_QUIT's code for q (0 closes the pane).
//   modes.mjs list          the modes that are on, a line each: id, name and,
//                           for one you added, its command, tab-separated
//   modes.mjs start         the id of the mode the pane opens in
//   modes.mjs popup <id>    exits 0 when that mode's popup key may open it

import { fileURLToPath } from 'node:url'

import { load, modeName } from '../hub/settings.mjs'

export const FIRST_EXIT = 10

export const onModes = (values = load()) =>
  values['workspace.modes'].filter(m => m.on).map(m => ({ id: m.id, name: modeName(m), cmd: m.cmd ?? '' }))

// workspace.startMode when that mode is on, else the first one on.
export function startMode(values = load()) {
  const on = onModes(values)
  const want = values['workspace.startMode']
  return (on.find(m => m.id === want) ?? on[0]).id
}

// Whether Alt+T (todo) or Alt+D (diagrams) opens its popup: always while the
// mode is on, and while it's off unless Settings says the key goes off too.
export const popupOpens = (id, values = load()) =>
  values['workspace.popupsWhenOff'] === 'works' || values['workspace.modes'].some(m => m.id === id && m.on)

// What a view needs to draw its header and switch: the names of the modes
// that are on, which is this one, and the exit codes for each tab, Tab and
// q. Run on its own, outside the viewer, it has just its own tab and
// switches nowhere (codes of 0).
export function paneModes(self, env = process.env) {
  const names = env.GV_MODES ? env.GV_MODES.split('\t') : []
  const at = Number(env.GV_AT)
  if (!names.length || !Number.isInteger(at) || at < 0 || at >= names.length)
    return { names: [self], at: 0, exitOf: () => 0, next: 0, quit: 0, alone: true }
  return {
    names,
    at,
    exitOf: i => (i === at || i < 0 || i >= names.length ? 0 : FIRST_EXIT + i),
    next: names.length > 1 ? FIRST_EXIT + ((at + 1) % names.length) : 0,
    quit: Number(env.GV_QUIT) || 0,
    alone: false,
  }
}

// The header's tabs as { label, i }, padded as the views draw them.
export const tabs = pane => pane.names.map((name, i) => ({ label: ` ${name} `, i }))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'list') for (const m of onModes()) console.log([m.id, m.name, m.cmd].join('\t'))
  else if (cmd === 'start') console.log(startMode())
  else if (cmd === 'popup') process.exit(popupOpens(arg) ? 0 : 1)
  else {
    console.error('modes.mjs list | start | popup <id>')
    process.exit(2)
  }
}
