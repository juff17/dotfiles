import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { tokens } from '../hub/term.mjs'
import { SECTIONS, get, row, set } from '../hub/settings.mjs'
import * as nav from './settings-nav.mjs'
import { AGENTS } from '../hub/prompts.mjs'
import { current, items, onKey, start } from './settings-nav.mjs'

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

// Each test gets its own empty settings file.
beforeEach(() => {
  process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'settings-nav-')), 'settings.json')
})

// A state on the setting `key`, as ↑↓ and tab would leave it.
function on(key) {
  const sec = SECTIONS.findIndex(s => s.rows.some(r => r.key === key))
  const s = start(SECTIONS[sec].id)
  s.sel = items(s).findIndex(r => r.key === key)
  return s
}
const press = (s, ...keys) => keys.map(k => onKey(s, k))

test('← lowers a number and → raises it, a step at a time', () => {
  const key = 'layout.diagramsPercent'
  const s = on(key)
  const { default: def, step } = row(key)
  press(s, LEFT)
  assert.equal(get(key), def - step)
  press(s, LEFT, LEFT)
  assert.equal(get(key), def - 3 * step)
  press(s, RIGHT)
  assert.equal(get(key), def - 2 * step)
  press(s, 'l')
  assert.equal(get(key), def - step)
  press(s, 'h')
  assert.equal(get(key), def - 2 * step)
})

test('a number stops at the ends of its range', () => {
  const key = 'layout.diagramsPercent'
  const s = on(key)
  set(key, row(key).min)
  press(s, LEFT)
  assert.equal(get(key), row(key).min)
  set(key, row(key).max)
  press(s, RIGHT)
  assert.equal(get(key), row(key).max)
})

test('← and → walk a choice back and on, round the list', () => {
  const key = 'newAgent.task.model'
  const s = on(key)
  const values = row(key).choices.map(c => c.value)
  const at = values.indexOf(row(key).default)
  press(s, RIGHT)
  assert.equal(get(key), values[(at + 1) % values.length])
  press(s, LEFT, LEFT)
  assert.equal(get(key), values[(at - 1 + values.length) % values.length])
})

test('on a row of flags ← and → pick a flag, and space turns it over', () => {
  const key = 'hub.broke'
  const s = on(key)
  const values = row(key).choices.map(c => c.value)
  press(s, RIGHT, RIGHT)
  assert.equal(s.flag, 2)
  press(s, LEFT, LEFT, LEFT)
  assert.equal(s.flag, values.length - 1)
  assert.deepEqual(get(key), row(key).default)
  press(s, ' ')
  assert.deepEqual(get(key), values.slice(0, -1))
})

test('space turns a switch over, and r puts it back', () => {
  const key = 'hub.askStopMonitor'
  const s = on(key)
  press(s, ' ')
  assert.equal(get(key), !row(key).default)
  press(s, 'r')
  assert.equal(get(key), row(key).default)
})

test('↑ and ↓ move between settings, stopping at the ends', () => {
  const s = start(SECTIONS[0].id)
  press(s, DOWN, DOWN)
  assert.equal(s.sel, 2)
  press(s, UP)
  assert.equal(s.sel, 1)
  press(s, UP, UP)
  assert.equal(s.sel, 0)
  press(s, 'G', DOWN)
  assert.equal(current(s), items(s).at(-1))
})

test('tab and shift+tab move between sections, round the list', () => {
  const s = start(SECTIONS[0].id)
  press(s, DOWN, '\t')
  assert.deepEqual([s.sec, s.sel], [1, 0])
  press(s, '\x1b[Z', '\x1b[Z')
  assert.equal(s.sec, SECTIONS.length - 1)
})

test('esc, q, ctrl+c and alt+s close it; other keys don’t', () => {
  for (const k of ['\x1b', 'q', '\x03', '\x1bs']) assert.equal(onKey(start(), k), 'quit', JSON.stringify(k))
  for (const k of [LEFT, RIGHT, UP, DOWN, ' ', 'x', 'e', 'v']) assert.equal(onKey(start(), k), undefined, JSON.stringify(k))
})

