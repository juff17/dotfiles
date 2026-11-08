import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  aliveIn,
  claim,
  clientsAlive,
  coreOf,
  findTranscript,
  paneOf,
  parentPid,
  parseHubShown,
  parsePanes,
  procStart,
  readLines,
  release,
  review,
  reviews,
  scanProcs,
  sessionRank,
  sessions,
  stoppedTasks,
  tabMarkArgs,
  transcriptReader,
  TRAY_FRESH_MS,
} from './daemon.mjs'
import { emptyTranscript } from './model.mjs'
import { MONITOR, STATE } from './term.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'agentd-test-'))
const age = (path, ms) => {
  const t = (Date.now() - ms) / 1000
  utimesSync(path, t, t)
}

// A /proc/<pid>/stat line: pid (comm) state ppid ... with start time as field 22.
const stat = ({ comm = 'claude', ppid = 1, start = 4242 } = {}) =>
  `123 (${comm}) S ${ppid} ${Array.from({ length: 17 }, (_, i) => i).join(' ')} ${start} 0 0`

// ------------------------------------------------------------ /proc

test('the start time and parent come from after the last paren, even when the name has spaces and parens', () => {
  const s = stat({ comm: 'node (my) tool', ppid: 77, start: 98765 })
  assert.equal(procStart(s), '98765')
  assert.equal(parentPid(s), 77)
})

// ------------------------------------------------------------ singleton

test('only one copy claims the pid file while it lives', () => {
  const file = join(tmp(), 'agentd.pid')
  assert.equal(claim(file, 100, () => false), true)
  assert.equal(readFileSync(file, 'utf8'), '100')
  assert.equal(claim(file, 200, pid => pid === 100), false)
  assert.equal(readFileSync(file, 'utf8'), '100')
})

test("a dead copy's pid file is taken over", () => {
  const file = join(tmp(), 'agentd.pid')
  writeFileSync(file, '100')
  assert.equal(claim(file, 200, () => false), true)
  assert.equal(readFileSync(file, 'utf8'), '200')
})

test('an empty pid file is left alone while new, as a copy is between creating and writing it, and taken once old', () => {
  const file = join(tmp(), 'agentd.pid')
  writeFileSync(file, '')
  assert.equal(claim(file, 200, () => false), false)
  age(file, 5000)
  assert.equal(claim(file, 200, () => false), true)
  assert.equal(readFileSync(file, 'utf8'), '200')
})

test('release removes the pid file only when it is still ours', () => {
  const file = join(tmp(), 'agentd.pid')
  writeFileSync(file, '300')
  release(file, 200)
  assert.ok(existsSync(file))
  release(file, 300)
  assert.ok(!existsSync(file))
  release(file, 300) // already gone: no throw
})

// ------------------------------------------------------------ sessions

test("sessions keeps live ones whose process is still the one that wrote the file", () => {
  const dir = tmp()
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ sessionId: 'a', pid: 10, procStart: 4242 }))
  writeFileSync(join(dir, 'reused.json'), JSON.stringify({ sessionId: 'b', pid: 11, procStart: 1 }))
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ sessionId: 'c', pid: 12 })) // no procStart: trusted
  writeFileSync(join(dir, 'dead.json'), JSON.stringify({ sessionId: 'd', pid: 13 }))
  writeFileSync(join(dir, 'nopid.json'), JSON.stringify({ sessionId: 'e' }))
  writeFileSync(join(dir, 'broken.json'), '{not json')
  writeFileSync(join(dir, 'notes.txt'), JSON.stringify({ sessionId: 'f', pid: 10 }))
  const procStat = pid => {
    if (pid === 13) throw new Error('ENOENT')
    return stat({ start: 4242 })
  }
  assert.deepEqual(sessions(dir, procStat).map(s => s.sessionId).sort(), ['a', 'c'])
})

test('sessions is empty when the directory is missing', () => {
  assert.deepEqual(sessions(join(tmp(), 'nope')), [])
})

// ------------------------------------------------------------ transcripts

const line = e => `${JSON.stringify(e)}\n`
const userLine = (text, sec = 1) => line({ type: 'user', timestamp: new Date(sec * 1000).toISOString(), message: { role: 'user', content: text } })
const replyLine = (text, sec = 2) =>
  line({ type: 'assistant', timestamp: new Date(sec * 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } })

