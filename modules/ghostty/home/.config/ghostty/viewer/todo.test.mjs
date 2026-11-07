import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { KEEP_DONE_MS, add, age, arrange, category, change, find, load, newId, prune, remove, repoOf } from './todo.mjs'

const now = new Date(2026, 10, 7, 15, 0).getTime()
const item = (id, cat, root, created, done = null) => ({ id, cat, root, repo: root.split('/').pop(), title: id, created, done })

test('categories by name, alias or unique prefix', () => {
  assert.equal(category('bug'), 'bug')
  assert.equal(category('Feat'), 'feature')
  assert.equal(category('fix'), 'bug')
  assert.equal(category('fo'), 'follow-up')
  assert.equal(category('q'), 'question')
  assert.equal(category('misc'), 'other')
  assert.equal(category('o'), 'other')
  assert.equal(category('nope'), undefined)
  assert.equal(category(''), undefined)
})

test('a folder outside any repo is labelled none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'todo-norepo-'))
  assert.deepEqual(await repoOf(dir), { root: dir, repo: 'none', worktree: '', branch: '' })
})

test('ids are new and lengthen once short ones run out', () => {
  const items = [{ id: '000' }]
  let calls = 0
  // Every 3-character try comes out 000.
  const stuck = () => (calls++ < 60 ? 0 : 0.5)
  assert.equal(newId(items, stuck).length, 4)
  assert.match(newId([]), /^[0-9a-z]{3}$/)
})

test('find takes a unique start of an id', () => {
  const items = [{ id: 'abc' }, { id: 'abd' }, { id: 'xyz' }]
  assert.equal(find(items, 'x').id, 'xyz')
  assert.equal(find(items, 'ab'), undefined)
  assert.equal(find(items, 'abd').id, 'abd')
})

test('ages read in minutes, hours, then days', () => {
  assert.equal(age(59 * 60000), '59m')
  assert.equal(age(2 * 3600000), '2h')
  assert.equal(age(50 * 3600000), '2d')
  assert.equal(age(-5), '0m')
})

test('done items older than a week are dropped', () => {
  const items = [item('a', 'bug', '/r', 0, now - KEEP_DONE_MS - 1), item('b', 'bug', '/r', 0, now - 1000), item('c', 'bug', '/r', 0)]
  assert.deepEqual(prune(items, now).map(i => i.id), ['b', 'c'])
})

test('groups follow category order, this repo first, then newest', () => {
  const items = [
    item('q1', 'question', '/a', now - 10),
    item('b-old', 'bug', '/b', now - 300),
    item('b-new', 'bug', '/b', now - 100),
    item('b-here', 'bug', '/a', now - 900),
    item('f1', 'feature', '/b', now - 50),
    item('d-today', 'docs', '/a', now - 999, now - 60000),
    item('d-yday', 'docs', '/a', now - 999, now - 24 * 3600000),
  ]
  const { groups, doneToday, open } = arrange(items, { here: '/a', now })
  assert.deepEqual(groups.map(g => g.name), ['bug', 'feature', 'question'])
  assert.deepEqual(groups[0].items.map(i => i.id), ['b-here', 'b-new', 'b-old'])
  assert.deepEqual(doneToday.map(i => i.id), ['d-today'])
  assert.equal(open, 5)
  const mine = arrange(items, { here: '/a', only: true, now })
  assert.deepEqual(mine.groups.map(g => g.items.map(i => i.id)), [['b-here'], ['q1']])
})

test('the store adds, changes and removes under its lock', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'todo-')), 'todos.json')
  const first = add({ title: 'One', root: '/r' }, file)
  const second = add({ title: 'Two', cat: 'bug', root: '/r' }, file)
  assert.equal(first.cat, 'follow-up')
  assert.notEqual(first.id, second.id)
  assert.equal(change(second.id, { done: 5 }, file).done, 5)
  assert.equal(change('missing', { done: 5 }, file), undefined)
  assert.equal(remove(first.id, file).title, 'One')
  assert.deepEqual(load(file).map(i => i.title), [])
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).v, 1)
  assert.deepEqual(load(join(file, '..', 'none.json')), [])
})