test('a failed save shows in the footer and leaves the value', () => {
  // Its folder is a file, so the folder can't be made.
  const file = join(mkdtempSync(join(tmpdir(), 'settings-nav-')), 'file')
  writeFileSync(file, '')
  process.env.AGENT_HUB_SETTINGS = join(file, 'settings.json')
  const s = on('layout.diagramsPercent')
  press(s, LEFT)
  assert.match(s.note.text, /^Couldn't save/)
  assert.equal(get('layout.diagramsPercent'), row('layout.diagramsPercent').default)
})

// Clicks used to step a value forward wherever they landed, ‹ included, so
// the panel takes keys only now.
test('takes no clicks: a click is a mouse report, never a key', () => {
  assert.equal(nav.onMouse, undefined)
  const click = [...tokens('\x1b[<0;60;8M\x1b[<0;60;8m')]
  assert.equal(click.length, 2)
  assert.ok(click.every(t => t.mouse && !t.key))
})

test('Task, the hand-off and filing say where their instructions are, and ↑↓ passes over it', () => {
  const where = SECTIONS.flatMap(x => x.rows.filter(r => r.prompt).map(r => r.prompt))
  assert.deepEqual(where.sort(), [...AGENTS].sort())
  for (const x of SECTIONS) assert.ok(!items(start(x.id)).some(r => r.prompt), x.id)
  assert.ok(!SECTIONS.some(x => x.rows.some(r => r.type === 'skill')), 'no skills to pick')
})

test('↵ on a keybind waits for a key, which is saved and applied', () => {
  let applied = 0
  nav.effects.applyKeys = () => applied++
  const s = on('keys.help')
  press(s, '\r')
  assert.equal(s.capture, true)
  press(s, '\x1bx')
  assert.deepEqual([s.capture, get('keys.help'), applied], [false, 'alt+x', 1])
  press(s, '\x7f')
  assert.equal(get('keys.help'), '')
  press(s, 'r')
  assert.equal(get('keys.help'), 'alt+h')
})

test('a keybind another row has is refused, and esc cancels the wait', () => {
  nav.effects.applyKeys = () => {}
  const s = on('keys.help')
  press(s, '\r', '\x1bt')
  assert.match(s.note.text, /taken by Todo popup/)
  assert.equal(get('keys.help'), 'alt+h')
  assert.equal(press(s, '\r', '\x1b')[1], undefined)
  assert.equal(s.capture, false)
  press(s, LEFT, RIGHT)
  assert.equal(get('keys.help'), 'alt+h')
})

test('the key Settings is moved to closes it', () => {
  nav.effects.applyKeys = () => {}
  set('keys.settings', 'alt+z')
  assert.equal(onKey(start(), '\x1bz'), 'quit')
})

// A state on the Workspace section's mode number `i`.
function onMode(i) {
  const s = start('workspace')
  s.sel = items(s).findIndex(r => r.type === 'mode' && r.index === i)
  return s
}
const modes = () => get('workspace.modes').map(m => `${m.id}${m.on ? '' : ' off'}`)

test('Workspace lists a row per viewer mode, then one to add a mode', () => {
  const s = start('workspace')
  const rows = items(s).filter(r => r.key === 'workspace.modes')
  assert.deepEqual(rows.map(r => r.label), ['Files', 'Diff', 'Todo', 'Diagrams', '+ Add a mode'])
})

test('space turns a mode off and on, but the last one on stays on', () => {
  const s = onMode(1)
  press(s, ' ')
  assert.deepEqual(modes(), ['files', 'diff off', 'todo', 'diagrams'])
  press(s, RIGHT)
  assert.deepEqual(modes(), ['files', 'diff', 'todo', 'diagrams'])
  set('workspace.modes', [{ id: 'files', on: true }, { id: 'diff', on: false }, { id: 'todo', on: false }, { id: 'diagrams', on: false }])
  press(onMode(0), ' ')
  assert.equal(get('workspace.modes')[0].on, true)
})

test('J and K move a mode down and up, and it stays selected', () => {
  const s = onMode(0)
  press(s, 'J', 'J')
  assert.deepEqual(modes(), ['diff', 'todo', 'files', 'diagrams'])
  assert.equal(current(s).mode.id, 'files')
  press(s, 'K')
  assert.deepEqual(modes(), ['diff', 'files', 'todo', 'diagrams'])
  press(onMode(3), 'J')
  assert.deepEqual(modes(), ['diff', 'files', 'todo', 'diagrams'], 'the last stays last')
})

test('a adds a mode from a name and a command; esc gives up', () => {
  const s = onMode(0)
  press(s, 'a', ...'lazygit', '\r', ...'lazygit', '\r')
  assert.deepEqual(get('workspace.modes').at(-1), { id: 'x-lazygit', name: 'lazygit', cmd: 'lazygit', on: true })
  assert.equal(current(s).mode.id, 'x-lazygit')
  assert.equal(s.input, null)
  press(s, 'a', ...'tig', '\x1b')
  assert.equal(s.input, null)
  assert.equal(get('workspace.modes').length, 5)
})

test('typing into a new mode takes q and esc as text, not as closing the panel', () => {
  const s = onMode(0)
  assert.deepEqual(press(s, 'a', 'q'), [undefined, undefined])
  assert.equal(s.input.text, 'q')
  press(s, '\x7f', '\r')
  assert.equal(s.input.field, 'name', 'a name is needed first')
  nav.typeText(s, 'two\nlines')
  assert.equal(s.input.text, 'two lines')
})

test('x removes a mode you added, never a built-in one', () => {
  set('workspace.modes', [...get('workspace.modes'), { id: 'x-tig', name: 'tig', cmd: 'tig', on: true }])
  press(onMode(1), 'x')
  assert.equal(get('workspace.modes').length, 5)
  press(onMode(4), 'x')
  assert.deepEqual(modes(), ['files', 'diff', 'todo', 'diagrams'])
})

test('r on a mode puts the built-in ones back in order and on, keeping added ones', () => {
  set('workspace.modes', [{ id: 'x-tig', name: 'tig', cmd: 'tig', on: true }, { id: 'todo', on: false }, { id: 'files', on: true }])
  press(onMode(0), 'r')
  assert.deepEqual(modes(), ['files', 'diff', 'todo', 'diagrams', 'x-tig'])
})

test('J and K still change section outside the list of modes', () => {
  const s = on('workspace.startMode')
  press(s, 'J')
  assert.equal(SECTIONS[s.sec].id, 'layout')
})

test('↵ on Sound file types a path; only a file that is there is saved, and backspace clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sound-'))
  const ding = join(dir, 'ding.oga')
  writeFileSync(ding, '')
  const s = on('tray.soundFile')
  press(s, '\r', ...join(dir, 'nope.oga'), '\r')
  assert.match(s.note.text, /No file at/)
  assert.notEqual(s.input, null, 'stays open to fix it')
  assert.equal(get('tray.soundFile'), '')
  press(s, '\x1b', '\r', ...'ding.oga', '\r')
  assert.match(s.note.text, /whole path/)
  press(s, '\x1b', '\r', ...ding, '\r')
  assert.equal(s.input, null)
  assert.equal(get('tray.soundFile'), ding)
  press(s, '\r')
  assert.equal(s.input.text, ding, 'starts from the path it has')
  press(s, '\x1b', RIGHT, '\x7f')
  assert.equal(get('tray.soundFile'), '')
})

