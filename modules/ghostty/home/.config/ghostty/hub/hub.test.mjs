// node --test modules/ghostty/home/.config/ghostty/hub/hub.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addEntry, cardHeights, classify, counts, describeTool, emptyTranscript, lanes, launch, monitorProcess, monitorsOf, pairParked, parseNotification, repoOf, scrollTo } from './model.mjs'
import { clean, render, width } from './term.mjs'

// No settings file, so every setting reads as its default.
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'
process.env.AGENT_HUB_PROMPTS = '/nonexistent/agent-hub/prompts'

const ts = s => new Date(Date.UTC(2026, 10, 7, 12, 0, s)).toISOString()
const at = s => Date.parse(ts(s))
const user = (s, content, extra = {}) => ({ type: 'user', timestamp: ts(s), message: { role: 'user', content }, ...extra })
const assistant = (s, content, extra = {}) => ({
  type: 'assistant',
  timestamp: ts(s),
  message: { role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, cache_read_input_tokens: 84000, cache_creation_input_tokens: 0 }, ...extra },
})
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input })
const result = (id, content = 'ok') => ({ type: 'tool_result', tool_use_id: id, content })
const feed = entries => entries.reduce((t, e) => (addEntry(t, e), t), emptyTranscript())
const session = (status, extra = {}) => ({ sessionId: 's1', pid: 1, cwd: '/home/u/projects/jstack', kind: 'interactive', status, statusUpdatedAt: at(0), startedAt: at(0), ...extra })

const notification = (task, line) =>
  `<task-notification>\n<task-id>${task}</task-id>\n<summary>Monitor event: "PR #1 pipeline"</summary>\n<event>${line}</event>\n</task-notification>`

const babysit = [
  user(1, 'babysit https://github.com/u/r/pull/1'),
  assistant(2, [tool('m1', 'Monitor', { command: 'python3 -u /s/watch_pr.py https://github.com/u/r/pull/1 --session 1 2>&1', description: 'PR #1 pipeline' })]),
  user(3, [result('m1', 'Monitor started (task b5sky, expires in 30m unless the source ends first)')]),
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(4), content: notification('b5sky', '[watch] attached https://github.com/u/r/pull/1 -&gt; main') },
  user(5, notification('b5sky', '[watch] attached https://github.com/u/r/pull/1 -&gt; main')),
  assistant(6, [{ type: 'text', text: 'Watching PR #1.' }], { stop_reason: 'end_turn' }),
]

test('the transcript gives the prompt, the running tool and the context', () => {
  const t = feed([
    user(1, 'let rm in worktrees skip the prompt'),
    assistant(2, [{ type: 'text', text: 'I will read the guard.' }]),
    assistant(3, [tool('t1', 'Bash', { command: 'bats test/rm-guard.bats\nexit' })]),
  ])
  assert.equal(t.prompt.text, 'let rm in worktrees skip the prompt')
  assert.equal(t.tool.name, 'Bash')
  assert.equal(t.tool.done, false)
  assert.equal(t.ctx, 84010)
  assert.equal(describeTool(t.tool), 'Bash(bats test/rm-guard.bats)')
  addEntry(t, user(4, [result('t1')]))
  assert.equal(t.tool.done, true)
})

test('slash commands count as prompts, tool results that carry text do not', () => {
  const t = feed([user(1, '<command-name>/fork</command-name>\n<command-args>now</command-args>')])
  assert.equal(t.prompt.text, '/fork now')
  addEntry(t, user(2, [result('x', 'Launching skill'), { type: 'text', text: 'Base directory for this skill' }]))
  assert.equal(t.prompt.text, '/fork now')
  addEntry(t, user(3, '<system-reminder>hi</system-reminder>'))
  assert.equal(t.prompt.text, '/fork now')
})

