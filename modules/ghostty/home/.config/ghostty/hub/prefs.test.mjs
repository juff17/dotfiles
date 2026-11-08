// node --test modules/ghostty/home/.config/ghostty/hub/prefs.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { dontAsk, readPrefs, recents, remember, skips, storePaths } from './prefs.mjs'
import { set } from './settings.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'hub-prefs-'))
process.env.AGENT_HUB_SETTINGS = join(TMP, 'settings.json')
after(() => rmSync(TMP, { recursive: true, force: true }))
let n = 0
const fresh = name => join(TMP, String(++n), 'agent-hub', name)
const HOME = '/home/u'
const at = cwd => ({ cwd })

test('recents and prefs live under XDG cache and state, or their defaults under home', () => {
  assert.deepEqual(storePaths({}, HOME), {
    recents: '/home/u/.cache/agent-hub/recents.json',
    prefs: '/home/u/.local/state/agent-hub/prefs.json',
  })
  assert.deepEqual(storePaths({ XDG_CACHE_HOME: '/c', XDG_STATE_HOME: '/s' }, HOME), {
    recents: '/c/agent-hub/recents.json',
    prefs: '/s/agent-hub/prefs.json',
  })
})

test('recents: saved first, then running agents\' folders, a worktree as its repo', () => {
  const file = fresh('recents.json')
  assert.deepEqual(recents(file, [], HOME), [])
  remember(file, '/home/u/p/a', [], HOME)
  const list = recents(file, [at('/home/u/p/b'), at('/home/u/p/a/.claude/worktrees/fix-x'), at('/home/u/p/c/sub')], HOME)
  assert.deepEqual(list, ['/home/u/p/a', '/home/u/p/b', '/home/u/p/c/sub'])
})

test('recents never offer home, and stop at 8', () => {
  const file = fresh('recents.json')
  const many = Array.from({ length: 12 }, (_, i) => at(`/p/${i}`))
  assert.deepEqual(recents(file, [at(HOME), ...many], HOME), many.slice(0, 8).map(a => a.cwd))
})

test('recents stop at Settings’ Recent folders shown', () => {
  set('newAgent.recent', 3)
  const many = Array.from({ length: 5 }, (_, i) => at(`/p/${i}`))
  assert.deepEqual(recents(fresh('recents.json'), many, HOME), ['/p/0', '/p/1', '/p/2'])
  set('newAgent.recent', 8)
})

test('remember puts the folder first without repeating it', () => {
  const file = fresh('recents.json')
  for (const d of ['/p/a', '/p/b', '/p/c']) remember(file, d, [], HOME)
  remember(file, '/p/a', [], HOME)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/p/a', '/p/c', '/p/b'])
})

test('remember also saves the running agents\' folders it offered', () => {
  const file = fresh('recents.json')
  remember(file, '/p/new', [at('/p/running')], HOME)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/p/new', '/p/running'])
})

test('a broken recents file reads as none and is replaced', () => {
  const file = fresh('recents.json')
  remember(file, '/p/a', [], HOME)
  writeFileSync(file, '{not json')
  assert.deepEqual(recents(file, [], HOME), [])
  remember(file, '/p/b', [], HOME)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/p/b'])
})

test('no prefs file means every question is asked', () => {
  const file = fresh('prefs.json')
  assert.deepEqual(readPrefs(file), {})
  assert.equal(skips(readPrefs(file), 'stop-monitor'), false)
})

test('a for "don\'t ask again" persists the stop-monitor choice', () => {
  const file = fresh('prefs.json')
  dontAsk(file, 'stop-monitor')
  assert.equal(skips(readPrefs(file), 'stop-monitor'), true)
  assert.equal(skips(readPrefs(file), 'close-agent'), false)
  assert.equal(readFileSync(file, 'utf8'), '{\n  "skip": {\n    "stop-monitor": true\n  }\n}\n')
})

test('dontAsk keeps the other prefs and earlier skips', () => {
  const file = fresh('prefs.json')
  dontAsk(file, 'stop-monitor')
  const p = readPrefs(file)
  p.theme = 'mocha'
  writeFileSync(file, JSON.stringify(p))
  dontAsk(file, 'other')
  assert.deepEqual(readPrefs(file), { theme: 'mocha', skip: { 'stop-monitor': true, other: true } })
})

test('a broken prefs file asks again, and a skip rewrites it', () => {
  const file = fresh('prefs.json')
  dontAsk(file, 'x')
  writeFileSync(file, 'garbage')
  assert.deepEqual(readPrefs(file), {})
  dontAsk(file, 'stop-monitor')
  assert.deepEqual(readPrefs(file), { skip: { 'stop-monitor': true } })
})

test('prefs that are not an object read as none, and a skip replaces them', () => {
  for (const body of ['null', '[]', '[1]', '42', '"x"', 'true', '{"skip": null}', '{"skip": "stop-monitor"}', '{"skip": ["stop-monitor"]}']) {
    const file = fresh('prefs.json')
    dontAsk(file, 'x')
    writeFileSync(file, body)
    assert.equal(skips(readPrefs(file), 'stop-monitor'), false, body)
    dontAsk(file, 'stop-monitor')
    assert.equal(skips(readPrefs(file), 'stop-monitor'), true, body)
    assert.deepEqual(readPrefs(file).skip, { 'stop-monitor': true }, body)
  }
})

test('dontAsk throws when it cannot write, so the hub can say so', () => {
  // A file where its folder should be.
  const blocker = join(TMP, 'blocker')
  writeFileSync(blocker, '')
  const file = join(blocker, 'agent-hub', 'prefs.json')
  assert.throws(() => dontAsk(file, 'stop-monitor'), { code: 'ENOTDIR' })
  assert.deepEqual(readPrefs(file), {})
})
