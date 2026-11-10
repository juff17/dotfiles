// node --test modules/ghostty/home/.config/ghostty/hub/tray.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { monitorLink, proposalLink, readApprovals, runApproval, trayItems, widgetSettings } from './tray.mjs'

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

test('each row says how long it has been so, and nothing when that isn’t known', () => {
  const t = trayItems(
    [agent('a', 'needs', { need: 'question', cmd: 'Which?', since: 1000 }), agent('b', 'needs', { need: 'question', cmd: 'Why?', since: 0 })],
    new Set(),
    new Set(),
    [],
    [],
    1000 + 2 * 60_000,
  )
  assert.deepEqual(Object.fromEntries(t.items.map(i => [i.title, i.age])), { 'Which?': '2m', 'Why?': '' })
})

test('a subagent\'s permission prompt names the subagent asking', () => {
  const t = trayItems([agent('a', 'needs', { need: 'permission', cmd: 'Allow Bash(ls)?', via: 'Test hub.mjs key handling' })])
  assert.deepEqual(t.items[0].actions, ['allow', 'deny', 'go'])
  assert.equal(t.items[0].meta, 'dotfiles · tab 2 · agent: Test hub.mjs key handling')
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

test('the widget gets its chip, sounds, flash and inbox from Settings', () => {
  assert.deepEqual(widgetSettings(), {
    count: ['you', 'broke', 'work', 'watch', 'done'],
    ring: true,
    desktop: false,
    soundYou: false,
    soundBroke: false,
    sound: 'message-new-instant',
    soundFile: '',
    quiet: true,
    flashMs: 2000,
    foldDone: true,
    messageMs: 6000,
    pollMs: 2000,
    inboxWidth: 600,
    inboxHeight: 1440,
  })
})

test('a custom sound gives the widget its file, from ~ out; with no file, the default sound', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tray-sound-')), 'settings.json')
  const was = process.env.AGENT_HUB_SETTINGS
  process.env.AGENT_HUB_SETTINGS = file
  try {
    writeFileSync(file, JSON.stringify({ 'tray.sound': 'custom', 'tray.soundFile': '~/ding.oga' }))
    const w = widgetSettings()
    assert.equal(w.soundFile, join(homedir(), 'ding.oga'))
    assert.equal(w.sound, 'message-new-instant')
    writeFileSync(file, JSON.stringify({ 'tray.sound': 'custom' }))
    assert.deepEqual([widgetSettings().sound, widgetSettings().soundFile], ['message-new-instant', ''])
  } finally {
    process.env.AGENT_HUB_SETTINGS = was
  }
})

const proposal = (kind, extra = {}) => ({
  id: `1-${kind}-ab`,
  kind,
  at: 5000,
  status: 'pending',
  claude_session: 's1',
  pane: '',
  pr: { repo: 'ci-playground', ref: '!128' },
  title: `${kind} title`,
  script: '/x/approval.py',
  ...extra,
})

test('proposals are rows with their own buttons, a reply showing its text', () => {
  const babysit = agent('s1', 'idle', { repo: 'ci-playground' })
  const ps = [
    proposal('reply', { title: 'Reply to @alice on auth.py:42', body: 'Good catch, see 3f9a1c2.' }),
    proposal('push', { title: 'Push 2 commits to feat', local: 'babysit/128', branch: 'feat', commits: [{ added: 6, removed: 2 }, { added: 12, removed: 4 }] }),
    proposal('manual', { title: 'Run deploy:staging', job: { name: 'deploy:staging', stage: 'deploy' } }),
    proposal('retry', { job: { name: 'test:integration', reason: 'runner lost connection' } }),
  ]
  const t = trayItems([babysit], new Set(), new Set(), [], ps)
  const rows = t.items.filter(i => i.approval)
  assert.deepEqual(
    rows.map(i => [i.section, i.glyph, i.title, i.meta, i.actions]),
    [
      ['you', '↩', 'Reply to @alice on auth.py:42', 'ci-playground !128 · babysit · reply', ['post', 'edit', 'skip']],
      ['you', '↑', 'Push 2 commits to feat', 'ci-playground !128 · babysit/128 → feat · +18 −6', ['push', 'review', 'go']],
      ['you', '▶', 'Run deploy:staging', 'ci-playground !128 · deploy stage', ['run', 'skip']],
      ['broke', '✗', 'test:integration failed, looks flaky', 'ci-playground !128 · runner lost connection', ['retry', 'go']],
    ],
  )
  assert.equal(rows[0].preview, 'Good catch, see 3f9a1c2.')
  assert.equal(rows[0].agent, 's1', 'Go finds the session that proposed it')
  assert.equal(t.counts.you, 3)
  assert.equal(t.counts.broke, 1)
})

test('a failed proposal is a ✗ row to try again, go to, or dismiss', () => {
  const r = trayItems([], new Set(), new Set(), [], [proposal('push', { status: 'failed', title: 'Push 2 commits to feat', result: { message: 'Someone pushed', at: 9 } })])
  assert.deepEqual(
    r.items.map(i => [i.section, i.id, i.title, i.meta, i.actions]),
    [['broke', 'af:1-push-ab', 'Push 2 commits to feat failed', 'ci-playground !128 · Someone pushed', ['again', 'go', 'dismiss']]],
  )
})

test('with tray buttons off, a proposal only opens Alt+A or its session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tray-buttons-'))
  const was = process.env.AGENT_HUB_SETTINGS
  process.env.AGENT_HUB_SETTINGS = join(dir, 'settings.json')
  writeFileSync(process.env.AGENT_HUB_SETTINGS, JSON.stringify({ 'approvals.trayButtons': false }))
  const t = trayItems([agent('s1', 'idle')], new Set(), new Set(), [], [proposal('reply', { body: 'x' })])
  process.env.AGENT_HUB_SETTINGS = was
  assert.deepEqual(t.items[0].actions, ['review', 'go'])
})

