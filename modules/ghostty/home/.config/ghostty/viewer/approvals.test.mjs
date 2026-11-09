import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { set } from '../hub/settings.mjs'
import { alwaysSetting, bodyOf, canAlways, current, edited, inline, onKey, reload, start } from './approvals.mjs'

process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'approvals-')), 'settings.json')

const reply = (extra = {}) => ({ id: 'r1', kind: 'reply', status: 'pending', body: 'Fixed in abc.', thread: { author: 'alice' }, ...extra })
const push = (extra = {}) => ({
  id: 'p1',
  kind: 'push',
  status: 'pending',
  commits: [{ sha: 'aaa1111' }, { sha: 'bbb2222' }],
  ...extra,
})
const retry = (extra = {}) => ({ id: 't1', kind: 'retry', status: 'pending', job: { id: 7, name: 'test' }, ...extra })
const EDITOR = { EDITOR: 'vim' }

test('it opens on the proposal asked for, else the first, and j/k wrap round', () => {
  const s = start([reply(), push(), retry()], 'p1')
  assert.equal(current(s).id, 'p1')
  assert.equal(start([reply()], 'gone').i, 0)
  onKey(s, 'j')
  assert.equal(current(s).id, 't1')
  onKey(s, 'j')
  assert.equal(current(s).id, 'r1')
  onKey(s, 'k')
  assert.equal(current(s).id, 't1')
})

test('a approves as proposed; esc, q and alt+a close', () => {
  const s = start([reply()])
  assert.deepEqual(onKey(s, 'a'), { do: 'approve', p: reply(), always: false })
  for (const k of ['q', '\x1b', '\x1ba']) assert.equal(onKey(s, k), 'quit')
})

test('A approves and asks for always, but never for a deployment or a failed one', () => {
  assert.equal(onKey(start([reply()]), 'A').always, true)
  const deploy = start([{ id: 'd', kind: 'deploy', status: 'pending' }])
  assert.equal(onKey(deploy, 'A'), undefined)
  assert.match(deploy.note.text, /always asks/)
  assert.equal(canAlways(retry({ status: 'failed' })), false)
  assert.deepEqual(alwaysSetting(reply()), ['approvals.reply', 'post'])
  assert.deepEqual(alwaysSetting(retry()), ['approvals.retry', 'auto'])
})

test('r rejects a pending proposal and dismisses a failed one; g goes to its session', () => {
  assert.equal(onKey(start([reply()]), 'r').do, 'reject')
  assert.equal(onKey(start([reply({ status: 'failed' })]), 'r').do, 'dismiss')
  assert.equal(onKey(start([reply({ status: 'failed' })]), 'x').do, 'dismiss')
  assert.equal(onKey(start([reply()]), 'x'), undefined, 'x never turns down a pending one by accident')
  assert.equal(onKey(start([reply()]), 'g').do, 'go')
})

test('a push: arrows pick a commit, enter opens its diff, space drops it, and a sends the drops', () => {
  const s = start([push()])
  onKey(s, '\x1b[B')
  assert.equal(s.commit, 1)
  onKey(s, '\x1b[B')
  assert.equal(s.commit, 1, 'held at the last')
  onKey(s, '\r')
  assert.ok(s.open.has('bbb2222'))
  onKey(s, '\r')
  assert.ok(!s.open.has('bbb2222'))
  onKey(s, ' ')
  assert.deepEqual(onKey(s, 'a'), { do: 'approve', p: push(), always: false, drop: ['bbb2222'] })
  onKey(s, '\x1b[A')
  onKey(s, ' ')
  assert.equal(s.drop.size, 1, 'the last commit kept can’t be dropped')
  assert.match(s.note.text, /Keep at least one/)
  assert.equal(onKey(s, 'd').do, 'diff')
})

test('moving to another proposal forgets drops, open diffs and edits', () => {
  const s = start([push(), reply()])
  onKey(s, ' ')
  onKey(s, '\r')
  onKey(s, 'j')
  onKey(s, 'k')
  assert.equal(s.drop.size, 0)
  assert.equal(s.open.size, 0)
})

test('e edits in $EDITOR, or inline when Settings say so or there is none', () => {
  assert.deepEqual(onKey(start([reply()]), 'e', EDITOR), { do: 'editor', p: reply(), text: 'Fixed in abc.' })
  const s = start([reply()])
  assert.equal(onKey(s, 'e', {}), undefined)
  assert.equal(s.editing, true)
  assert.equal(inline({}), true)
  set('approvals.editor', 'inline')
  assert.equal(inline(EDITOR), true)
  set('approvals.editor', 'editor')
  assert.equal(onKey(start([push()]), 'e', EDITOR), undefined, 'only a reply edits')
})

test('inline: keys edit the draft, esc drops it, enter posts it at once by default', () => {
  const s = start([reply()])
  onKey(s, 'e', {})
  for (const k of ' Thanks!') onKey(s, k, {})
  assert.equal(s.draft, 'Fixed in abc. Thanks!')
  onKey(s, '\x1b', {})
  assert.equal(s.editing, false)
  assert.equal(bodyOf(s, reply()), 'Fixed in abc.')
  onKey(s, 'e', {})
  onKey(s, '!', {})
  const e = onKey(s, '\r', {})
  assert.deepEqual(e, { do: 'approve', p: reply(), always: false, body: 'Fixed in abc.!' })
})

test('with "show it once more", an edit waits for a, which then posts the edit', () => {
  set('approvals.edited', 'confirm')
  try {
    const s = start([reply()])
    assert.equal(edited(s, reply(), 'New words'), undefined)
    assert.match(s.note.text, /Press a to post/)
    assert.equal(bodyOf(s, reply()), 'New words')
    assert.equal(onKey(s, 'a').body, 'New words')
  } finally {
    set('approvals.edited', 'post')
  }
})

test('an unchanged edit posts nothing', () => {
  const s = start([reply()])
  assert.equal(edited(s, reply(), 'Fixed in abc.'), undefined)
  assert.equal(s.edited, false)
  assert.equal(edited(s, reply(), null), undefined)
})

test('reload keeps the proposal shown, or the one after a settled one', () => {
  const s = start([reply(), push(), retry()], 'p1')
  reload(s, [reply(), { id: 'new', kind: 'retry' }, push(), retry()])
  assert.equal(current(s).id, 'p1')
  reload(s, [reply(), { id: 'new', kind: 'retry' }, retry()])
  assert.equal(current(s).id, 't1')
  reload(s, [])
  assert.equal(current(s), null)
  assert.equal(onKey(s, 'a'), undefined)
})