test('a path that is not whole, or has a line break, is not a sound file', () => {
  const r = row('tray.soundFile')
  assert.ok(set('tray.soundFile', '~/a.oga'))
  assert.throws(() => set('tray.soundFile', 'a.oga'))
  assert.throws(() => set('tray.soundFile', '/a\nb.oga'))
  assert.equal(r.default, '')
})

test('a typed path completes as in a shell: tab fills in, steps through matches, → takes the suggestion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repos-'))
  for (const d of ['alpha', 'alphabet', 'beta']) mkdirSync(join(dir, d))
  writeFileSync(join(dir, 'bee.txt'), '')
  const s = on('todo.handoff.defaultRepo')
  press(s, '\r', ...`${dir}/b`, '\t')
  assert.equal(s.input.text, `${dir}/beta/`, 'a folder row offers only folders')
  press(s, '\x15', ...`${dir}/al`, '\t')
  assert.equal(s.input.text, `${dir}/alpha`, 'what several share')
  press(s, '\t', '\t')
  assert.equal(s.input.text, `${dir}/alphabet/`, 'then each in turn')
  press(s, '\x1b[Z')
  assert.equal(s.input.text, `${dir}/alpha/`)
  press(s, '\x17', ...'al')
  assert.equal(s.input.text, `${dir}/al`, 'ctrl+w takes a word back')
  assert.equal(nav.pathGhost(s.input), 'pha/')
  press(s, RIGHT, '\r')
  assert.equal(get('todo.handoff.defaultRepo'), `${dir}/alpha`, 'saved without the slash')
  const f = on('tray.soundFile')
  press(f, '\r', ...`${dir}/be`, '\t')
  assert.equal(f.input.menu.names.join(' '), 'bee.txt beta', 'a file row offers files too')
})