test("findTranscript tries the cwd's own folder, then any project folder", () => {
  const projects = tmp()
  mkdirSync(join(projects, '-home-me-repo'))
  writeFileSync(join(projects, '-home-me-repo', 's1.jsonl'), '')
  mkdirSync(join(projects, 'elsewhere'))
  writeFileSync(join(projects, 'elsewhere', 's2.jsonl'), '')
  assert.equal(findTranscript(projects, { cwd: '/home/me/repo', sessionId: 's1' }), join(projects, '-home-me-repo', 's1.jsonl'))
  assert.equal(findTranscript(projects, { cwd: '/home/me/repo', sessionId: 's2' }), join(projects, 'elsewhere', 's2.jsonl'))
  assert.equal(findTranscript(projects, { cwd: '/x', sessionId: 'none' }), null)
  assert.equal(findTranscript(join(projects, 'missing'), { cwd: '/x', sessionId: 'none' }), null)
})

test('the reader picks up only what was appended, and a half-written line waits for its end', () => {
  const projects = tmp()
  mkdirSync(join(projects, '-r'))
  const file = join(projects, '-r', 's.jsonl')
  writeFileSync(file, userLine('first'))
  const s = { cwd: '/r', sessionId: 's' }
  const r = transcriptReader(projects)
  assert.equal(r.read(s).prompt.text, 'first')
  const half = replyLine('the answer')
  appendFileSync(file, half.slice(0, 20))
  assert.equal(r.read(s).reply, null)
  appendFileSync(file, half.slice(20))
  assert.equal(r.read(s).reply.text, 'the answer')
  assert.equal(r.read(s).prompt.text, 'first')
})

test('a multibyte character split across two reads still decodes', () => {
  const projects = tmp()
  mkdirSync(join(projects, '-r'))
  const file = join(projects, '-r', 's.jsonl')
  const text = 'héllo ✻ wörld — 日本語'
  writeFileSync(file, replyLine(text))
  // 7 bytes a read lands inside several of those characters.
  const r = transcriptReader(projects, 7)
  assert.equal(r.read({ cwd: '/r', sessionId: 's' }).reply.text, text)
})

test('a transcript that shrank (rewritten) is read again from the start', () => {
  const projects = tmp()
  mkdirSync(join(projects, '-r'))
  const file = join(projects, '-r', 's.jsonl')
  writeFileSync(file, userLine('a long first prompt that takes room') + replyLine('old reply'))
  const s = { cwd: '/r', sessionId: 's' }
  const r = transcriptReader(projects)
  assert.equal(r.read(s).reply.text, 'old reply')
  writeFileSync(file, userLine('new'))
  const t = r.read(s)
  assert.equal(t.prompt.text, 'new')
  assert.equal(t.reply, null)
})

test('a session with no transcript yet reads as empty and is found once the file appears', () => {
  const projects = tmp()
  const s = { cwd: '/r', sessionId: 's' }
  const r = transcriptReader(projects)
  assert.deepEqual(r.read(s), emptyTranscript())
  assert.deepEqual(r.cached(), [])
  mkdirSync(join(projects, '-r'))
  writeFileSync(join(projects, '-r', 's.jsonl'), userLine('hi'))
  assert.equal(r.read(s).prompt.text, 'hi')
})