test('readApprovals lists pending and failed proposals, skipping settled and broken files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tray-approvals-'))
  writeFileSync(join(dir, '1.json'), JSON.stringify(proposal('reply')))
  writeFileSync(join(dir, '2.json'), JSON.stringify(proposal('push', { id: '2', status: 'failed' })))
  writeFileSync(join(dir, '3.json'), JSON.stringify(proposal('retry', { id: '3', status: 'done' })))
  writeFileSync(join(dir, '4.json'), '{ broken')
  writeFileSync(join(dir, 'log.jsonl'), '')
  assert.deepEqual(
    readApprovals(dir).map(p => p.status),
    ['pending', 'failed'],
  )
  assert.deepEqual(readApprovals(join(dir, 'missing')), [])
})

test('runApproval runs the proposal’s own approval.py under zsh and reads its JSON answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tray-run-'))
  const script = join(dir, 'approval.py')
  writeFileSync(script, '')
  const seen = []
  const exec = async args => (seen.push(args), { ok: true, out: '{"ok": true, "message": "Posted the reply to @alice"}\n', err: '' })
  assert.deepEqual(await runApproval({ script }, ['approve', 'p1'], exec), { ok: true, message: 'Posted the reply to @alice' })
  assert.deepEqual(seen[0].slice(-4), ['python3', script, 'approve', 'p1'])
  const failing = async () => ({ ok: false, out: '', err: 'Traceback\nSystemExit: boom' })
  assert.deepEqual(await runApproval({ script }, ['approve', 'p1'], failing), { ok: false, message: 'SystemExit: boom' })
  assert.equal((await runApproval({ script: '/bin/sh' }, ['approve', 'p1'], exec)).ok, false, 'only an approval.py')
  assert.equal((await runApproval({ script: join(dir, 'nope', 'approval.py') }, ['approve'], exec)).ok, false)
})

test('the tray only approves what it shows whole: a long reply or a push that drops commits opens in Alt+A', () => {
  const rows = trayItems([], new Set(), new Set(), [], [
    proposal('reply', { id: 'long', body: 'x'.repeat(201) }),
    proposal('reply', { id: 'lines', body: 'one\ntwo' }),
    proposal('reply', { id: 'short', body: 'x'.repeat(200) }),
    proposal('push', { id: 'force', local: 'b', branch: 'f', commits: [], removes: [{ sha: 'a' }] }),
  ]).items
  assert.deepEqual(
    rows.map(r => [r.approval, r.actions]),
    [
      ['long', ['review', 'skip']],
      ['lines', ['review', 'skip']],
      ['short', ['post', 'edit', 'skip']],
      ['force', ['review', 'go']],
    ],
  )
  assert.match(rows[3].meta, /replaces 1 on the remote/)
})

