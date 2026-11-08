import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