test("subagents reads the session's unfinished subagents, each with its description", () => {
  const projects = tmp()
  const dir = join(projects, '-r', 's', 'subagents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(projects, '-r', 's.jsonl'), userLine('go'))
  const call = JSON.stringify({ type: 'assistant', timestamp: '2026-11-07T12:00:05Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })
  writeFileSync(join(dir, 'agent-a.jsonl'), `${userLine('test it')}${call}\n`)
  writeFileSync(join(dir, 'agent-a.meta.json'), JSON.stringify({ description: 'Test it' }))
  writeFileSync(join(dir, 'agent-b.jsonl'), userLine('done already'))
  writeFileSync(join(dir, 'agent-b.meta.json'), JSON.stringify({ description: 'Finished', finished: true }))
  const s = { cwd: '/r', sessionId: 's' }
  const r = transcriptReader(projects)
  assert.deepEqual(r.subagents(s), [], 'nothing before the session is read')
  r.read(s)
  const subs = r.subagents(s)
  assert.deepEqual(subs.map(x => x.description), ['Test it'])
  assert.equal(subs[0].t.tool.name, 'Bash')
  assert.equal(subs[0].t.tool.done, false)
})

test('keep forgets the sessions that are gone', () => {
  const projects = tmp()
  mkdirSync(join(projects, '-r'))
  writeFileSync(join(projects, '-r', 'a.jsonl'), userLine('a'))
  writeFileSync(join(projects, '-r', 'b.jsonl'), userLine('b'))
  const r = transcriptReader(projects)
  r.read({ cwd: '/r', sessionId: 'a' })
  r.read({ cwd: '/r', sessionId: 'b' })
  r.keep(new Set(['b']))
  assert.deepEqual(r.cached(), ['b'])
})

test('readLines skips request snapshots, lines of other types and broken JSON', () => {
  const t = emptyTranscript()
  readLines(
    t,
    [
      JSON.stringify({ type: 'api-request', message: { content: [{ type: 'text', text: '"type":"assistant"' }] } }),
      JSON.stringify({ type: 'system', message: { content: 'x' } }),
      '{"type":"user", broken',
      userLine('kept').trim(),
      JSON.stringify({ type: 'custom-title', customTitle: 'Named' }),
      JSON.stringify({ type: 'agent-name', agentName: 'bob' }),
    ].join('\n'),
  )
  assert.equal(t.prompt.text, 'kept')
  assert.equal(t.names.custom, 'Named')
  assert.equal(t.names.agent, 'bob')
})

// ------------------------------------------------------------ tmux

test("parseHubShown names the layout windows whose hub or diagrams window is in front", () => {
  const text = ['layout-1 hub 1', 'layout-1 work 0', 'layout-2 hub 0', 'layout-2 work 1', 'layout-3 diagrams 1', ''].join('\n')
  assert.deepEqual([...parseHubShown(text)].sort(), [1, 3])
  assert.equal(parseHubShown(null).size, 0)
})

test('sessionRank prefers the workspace, then the hub tab session, then anything else', () => {
  assert.equal(sessionRank('ghostty-3'), 2)
  assert.equal(sessionRank('hubtabs-3'), 1)
  assert.equal(sessionRank('peek-3'), 0)
  assert.equal(sessionRank('ghostty-x'), 0)
})

const paneLine = (pane, session, window, { index = 1, active = 1, attached = 1, mark = ' ', pid = 500 } = {}) =>
  [pane, session, window, index, active, attached, mark, pid].join('\t')

test('a pane belongs to its workspace session over the hub sessions it is linked into', () => {
  const text = [
    paneLine('%1', 'peek-2', '@5', { active: 0 }),
    paneLine('%1', 'hubtabs-2', '@5', { active: 0 }),
    paneLine('%1', 'ghostty-2', '@5', { index: 3, active: 0, pid: 900 }),
    paneLine('%2', 'hubtabs-2', '@6', { index: 4 }),
  ].join('\n')
  const map = parsePanes(text, new Set())
  assert.deepEqual(map.get('%1'), { pane: '%1', session: 'ghostty-2', win: 2, window: '@5', tab: 3, pid: 900, hub: false, looked: false })
  // Only the hub has %2: it's a hub tab.
  assert.equal(map.get('%2').hub, true)
  assert.equal(map.get('%2').win, 2)
})

test('a pane is looked at when its tab is in front of an attached session, from any session it shows in', () => {
  const map = parsePanes(
    [
      paneLine('%1', 'ghostty-1', '@1', { active: 1, attached: 1 }),
      paneLine('%2', 'ghostty-1', '@2', { active: 0, attached: 1 }),
      paneLine('%3', 'ghostty-1', '@3', { active: 1, attached: 0 }),
      // In front only in the peek, seen after the workspace line: still looked at.
      paneLine('%4', 'ghostty-1', '@4', { active: 0 }),
      paneLine('%4', 'peek-1', '@4', { active: 1 }),
    ].join('\n'),
    new Set(),
  )
  assert.equal(map.get('%1').looked, true)
  assert.equal(map.get('%2').looked, false)
  assert.equal(map.get('%3').looked, false)
  assert.equal(map.get('%4').looked, true)
  assert.equal(map.get('%4').session, 'ghostty-1')
})

test("a workspace tab isn't looked at while its window shows the hub, but the hub's own tab is", () => {
  const map = parsePanes([paneLine('%1', 'ghostty-1', '@1'), paneLine('%2', 'hubtabs-1', '@2')].join('\n'), new Set([1]))
  assert.equal(map.get('%1').looked, false)
  assert.equal(map.get('%2').looked, true)
})

test("parsePanes collects the marks tmux has now and ignores blank lines and failed calls", () => {
  const map = parsePanes([paneLine('%1', 'ghostty-1', '@1', { mark: '✻ #89b4fa' }), paneLine('%2', 'ghostty-1', '@2'), ''].join('\n'), new Set())
  assert.deepEqual([...map.marks], [['@1', '✻ #89b4fa']])
  assert.equal(map.size, 2)
  const none = parsePanes(null, new Set())
  assert.equal(none.size, 0)
  assert.equal(none.marks.size, 0)
})

const mark = look => `${look.glyph} ${look.color}`

test('tabMarkArgs sets the glyph of each agent on its window, the most urgent when several share it', () => {
  const agents = [
    { state: 'done', pane: { window: '@1' } },
    { state: 'needs', pane: { window: '@1' } },
    { state: 'working', pane: { window: '@1' } },
    { state: 'idle', pane: { window: '@2' } },
    { state: 'needs' }, // no pane: no tab to mark
  ]
  const [needs, idle] = [STATE.needs, STATE.idle]
  assert.deepEqual(tabMarkArgs(agents), [
    ...['set', '-w', '-t', '@1', '@agent', needs.glyph, ';', 'set', '-w', '-t', '@1', '@agent_fg', needs.color, ';'],
    ...['set', '-w', '-t', '@2', '@agent', idle.glyph, ';', 'set', '-w', '-t', '@2', '@agent_fg', idle.color],
  ])
})

test('an agent with a monitor shows the watching glyph, unless it needs you', () => {
  const args = tabMarkArgs([
    { state: 'working', monitor: true, pane: { window: '@1' } },
    { state: 'needs', monitor: true, pane: { window: '@2' } },
  ])
  assert.equal(args[5], MONITOR.watching.glyph)
  assert.equal(args[19], STATE.needs.glyph)
})

test('tabMarkArgs leaves marks that are already right, clears where the agent left, and is empty when nothing changed', () => {
  const agents = [{ state: 'working', pane: { window: '@1' } }]
  assert.deepEqual(tabMarkArgs(agents, new Map([['@1', mark(STATE.working)]])), [])
  assert.deepEqual(tabMarkArgs(agents, new Map([['@1', mark(STATE.working)], ['@9', mark(STATE.done)]])), [
    ...['set', '-wu', '-t', '@9', '@agent', ';', 'set', '-wu', '-t', '@9', '@agent_fg'],
  ])
  // A mark something else changed is put back.
  assert.equal(tabMarkArgs(agents, new Map([['@1', mark(STATE.done)]]))[5], STATE.working.glyph)
  assert.deepEqual(tabMarkArgs([], new Map()), [])
})

test("paneOf matches a session's tmux to this server's pane only when Claude runs under the pane's process", () => {
  const panes = new Map([['%3', { pane: '%3', session: 'ghostty-1', window: '@7', pid: 50 }]])
  const parents = { 300: 200, 200: 50, 999: 1 }
  const parent = pid => parents[pid]
  const s = (tmux, pid = 300) => ({ tmux, pid })
  assert.equal(paneOf(s('ghostty-1:@7.%3'), panes, parent), panes.get('%3'))
  // The hub's sessions hold the same windows, so they count too.
  assert.equal(paneOf(s('peek-4:@7.%3'), panes, parent), panes.get('%3'))
  assert.equal(paneOf(s('hubtabs-1:@7.%3'), panes, parent), panes.get('%3'))
  // Same pane id, another server's session or window.
  assert.equal(paneOf(s('other:@7.%3'), panes, parent), null)
  assert.equal(paneOf(s('ghostty-1:@8.%3'), panes, parent), null)
  // Not under the pane's shell.
  assert.equal(paneOf(s('ghostty-1:@7.%3', 999), panes, parent), null)
  // Not in tmux, or a malformed value.
  assert.equal(paneOf({ pid: 300 }, panes, parent), null)
  assert.equal(paneOf(s('ghostty-1:@7'), panes, parent), null)
  assert.equal(paneOf(s('ghostty-1:@7.%4'), panes, parent), null)
})

test('paneOf gives up when a parent is unreadable or the chain is too deep', () => {
  const panes = new Map([['%3', { session: 'ghostty-1', window: '@7', pid: 50 }]])
  const s = { tmux: 'ghostty-1:@7.%3', pid: 300 }
  assert.equal(
    paneOf(s, panes, () => {
      throw new Error('gone')
    }),
    null,
  )
  // A chain of 20 processes: past the 16 it walks.
  assert.equal(paneOf({ ...s, pid: 70 }, panes, pid => (pid > 51 ? pid - 1 : 50)), null)
  assert.equal(paneOf({ ...s, pid: 60 }, panes, pid => (pid > 51 ? pid - 1 : 50)), panes.get('%3'))
})

// ------------------------------------------------------------ monitors

test("coreOf drops the redirect or pipe a monitor's tool added", () => {
  assert.equal(coreOf('python3 watch_pr.py 12 2>&1'), 'python3 watch_pr.py 12')
  assert.equal(coreOf('tail -f log | grep --line-buffered ERR'), 'tail -f log')
  assert.equal(coreOf('  plain  '), 'plain')
  assert.equal(coreOf(undefined), 'undefined')
})

test("aliveIn finds a monitor's command in the process list, and can't tell without a scan or a command", () => {
  const procs = ['/usr/bin/python3 watch_pr.py 12', 'bash']
  assert.equal(aliveIn(procs, 'python3 watch_pr.py 12 2>&1'), true)
  assert.equal(aliveIn(procs, 'python3 watch_pr.py 13'), false)
  assert.equal(aliveIn(null, 'python3 watch_pr.py 12'), null)
  assert.equal(aliveIn(procs, '| grep x'), null)
})

test('scanProcs reads every numeric entry, with arguments joined by spaces', () => {
  const dir = tmp()
  for (const [pid, cmd] of [['1', 'init\0'], ['42', 'python3\0watch.py\0--pr\x0012\0']]) {
    mkdirSync(join(dir, pid))
    writeFileSync(join(dir, pid, 'cmdline'), cmd)
  }
  mkdirSync(join(dir, 'self'))
  writeFileSync(join(dir, 'self', 'cmdline'), 'skip')
  mkdirSync(join(dir, '7')) // a process that exited mid-scan
  assert.deepEqual(scanProcs(dir).sort(), ['init', 'python3 watch.py --pr 12'])
  assert.equal(scanProcs(join(dir, 'missing')), null)
})

// ------------------------------------------------------------ reviews

test('review touches a file per session and reviews reads back when', () => {
  const dir = tmp()
  review(dir, 's1')
  const map = reviews(dir)
  assert.deepEqual([...map.keys()], ['s1'])
  assert.ok(Math.abs(map.get('s1') - Date.now()) < 5000)
  assert.equal(reviews(join(dir, 'missing')).size, 0)
  review(join(dir, 'missing'), 's2') // no throw
})

test('stoppedTasks groups <session>.<task> files by session and ignores others', () => {
  const dir = tmp()
  for (const name of ['s1.t1', 's1.t2', 's2.t9', 'stray']) writeFileSync(join(dir, name), '')
  const map = stoppedTasks(dir)
  assert.deepEqual([...map.get('s1')].sort(), ['t1', 't2'])
  assert.deepEqual([...map.get('s2')], ['t9'])
  assert.equal(map.has('stray'), false)
  assert.equal(stoppedTasks(join(dir, 'missing')).size, 0)
})

// ------------------------------------------------------------ clients

test('a live client process keeps agentd running', () => {
  const dir = tmp()
  writeFileSync(join(dir, '100'), '')
  assert.equal(clientsAlive(dir, pid => pid === 100), true)
})

test("a dead client's file is removed and doesn't count", () => {
  const dir = tmp()
  writeFileSync(join(dir, '100'), '')
  assert.equal(clientsAlive(dir, () => false), false)
  assert.ok(!existsSync(join(dir, '100')))
})

test('the tray counts while its file is fresh', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'tray'), '')
  assert.equal(clientsAlive(dir, () => false), true)
  age(join(dir, 'tray'), TRAY_FRESH_MS + 1000)
  assert.equal(clientsAlive(dir, () => false), false)
  assert.ok(existsSync(join(dir, 'tray')), 'the tray file is kept, only ignored')
})

test('no clients directory means no clients', () => {
  assert.equal(clientsAlive(join(tmp(), 'missing'), () => true), false)
})
