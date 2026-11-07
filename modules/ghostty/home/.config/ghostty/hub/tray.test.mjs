// node --test modules/ghostty/home/.config/ghostty/hub/tray.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trayItems } from './tray.mjs'

const agent = (id, state, extra = {}) => ({
  id,
  state,
  need: null,
  cmd: '',
  title: `agent ${id}`,
  repo: 'dotfiles',
  worktree: '',
  pane: { tab: 2 },
  kind: 'tab',
  since: 1000,
  stateSince: 1000,
  monitor: false,
  monitors: [],
  ...extra,
})
const monitor = (key, state, tag, extra = {}) => ({
  key,
  state,
  description: 'PR !14 pipeline',
  kind: 'babysit',
  event: tag ? { tag, line: `[${tag}] job 4/9`, at: 2000 } : null,
  startedAt: 500,
  ended: null,
  ...extra,
})

test('needs-you agents become ▲ rows, with allow and deny only for a permission prompt', () => {
  const t = trayItems([
    agent('a', 'needs', { need: 'permission', cmd: 'Allow Bash(npm run build)?' }),
    agent('b', 'needs', { need: 'question', cmd: 'Hub replaces btop, or own view?', since: 2000 }),
  ])
  assert.deepEqual(
    t.items.map(i => [i.section, i.glyph, i.title, i.actions]),
    [
      ['you', '▲', 'Allow Bash(npm run build)?', ['allow', 'deny', 'go']],
      ['you', '?', 'Hub replaces btop, or own view?', ['go']],
    ],
  )
  assert.equal(t.items[0].meta, 'dotfiles · tab 2')
  assert.equal(t.counts.you, 2)
})

test('a monitor that saw a failure is ✗ broke; one asking for a manual step is ▲', () => {
  const fail = agent('a', 'needs', { need: 'monitor', cmd: '[failed] job 4/9', monitor: true, monitors: [monitor('a:t1', 'action', 'failed')] })
  const manual = agent('b', 'needs', { need: 'monitor', cmd: '[manual] deploy', monitor: true, monitors: [monitor('b:t1', 'action', 'manual')] })
  const t = trayItems([fail, manual])
  assert.deepEqual(
    t.items.map(i => [i.section, i.glyph]),
    [
      ['broke', '✗'],
      ['you', '▲'],
    ],
  )
  assert.equal(t.items[0].meta, 'dotfiles · PR !14 pipeline')
})

test('working agents count but are never new; watching monitors and done agents are', () => {
  const t = trayItems([
    agent('w', 'working', { cmd: 'Thinking…' }),
    agent('m', 'idle', { monitor: true, monitors: [monitor('m:t1', 'watching', 'comment'), monitor('m:t2', 'stale', null), monitor('m:t3', 'ended', null)] }),
    agent('d', 'done', { cmd: 'Merged.' }),
    agent('i', 'idle'),
  ])
  assert.deepEqual(t.counts, { you: 0, broke: 0, work: 1, watch: 2, done: 1 })
  assert.deepEqual(
    t.items.map(i => [i.section, i.glyph, i.new]),
    [
      ['work', '✻', false],
      // Gone quiet sorts first, as in the hub's monitors strip.
      ['watch', '◌', true],
      ['watch', '◉', true],
      ['done', '✓', true],
    ],
  )
  assert.equal(t.unseen, true)
  assert.equal(t.alert, false)
})

test('seen items drop the ring; a new prompt on the same agent rings again', () => {
  const first = agent('a', 'needs', { need: 'permission', cmd: 'Allow Bash(ls)?', since: 1000 })
  const t1 = trayItems([first])
  assert.equal(t1.alert, true)
  const seen = new Set(t1.items.map(i => i.id))
  assert.equal(trayItems([first], seen).unseen, false)
  const next = { ...first, cmd: 'Allow Bash(rm -rf build)?', since: 5000 }
  const t2 = trayItems([next], seen)
  assert.equal(t2.unseen, true)
  assert.equal(t2.alert, true)
})
