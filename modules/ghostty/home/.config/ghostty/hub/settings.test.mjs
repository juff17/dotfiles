import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROWS, SECTIONS, load, reset, row, set, show, step, toggleFlag, valid } from './settings.mjs'

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