const GH = { url: 'https://github.com/o/r/pull/2', project: 'o/r', forge: 'github', repo: 'r', ref: '#2' }
const GL = { url: 'https://gitlab.example.com/g/r/-/merge_requests/7', project: 'g/r', forge: 'gitlab', repo: 'r', ref: '!7' }

test('↗ opens the comment, job, run or PR a proposal is about, on GitHub and GitLab', () => {
  const link = (kind, pr, extra = {}) => proposalLink(proposal(kind, { pr, ...extra }))
  assert.deepEqual(link('reply', GH, { thread: { url: 'https://github.com/o/r/pull/2#discussion_r9' } }), {
    url: 'https://github.com/o/r/pull/2#discussion_r9',
    label: 'Comment',
  })
  assert.deepEqual(link('retry', GH, { job: { id: '55', run_id: 44 } }), { url: 'https://github.com/o/r/actions/runs/44/job/55', label: 'Job' })
  assert.deepEqual(link('deploy', GH, { job: { id: '56', run_id: 44 } }), { url: 'https://github.com/o/r/actions/runs/44', label: 'Run' })
  assert.deepEqual(link('deploy', GH, { job: { id: 'run:44' } }), { url: 'https://github.com/o/r/actions/runs/44', label: 'Run' })
  assert.deepEqual(link('manual', GL, { job: { id: '812' } }), { url: 'https://gitlab.example.com/g/r/-/jobs/812', label: 'Job' })
  assert.deepEqual(link('push', GH), { url: GH.url, label: 'PR' })
  assert.deepEqual(link('push', GL), { url: GL.url, label: 'MR' })
  assert.equal(link('push', { ...GH, url: 'javascript:alert(1)' }), null, 'only http(s) goes to the browser')
})

test('↗ on a monitor opens what its latest event names, else the PR it watches', () => {
  const m = (line, command = 'python3 watch_pr.py https://github.com/o/r/pull/2 --session s') => monitorLink({ event: line && { line }, command })
  assert.deepEqual(m('[failed] flaky id=55 https://github.com/o/r/actions/runs/44/job/55'), { url: 'https://github.com/o/r/actions/runs/44/job/55', label: 'Job' })
  assert.deepEqual(m('[pipeline] passed'), { url: 'https://github.com/o/r/pull/2', label: 'PR' })
  assert.equal(m('[comment] @a on x.py:3 https://github.com/o/r/pull/2#discussion_r9').label, 'Comment')
  assert.equal(m('[comment] @a https://gitlab.com/g/r/-/merge_requests/7#note_5').label, 'Comment')
  assert.equal(m(null, 'tail -f app.log'), null)
})

test('a job a proposal covers shows once: the watcher’s own line about it is left out', () => {
  const line = '[failed] flaky id=55 https://github.com/o/r/actions/runs/44/job/55'
  const watcher = agent('s1', 'needs', { need: 'monitor', cmd: line, monitor: true, monitors: [{ ...monitor('s1:t1', 'action', 'failed'), event: { tag: 'failed', line, at: 2000 } }] })
  const retry = proposal('retry', { pr: GH, job: { id: '55', run_id: 44, name: 'flaky' } })
  assert.deepEqual(
    trayItems([watcher], new Set(), new Set(), [], [retry]).items.map(i => i.title),
    ['flaky failed, looks flaky'],
  )
  assert.equal(trayItems([watcher]).items[0].link.label, 'Job', 'without the proposal it stays, opening the job')
})

test('a reply citing a commit a push still waits on can be edited or skipped, not posted', () => {
  const push = proposal('push', { id: '1-push-ab', local: 'babysit/2', branch: 'b', commits: [{ sha: 'abc1234def', added: 1, removed: 1 }] })
  const reply = proposal('reply', { id: '2-reply-ab', body: 'Fixed in abc1234.', commit: { sha: 'abc1234def' } })
  const row = ps => trayItems([], new Set(), new Set(), [], ps).items.find(i => i.kind === 'reply')
  assert.deepEqual(row([push, reply]).actions, ['edit', 'skip'])
  assert.match(row([push, reply]).meta, /posts once abc1234 is pushed/)
  assert.deepEqual(row([reply]).actions, ['post', 'edit', 'skip'], 'once pushed it can be posted')
})
