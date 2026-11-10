import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROWS, SECTIONS, addedId, load, reset, row, set, show, step, toggleFlag, valid } from './settings.mjs'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json')

test('keys are unique and every default is a valid value', () => {
  assert.equal(new Set(ROWS.map(r => r.key)).size, ROWS.length)
  for (const r of ROWS) assert.ok(valid(r, r.default), r.key)
  for (const s of SECTIONS) assert.ok(s.rows.some(r => r.key), s.name)
})

test('no file reads as every default', () => {
  const values = load(fresh())
  for (const r of ROWS) assert.deepEqual(values[r.key], r.default)
})

test('a bad or unknown value reads as the default', () => {
  const file = fresh()
  writeFileSync(file, JSON.stringify({ 'newAgent.task.model': 'gpt', 'hub.doneCards': 99, 'tray.foldDone': 'yes', 'hub.broke': ['failed', 'boom'] }))
  const v = load(file)
  assert.equal(v['newAgent.task.model'], 'opus')
  assert.equal(v['hub.doneCards'], 2)
  assert.equal(v['tray.foldDone'], true)
  assert.deepEqual(v['hub.broke'], row('hub.broke').default)
})

test('a broken file reads as every default', () => {
  const file = fresh()
  writeFileSync(file, '{ not json')
  assert.equal(load(file)['prBabysit.interval'], 60)
})

test('set saves only changed values, and keeps keys it does not know', () => {
  const file = fresh()
  writeFileSync(file, JSON.stringify({ 'some.future.key': 1 }))
  set('prBabysit.interval', 120, file)
  assert.equal(load(file)['prBabysit.interval'], 120)
  set('newAgent.task.model', 'sonnet', file)
  reset('prBabysit.interval', file)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'some.future.key': 1, 'newAgent.task.model': 'sonnet' })
  assert.throws(() => set('prBabysit.interval', 5, file))
  assert.throws(() => set('no.such.key', 1, file))
})

test('the old "don\'t ask again" for stopping monitors carries over', () => {
  const file = fresh()
  writeFileSync(join(file, '..', 'prefs.json'), JSON.stringify({ skip: { 'stop-monitor': true } }))
  assert.equal(load(file)['hub.askStopMonitor'], false)
  set('hub.askStopMonitor', true, file)
  assert.equal(load(file)['hub.askStopMonitor'], true)
})

test('step cycles choices, keeps numbers in range and flips switches', () => {
  const model = row('newAgent.task.model')
  assert.equal(step(model, 'haiku', 1), 'default')
  assert.equal(step(model, 'default', -1), 'haiku')
  const cards = row('hub.doneCards')
  assert.equal(step(cards, 6, 1), 6)
  assert.equal(step(cards, 0, -1), 0)
  assert.equal(step(row('prBabysit.interval'), 60, 1), 75)
  assert.equal(step(row('tray.foldDone'), true, 1), false)
})

test('flags toggle in the order the choices list them', () => {
  const broke = row('hub.broke')
  assert.deepEqual(toggleFlag(broke, ['crash', 'failed'], 'stuck'), ['failed', 'stuck', 'crash'])
  assert.deepEqual(toggleFlag(broke, ['failed', 'stuck'], 'failed'), ['stuck'])
})

test('values show with their units and labels', () => {
  assert.equal(show(row('prBabysit.interval'), 60), '60s')
  assert.equal(show(row('newAgent.task.runAs'), 'bg'), 'background')
  assert.equal(show(row('tray.foldDone'), false), 'off')
})

test('the scripts read Settings through ghostty-lib.sh, the environment winning', () => {
  const file = fresh()
  set('layout.topRows', 14, file)
  const lib = fileURLToPath(new URL('../bin/ghostty-lib.sh', import.meta.url))
  const run = script =>
    execFileSync('bash', ['-c', `source "$1"; ${script}`, 'bash', lib], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_HUB_SETTINGS: file, GHOSTTY_TOP_ROWS: '', GHOSTTY_RAIL_COLS: '' },
    }).trim()
  assert.equal(run('top_rows'), '14')
  assert.equal(run('GHOSTTY_TOP_ROWS=7 top_rows'), '7')
  assert.equal(run("setting layout.todoWidth '' 70"), '70')
  assert.equal(run("setting no.such.key '' 33"), '33')
})

test('every section starts with a heading', () => {
  for (const s of SECTIONS) assert.ok(s.rows[0].head, s.name)
})

test('an alias row is its setting under another name, in another section', () => {
  const file = fresh()
  const babysit = SECTIONS.find(s => s.id === 'prBabysit').rows.find(r => r.label === 'Auto push changes')
  assert.equal(babysit.key, 'approvals.push')
  assert.deepEqual(babysit.choices, row('approvals.push').choices)
  set(babysit.key, 'auto', file)
  assert.equal(load(file)['approvals.push'], 'auto')
  assert.equal(ROWS.filter(r => r.key === 'approvals.push').length, 1)
})

test('fixed rows show a value but are not settings', () => {
  const fixed = SECTIONS.flatMap(s => s.rows).filter(r => r.fixed)
  assert.ok(fixed.some(r => r.label === 'Shortcut' && r.fixed === 'Meta+A'))
  for (const r of fixed) assert.equal(r.key, undefined)
})

test('Approvals’ popup key is the Keybinds row, so moving it in either place moves both', () => {
  const popup = SECTIONS.find(s => s.id === 'approvals').rows.find(r => r.label === 'Popup key')
  assert.equal(popup.key, 'keys.approvals')
  assert.equal(popup.type, 'key')
  assert.equal(popup.default, 'alt+a')
})

test('a list of viewer modes needs each mode once, added ones named with a command, and one on', () => {
  const r = row('workspace.modes')
  const four = r.default
  assert.ok(valid(r, [{ id: 'diff', on: true }, { id: 'x-lazygit', name: 'lazygit', cmd: 'lazygit', on: false }]))
  assert.ok(!valid(r, four.map(m => ({ ...m, on: false }))), 'none on')
  assert.ok(!valid(r, [...four, { id: 'diff', on: true }]), 'twice')
  assert.ok(!valid(r, [...four, { id: 'lazygit', name: 'lazygit', cmd: 'lazygit', on: true }]), 'added without x-')
  assert.ok(!valid(r, [...four, { id: 'x-a', name: 'a', cmd: '  ', on: true }]), 'no command')
  assert.ok(!valid(r, [...four, { id: 'x-a', name: 'a\tb', cmd: 'a', on: true }]), 'a tab in the name')
})

test('a saved list of modes missing a built-in one gets it back at the end, on', () => {
  const file = fresh()
  writeFileSync(file, JSON.stringify({ 'workspace.modes': [{ id: 'todo', on: true }, { id: 'files', on: false }] }))
  assert.deepEqual(
    load(file)['workspace.modes'].map(m => [m.id, m.on]),
    [['todo', true], ['files', false], ['diff', true], ['diagrams', true]],
  )
  assert.equal(show(row('workspace.modes'), load(file)['workspace.modes']), 'Todo, Diff, Diagrams')
})

test('an added mode’s id comes from its name and is never one the list has', () => {
  assert.equal(addedId('Lazy Git!', []), 'x-lazy-git')
  assert.equal(addedId('lazy git', [{ id: 'x-lazy-git' }]), 'x-lazy-git-2')
  assert.equal(addedId('日本', []), 'x-mode')
})
