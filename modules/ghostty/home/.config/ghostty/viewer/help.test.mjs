import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SECTIONS, filter, startAt } from './help.mjs'

test('every section has keys, and ids are unique', () => {
  assert.equal(new Set(SECTIONS.map(s => s.id)).size, SECTIONS.length)
  for (const s of SECTIONS) assert.ok(s.keys.length, s.name)
})

test('opens on the section for the window Alt+H was pressed in', () => {
  assert.equal(SECTIONS[startAt('hub')].id, 'hub')
  assert.equal(SECTIONS[startAt('diagrams')].id, 'dv')
  assert.equal(SECTIONS[startAt('work')].id, 'any')
  assert.equal(SECTIONS[startAt(undefined)].id, 'any')
})

test('an empty filter keeps everything', () => {
  assert.equal(filter('  '), SECTIONS)
})

test('filter matches keys, what they do and section names, every word', () => {
  const ids = q => filter(q).map(s => s.id)
  assert.ok(ids('close').includes('tabs'))
  assert.ok(ids('close').includes('dv'))
  assert.deepEqual(
    filter('todo delete').flatMap(s => s.keys.map(k => k.key)),
    ['x x'],
  )
  assert.deepEqual(filter('alt+w').flatMap(s => s.keys.map(k => k.key)), ['alt+w'])
  assert.deepEqual(filter('nothing like this'), [])
})

test('filter is case-insensitive and leaves the table alone', () => {
  const before = SECTIONS[0].keys.length
  assert.ok(filter('TODO').length)
  assert.equal(SECTIONS[0].keys.length, before)
})

test('rebind shows a moved key in its place and drops an unbound one', async () => {
  const { rebind } = await import('./help.mjs')
  const rows = [
    { key: 'keys.diagrams', default: 'alt+d' },
    { key: 'keys.todo', default: 'alt+t' },
  ]
  const keys = () => SECTIONS.flatMap(s => s.keys.map(k => k.key))
  rebind({ 'keys.diagrams': 'alt+g', 'keys.todo': '' }, rows)
  assert.ok(keys().includes('esc  alt+g'))
  assert.ok(!keys().includes('alt+t') && !keys().includes('alt+d'))
})
