// node --test modules/ghostty/home/.config/ghostty/hub/tray.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { trayItems, widgetSettings } from './tray.mjs'

// No settings file, so every setting reads as its default.
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

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

test('Settings decides which events count as broke', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tray-')), 'settings.json')
  writeFileSync(file, JSON.stringify({ 'hub.broke': ['stuck', 'conflict'] }))
  const before = process.env.AGENT_HUB_SETTINGS
  process.env.AGENT_HUB_SETTINGS = file
  try {
    const fail = agent('a', 'needs', { need: 'monitor', cmd: '[failed] job', monitor: true, monitors: [monitor('a:t1', 'action', 'failed')] })
    const gl = agent('b', 'needs', { need: 'monitor', cmd: '[conflicts] main', monitor: true, monitors: [monitor('b:t1', 'action', 'conflicts')] })
    assert.deepEqual(trayItems([fail, gl]).items.map(i => i.section), ['you', 'broke'])
  } finally {
    process.env.AGENT_HUB_SETTINGS = before
  }
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

test('dismissed items leave the list until they change', () => {
  const done = agent('d', 'done', { cmd: 'Merged.', since: 7000 })
  const id = trayItems([done]).items[0].id
  assert.equal(trayItems([done], new Set(), new Set([id])).items.length, 0)
  assert.equal(trayItems([{ ...done, since: 9000 }], new Set(), new Set([id])).items.length, 1)
})

test('a note from a session is a ▲ row that goes to that session', () => {
  const babysit = agent('s1', 'idle', { pane: { pane: '%7', tab: 4 }, repo: 'jstack' })
  const notes = [
    { file: '1', title: 'jstack !123', message: 'Fix ready · 1 file, push it', session: 's1', pane: '', at: 3000 },
    { file: '2', title: 'gad !9', message: 'Rebase finished', session: 'gone', pane: '', at: 4000 },
  ]
  const t = trayItems([babysit], new Set(), new Set(), notes)
  assert.deepEqual(
    t.items.map(i => [i.section, i.id, i.title, i.meta, i.actions]),
    [
      ['you', 'n:1', 'Fix ready · 1 file, push it', 'jstack !123 · jstack · tab 4', ['go', 'dismiss']],
      ['you', 'n:2', 'Rebase finished', 'gad !9', ['dismiss']],
    ],
  )
  assert.equal(t.alert, true)
})

test('the widget gets its flash length and done folding from Settings', () => {
  assert.deepEqual(widgetSettings(), { flashMs: 2000, foldDone: true })
})