test('file tools show their path relative to the session folder', () => {
  assert.equal(describeTool({ name: 'Edit', input: { file_path: '/home/u/projects/jstack/hooks/a.sh' } }, '/home/u/projects/jstack'), 'Edit(hooks/a.sh)')
  assert.equal(describeTool({ name: 'mcp__diagram-pane__show', input: {} }), 'show (MCP)')
  assert.equal(describeTool({ name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?' }] } }), '? Which one?')
})

test('a Monitor is armed by its result and collects events once each', () => {
  const t = feed(babysit)
  const m = t.monitors.b5sky
  assert.equal(m.description, 'PR #1 pipeline')
  assert.equal(m.events.length, 1, 'the queued copy and the delivered copy are one event')
  assert.equal(m.events[0].tag, 'watch')
  assert.equal(m.events[0].line, '[watch] attached https://github.com/u/r/pull/1 -> main')
  addEntry(t, user(7, notification('b5sky', '[Monitor expired after 30m with 3 events delivered.]')))
  assert.equal(m.ended.reason, 'expired')
})

test('the same event happening again counts again', () => {
  const t = feed([...babysit, user(8, notification('b5sky', '[error] TimeoutError')), user(9, notification('b5sky', '[error] TimeoutError'))])
  assert.equal(t.monitors.b5sky.events.length, 3)
})

test('parseNotification reads the task, summary and event lines', () => {
  const n = parseNotification(notification('abc', '[failed] lint\n[comment] @a: &quot;why&quot;'))
  assert.equal(n.id, 'abc')
  assert.deepEqual(n.ids, ['abc'])
  assert.deepEqual(n.lines, ['[failed] lint', '[comment] @a: "why"'])
})

test('a waiting session needs you: permission, question or input', () => {
  const pending = feed([user(1, 'go'), assistant(2, [tool('t1', 'Bash', { command: 'rm -rf .next' })])])
  let a = classify({ session: session('waiting'), t: pending })
  assert.equal(a.state, 'needs')
  assert.equal(a.need, 'permission')
  assert.equal(a.cmd, 'Allow Bash(rm -rf .next)?')
  const asking = feed([user(1, 'go'), assistant(2, [tool('q', 'AskUserQuestion', { questions: [{ question: 'Replace btop?' }] })])])
  a = classify({ session: session('waiting'), t: asking })
  assert.equal(a.need, 'question')
  a = classify({ session: session('waiting', { waitingFor: 'dialog open' }), t: feed([user(1, 'go')]) })
  assert.equal(a.need, 'input')
  assert.equal(a.cmd, 'Waiting: dialog open')
})

test('a background subagent asking for permission is a permission prompt, not input', () => {
  // The session's own turn ended; the subagent it left running asks.
  const ended = feed([user(1, 'go'), assistant(2, [{ type: 'text', text: 'One agent still running.' }], { stop_reason: 'end_turn' })])
  const sub = feed([user(1, 'test the hub keys'), assistant(3, [tool('s1', 'Bash', { command: 'rm -f /tmp/x; echo ok' })])])
  const a = classify({ session: session('waiting', { waitingFor: 'permission prompt' }), t: ended, subs: [{ description: 'Test hub.mjs key handling', t: sub }] })
  assert.equal(a.need, 'permission')
  assert.equal(a.cmd, 'Allow Bash(rm -f /tmp/x; echo ok)?')
  assert.equal(a.via, 'Test hub.mjs key handling')
})

test('inside an Agent call, the subagent\'s tool is the prompt, not the Agent call', () => {
  const running = feed([user(1, 'go'), assistant(2, [tool('ag', 'Agent', { description: 'Fix lint' })])])
  const sub = feed([user(2, 'fix lint'), assistant(4, [tool('s1', 'Edit', { file_path: '/home/u/projects/jstack/a.js' })])])
  let a = classify({ session: session('waiting'), t: running, subs: [{ description: 'Fix lint', t: sub }] })
  assert.equal(a.cmd, 'Allow Edit(a.js)?')
  // No subagent call pending: the Agent call is all there is to show.
  a = classify({ session: session('waiting'), t: running })
  assert.equal(a.cmd, 'Allow Agent(Fix lint)?')
  assert.equal(a.via, '')
})

test('the newest pending call wins between the session and its subagents', () => {
  const own = feed([user(1, 'go'), assistant(5, [tool('t1', 'Bash', { command: 'git push' })])])
  const older = feed([user(1, 'x'), assistant(3, [tool('s1', 'Bash', { command: 'ls' })])])
  const a = classify({ session: session('waiting'), t: own, subs: [{ description: 'old', t: older }] })
  assert.equal(a.cmd, 'Allow Bash(git push)?')
  assert.equal(a.via, '')
})

test('busy is working, with the running tool', () => {
  const t = feed([user(1, 'go'), assistant(2, [tool('t1', 'Bash', { command: 'npm test' })])])
  const a = classify({ session: session('busy'), t })
  assert.equal(a.state, 'working')
  assert.equal(a.cmd, 'Bash(npm test)')
  assert.equal(a.since, at(2))
  assert.equal(classify({ session: session('busy'), t: feed([user(1, 'go')]) }).cmd, 'Thinking…')
})

test('a finished turn is done until you review it, then idle', () => {
  const t = feed([user(1, 'go'), assistant(5, [{ type: 'text', text: '**Done.** All `3` tests pass.' }], { stop_reason: 'end_turn' })])
  let a = classify({ session: session('idle'), t })
  assert.equal(a.state, 'done')
  assert.equal(a.cmd, 'Done. All 3 tests pass.')
  a = classify({ session: session('idle'), t, reviewedAt: at(6) })
  assert.equal(a.state, 'idle')
  // A new prompt after the reply means the turn in flight isn't finished.
  addEntry(t, user(7, 'and another thing'))
  assert.equal(classify({ session: session('idle'), t }).state, 'idle')
})

test('a monitoring session sits in the strip, not the lanes', () => {
  const a = classify({ session: session('idle'), t: feed(babysit), alive: () => true, now: at(10) })
  assert.equal(a.monitor, true)
  assert.equal(a.monitors[0].state, 'watching')
  assert.equal(a.monitors[0].kind, 'pr-babysit')
  const l = lanes([a])
  assert.equal(l.done.length + l.idle.length + l.needs.length, 0)
  assert.equal(monitorsOf([a]).length, 1)
  assert.equal(counts([a]).watching, 1)
})

test('a monitor needs action when its last event needs a person', () => {
  const t = feed([...babysit, user(8, notification('b5sky', '[failed] lint on job 4/9'))])
  const a = classify({ session: session('idle'), t, alive: () => true, now: at(10) })
  assert.equal(a.monitors[0].state, 'action')
  assert.equal(a.state, 'needs')
  assert.equal(a.need, 'monitor')
  assert.equal(a.cmd, '[failed] lint on job 4/9')
  assert.equal(lanes([a]).needs.length, 1)
  // Once reviewed, it's back to watching.
  const seen = classify({ session: session('idle'), t, alive: () => true, reviewedAt: at(9), now: at(10) })
  assert.equal(seen.monitors[0].state, 'watching')
  assert.notEqual(seen.state, 'needs')
})

test('a monitor whose command is gone is stale; an expired one ends', () => {
  let a = classify({ session: session('idle'), t: feed(babysit), alive: () => false, now: at(10) })
  assert.equal(a.monitors[0].state, 'stale')
  assert.match(a.monitors[0].command, /watch_pr\.py/, 'the hub finds its process by its command')
  const exited = '<task-notification>\n<task-id>b5sky</task-id>\n<status>failed</status>\n<summary>Monitor "PR #1 pipeline" exited with code 143</summary>\n</task-notification>'
  a = classify({ session: session('idle'), t: feed([...babysit, user(9, exited)]), now: at(10) })
  assert.equal(a.monitors[0].state, 'ended', 'a monitor the hub stopped ends')
  const t = feed([...babysit, user(9, notification('b5sky', '[Monitor expired after 30m]'))])
  a = classify({ session: session('idle'), t, alive: () => false, now: at(10) })
  assert.equal(a.monitors[0].state, 'ended')
  assert.equal(a.monitor, false)
  a = classify({ session: session('idle'), t, now: at(9) + 4 * 60 * 1000 })
  assert.equal(a.monitors.length, 1, 'an ended monitor stays a while, so you see it went')
  a = classify({ session: session('idle'), t, now: at(9) + 6 * 60 * 1000 })
  assert.equal(a.monitors.length, 0, 'and leaves after five minutes')
})

test('a stopped monitor leaves at once: by the hub, or by TaskStop', () => {
  let a = classify({ session: session('idle'), t: feed(babysit), alive: () => true, stopped: new Set(['b5sky']), now: at(10) })
  assert.equal(a.monitors.length, 0, 'the hub stopped it, before or after its exit is reported')
  assert.equal(a.monitor, false)
  const t = feed([...babysit, assistant(8, [tool('s1', 'TaskStop', { task_id: 'b5sky' })])])
  a = classify({ session: session('idle'), t, now: at(10) })
  assert.equal(a.monitors.length, 0)
})

test('a monitor armed before its session\'s process started ended with the last one', () => {
  const resumed = session('idle', { startedAt: at(20), statusUpdatedAt: at(20) })
  let a = classify({ session: resumed, t: feed(babysit), alive: () => true, now: at(30) })
  assert.equal(a.monitors[0].state, 'ended', 'even when its command line happens to still match')
  assert.equal(a.monitors[0].ended.reason, 'restarted')
  a = classify({ session: resumed, t: feed(babysit), now: at(20) + 6 * 60 * 1000 })
  assert.equal(a.monitors.length, 0)
})

test('a notification for several tasks ends each of them', () => {
  const t = feed([
    ...babysit,
    assistant(7, [tool('m2', 'Monitor', { command: 'tail -f a.log', description: 'a.log errors' })]),
    user(8, [result('m2', 'Monitor started (task c7, expires in 30m)')]),
    user(9, '<task-notification>\n<task-id>b5sky</task-id>\n<task-id>c7</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background shell command tasks didn\'t finish before the previous session ended.</summary>\n</task-notification>'),
  ])
  assert.ok(t.monitors.b5sky.ended)
  assert.ok(t.monitors.c7.ended)
})

test('a re-armed monitor shows once', () => {
  const t = feed([
    ...babysit,
    user(9, notification('b5sky', '[Monitor expired after 30m]')),
    assistant(10, [tool('m2', 'Monitor', { command: 'python3 -u /s/watch_pr.py x', description: 'PR #1 pipeline' })]),
    user(11, [result('m2', 'Monitor started (task c7, expires in 30m)')]),
  ])
  const a = classify({ session: session('idle'), t, alive: () => true, now: at(12) })
  assert.equal(a.monitors.length, 1)
  assert.equal(a.monitors[0].task, 'c7')
})

test('a monitor\'s process is the newest shell under its session running its command', () => {
  const cmd = `tail -f app.log | grep --line-buffered 'ERROR'`
  const evald = c => `/usr/bin/zsh -c source snap.sh && eval '${c.replaceAll("'", `'"'"'`)}' && pwd -P`
  const procs = [
    { pid: 10, ppid: 1, pgid: 10, start: 100, cmdline: evald(cmd) },
    { pid: 11, ppid: 1, pgid: 11, start: 200, cmdline: evald(cmd) },
    { pid: 12, ppid: 2, pgid: 12, start: 300, cmdline: evald(cmd) }, // another session's
    { pid: 13, ppid: 1, pgid: 13, start: 400, cmdline: evald('while true; do sleep 60; done') },
    { pid: 14, ppid: 11, pgid: 11, start: 210, cmdline: 'tail -f app.log' }, // the pipeline, not the shell
    { pid: 15, ppid: 1, pgid: 15, start: 500, cmdline: evald(`pgrep -f "${cmd}"`) }, // a Bash call that mentions it
  ]
  assert.equal(monitorProcess(procs, 1, cmd).pid, 11)
  assert.equal(monitorProcess(procs, 2, cmd).pid, 12)
  assert.equal(monitorProcess(procs, 1, 'python3 watch.py'), null)
  assert.equal(monitorProcess(procs, 0, cmd), null)
  assert.equal(monitorProcess([{ pid: 20, ppid: 1, pgid: 20, start: 1, cmdline: `bash -c ${cmd}` }], 1, cmd).pid, 20)
})

test('a tab parked on a background job is one agent with it, shown in the tab', () => {
  const tab = session('busy', { sessionId: 'tab1', pid: 5, parkedJobId: 'job1', tmux: 'ghostty-1:@3.%4' })
  const job = session('idle', { sessionId: 'job1', pid: 6, kind: 'bg', jobId: 'job1' })
  const other = session('busy', { sessionId: 's9', pid: 7 })
  const out = pairParked([tab, job, other])
  assert.deepEqual(out.map(e => e.session.sessionId), ['job1', 's9'], 'the tab is not an agent of its own')
  assert.equal(out[0].viewer, tab, 'the job shows in the tab')
  assert.equal(out[1].viewer, null)
  const [alone] = pairParked([tab])
  assert.equal(alone.session.sessionId, 'tab1', 'a tab whose job is gone stays')
  assert.equal(alone.session.status, 'idle', 'not stuck at the status it parked with')
})

test('worktree sessions know their repo and worktree', () => {
  assert.deepEqual(repoOf('/p/gad/.claude/worktrees/comments'), { repo: 'gad', worktree: 'comments' })
  const a = classify({ session: session('idle', { cwd: '/p/gad/.claude/worktrees/comments' }), t: emptyTranscript() })
  assert.equal(a.repo, 'gad')
  assert.equal(a.worktree, 'comments')
  assert.equal(a.title, 'New session')
})

test('an agent is named by /rename, then --name, then Claude\'s title, then its first prompt', () => {
  const name = (entries, extra) => classify({ session: session('idle', extra), t: feed(entries) }).title
  const ai = { type: 'ai-title', aiTitle: 'Steam pixel art app' }
  const agent = { type: 'agent-name', agentName: 'gad-components' }
  const custom = { type: 'custom-title', customTitle: 'Sprite exporter' }
  assert.equal(name([user(1, 'make the sprites export\nand more')]), 'make the sprites export')
  assert.equal(name([user(1, 'go'), ai]), 'Steam pixel art app')
  assert.equal(name([user(1, 'go'), ai], { name: 'jstack-12', nameSource: 'derived' }), 'Steam pixel art app')
  assert.equal(name([user(1, 'go'), ai], { kind: 'bg', name: 'babysit #91' }), 'babysit #91')
  assert.equal(name([user(1, 'go'), ai, agent]), 'gad-components')
  assert.equal(name([user(1, 'go'), ai, agent, custom]), 'Sprite exporter')
})

test('lanes: needs and idle oldest first, working and done newest first', () => {
  const mk = (id, state, since) => ({ id, state, since, monitor: false, monitors: [] })
  const l = lanes([mk('a', 'needs', 5), mk('b', 'needs', 1), mk('c', 'working', 1), mk('d', 'working', 5), mk('e', 'idle', 9), mk('f', 'idle', 2)])
  assert.deepEqual(l.needs.map(a => a.id), ['b', 'a'])
  assert.deepEqual(l.working.map(a => a.id), ['d', 'c'])
  assert.deepEqual(l.idle.map(a => a.id), ['f', 'e'])
})

test('overflow: working compacts, done folds, needs never shrinks', () => {
  assert.deepEqual(cardHeights('working', 3, 20), [4, 4, 4])
  assert.deepEqual(cardHeights('working', 8, 20), Array(8).fill(3))
  assert.deepEqual(cardHeights('done', 5, 20), [4, 4, 1, 1, 1])
  assert.deepEqual(cardHeights('done', 5, 20, 3), [4, 4, 4, 1, 1], 'Settings can keep more done cards')
  assert.deepEqual(cardHeights('done', 2, 20, 0), [1, 1])
  assert.deepEqual(cardHeights('needs', 9, 10), Array(9).fill(4))
  assert.deepEqual(cardHeights('idle', 3, 10), [1, 1, 1])
})

test('scrollTo keeps the selected card on screen', () => {
  const h = Array(9).fill(4)
  assert.equal(scrollTo(h, 20, 0), 0)
  assert.equal(scrollTo(h, 20, 3), 0)
  assert.ok(scrollTo(h, 20, 8) > 0)
  const top = scrollTo(h, 20, 8)
  assert.ok(h.slice(top, 9).reduce((a, b) => a + b, 0) <= 20 - 2)
  assert.equal(scrollTo(h, 20, 2, 5), 2, 'scrolls back up to a card above')
})

test('launch: a tab task is a quoted command line', () => {
  const p = launch({ kind: 'task', cwd: '/p/gad', prompt: "fix the user's page", runAs: 'tab', model: 'sonnet', mode: 'default', effort: 'high' })
  assert.equal(p.where, 'tab')
  assert.equal(p.line, "claude --model sonnet --effort high 'fix the user'\\''s page'")
  const w = launch({ kind: 'task', cwd: '/p', prompt: 'Add cursor pagination to comments', runAs: 'tab', worktree: true })
  assert.equal(w.line, "claude -w add-cursor-pagination-to-comments 'Add cursor pagination to comments'")
})

test('launch: background agents, PR babysitters and log watchers', () => {
  const b = launch({ kind: 'task', cwd: '/p', prompt: 'write docs', runAs: 'bg', mode: 'plan' })
  assert.deepEqual(b.argv, ['claude', '--bg', '--name', 'write-docs', '--permission-mode', 'plan', 'write docs'])
  const bw = launch({ kind: 'task', cwd: '/p', prompt: 'write docs', runAs: 'bg', worktree: true })
  assert.deepEqual(bw.argv, ['claude', '--bg', '-w', 'write-docs', '--name', 'write-docs', 'write docs'])
  const pr = launch({ kind: 'pr', cwd: '/p', target: ' https://github.com/u/gad/pull/91 ' })
  assert.deepEqual(pr.argv, ['claude', '--bg', '--name', 'babysit #91', '/pr-babysit https://github.com/u/gad/pull/91'])
  const logs = launch({ kind: 'logs', cwd: '/p', target: 'docker compose logs api' })
  assert.equal(logs.where, 'bg')
  assert.equal(logs.argv.at(-1), '/logger watch docker compose logs api')
  assert.equal(launch({ kind: 'task', cwd: '/p', prompt: '-rf everything', runAs: 'bg' }).argv.at(-1), ' -rf everything')
})

test('render clips to the width in cells, wide characters included', () => {
  const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  assert.equal(strip(render([['hello']], 8)), 'hello   ')
  assert.equal(strip(render([['hello world']], 8)), 'hello w…')
  assert.equal(width(strip(render([['日本語のテキスト']], 7))), 7)
  assert.equal(strip(render([['▲ 5']], 3)), '▲ 5')
})

test('clean strips escape sequences from other people\'s text', () => {
  assert.equal(clean('ok\x1b]52;c;evil\x07 done\n'), 'ok ]52;c;evil  done ')
})
