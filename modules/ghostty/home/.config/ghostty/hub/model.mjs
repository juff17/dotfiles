// What the hub knows about each Claude session, worked out from files Claude
// already writes, so no hooks are needed:
//   - ~/.claude/sessions/<pid>.json: status (busy, idle, waiting), what a
//     waiting session waits for, and its tmux pane.
//   - the session's transcript (~/.claude/projects/*/<id>.jsonl): the prompt,
//     the tool running now, the last reply, context use, and every Monitor it
//     armed with the events those monitors delivered.
// Everything here is pure, so model.test.mjs covers it without a terminal.

import { basename, relative } from 'node:path'
import { load as settings } from './settings.mjs'

// ---------------------------------------------------------------- transcript

export function emptyTranscript() {
  return {
    prompt: null, // { text, at }
    reply: null, // { text, at }
    tool: null, // { id, name, input, at, done }
    turnEndAt: 0,
    ctx: 0,
    model: '',
    branch: '',
    monitors: {}, // task id -> monitor
    armed: {}, // Monitor tool_use id -> { description, command, at }, until its result names the task
    queued: [], // notifications seen queued and not yet delivered
    // The names Claude Code writes into the transcript: one set with /rename,
    // one given at launch (--name), and the title it makes up itself.
    names: { custom: '', agent: '', ai: '' },
  }
}

const time = e => Date.parse(e.timestamp) || 0
const firstLine = s =>
  String(s ?? '')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean) ?? ''
// A reply's first line without its Markdown, the way it reads on screen.
const plain = s =>
  firstLine(s)
    .replace(/^#+\s+|^[-*]\s+|^>\s+/, '')
    .replace(/\*\*|__|`/g, '')
const unescape = s =>
  s.replace(/&(lt|gt|amp|quot|#39);/g, (_, n) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[n])

// The text a person typed, or null for the wrappers Claude Code puts in the
// user's turn: command output, reminders, task notifications.
function typed(content) {
  if (typeof content !== 'string') {
    const text = (content ?? []).find(b => b.type === 'text')?.text
    return text === undefined ? null : typed(text)
  }
  const command = content.match(/<command-name>([^<]*)<\/command-name>/)
  if (command) {
    const args = content.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? ''
    return `${command[1]} ${args}`.trim()
  }
  if (content.startsWith('<') || content.startsWith('[Request interrupted')) return null
  return content
}

// One task notification: which task, its summary, and its event lines. One
// can name several tasks, such as the one a resumed session gets for every
// task its last process left running; `id` is the first.
export function parseNotification(text) {
  const ids = [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => m[1])
  const id = ids[0]
  if (!id) return null
  const summary = unescape(text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '')
  const event = text.match(/<event>([\s\S]*?)<\/event>/)?.[1]
  const lines = event === undefined ? [] : unescape(event).split('\n').map(l => l.trim()).filter(Boolean)
  return { id, ids, summary, lines }
}


// A notification that arrives while Claude is busy is written twice: when
// it's queued and again when Claude reads it. The second copy is skipped by
// matching it to the first, so the same event happening twice still counts.
function addNotification(t, text, at, queued = false) {
  const raw = text.trim()
  if (queued) {
    t.queued.push(raw)
    if (t.queued.length > 50) t.queued.shift()
  } else {
    const i = t.queued.indexOf(raw)
    if (i >= 0) {
      t.queued.splice(i, 1)
      return
    }
  }
  const n = parseNotification(text)
  if (!n) return
  if (!n.summary.startsWith('Monitor event')) {
    for (const id of n.ids) {
      const m = t.monitors[id]
      if (m) m.ended = m.ended || { reason: firstLine(n.summary) || 'ended', at }
    }
    return
  }
  const m = t.monitors[n.id]
  if (!m) return
  for (const line of n.lines) {
    if (line.startsWith('[Monitor expired')) {
      m.ended = { reason: 'expired', at }
      continue
    }
    const tag = line.match(/^\[([a-z-]+)\]/i)?.[1]?.toLowerCase() ?? ''
    m.events.push({ line, tag, at })
    while (m.events.length > settings()['hub.maxEvents']) m.events.shift()
  }
}

// Folds one transcript entry into t. Entries arrive in file order, so the
// latest of each kind wins.
export function addEntry(t, e) {
  const at = time(e)
  if (e.type === 'custom-title' && e.customTitle) t.names.custom = e.customTitle
  if (e.type === 'agent-name' && e.agentName) t.names.agent = e.agentName
  if (e.type === 'ai-title' && e.aiTitle) t.names.ai = e.aiTitle
  if (e.gitBranch) t.branch = e.gitBranch
  if (e.type === 'queue-operation' && e.operation === 'enqueue' && typeof e.content === 'string') {
    if (e.content.startsWith('<task-notification>')) addNotification(t, e.content, at, true)
    return
  }
  const msg = e.message
  if (!msg) return
  if (e.type === 'assistant') {
    if (msg.model && msg.model !== '<synthetic>') t.model = msg.model
    const u = msg.usage
    if (u) t.ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type === 'text' && b.text?.trim()) t.reply = { text: b.text, at }
      if (b.type === 'tool_use') {
        t.tool = { id: b.id, name: b.name, input: b.input ?? {}, at, done: false }
        if (b.name === 'Monitor')
          t.armed[b.id] = { description: b.input?.description ?? '', command: b.input?.command ?? '', at }
        if (b.name === 'TaskStop') {
          const m = t.monitors[b.input?.task_id ?? b.input?.shell_id]
          if (m) m.ended = { reason: 'stopped', at }
        }
      }
    }
    if (msg.stop_reason === 'end_turn') t.turnEndAt = at
    return
  }
  if (e.type !== 'user' || e.isMeta) return
  const content = msg.content
  if (typeof content === 'string' && content.startsWith('<task-notification>')) {
    addNotification(t, content, at)
    return
  }
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type !== 'tool_result') continue
      if (t.tool?.id === b.tool_use_id) t.tool.done = true
      const armed = t.armed[b.tool_use_id]
      if (armed) {
        delete t.armed[b.tool_use_id]
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map(c => c.text ?? '').join('')
        const task = text.match(/task (\w+)/)?.[1]
        if (task) t.monitors[task] = { task, ...armed, events: [], ended: null }
      }
    }
  }
  // A tool result can carry text with it (a skill's instructions); that's
  // Claude Code talking, not you.
  const text = Array.isArray(content) && content.some(b => b.type === 'tool_result') ? null : typed(content)
  if (text !== null) {
    t.prompt = { text, at }
    if (t.tool) t.tool.done = true
  } else if (typeof content === 'string' && content.startsWith('[Request interrupted')) {
    if (t.tool) t.tool.done = true
  }
}

// ---------------------------------------------------------------- one line

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// A tool call as one line, the way Claude Code prints it: Bash(npm test).
export function describeTool(tool, cwd = '') {
  if (!tool) return ''
  const i = tool.input ?? {}
  const path = p => {
    if (!p) return ''
    const r = cwd ? relative(cwd, p) : p
    return r.startsWith('..') ? p : r
  }
  const name = tool.name.startsWith('mcp__') ? `${tool.name.split('__').pop()} (MCP)` : tool.name
  const arg =
    {
      Bash: () => firstLine(i.command),
      Read: () => path(i.file_path),
      Write: () => path(i.file_path),
      Edit: () => path(i.file_path),
      NotebookEdit: () => path(i.notebook_path),
      Grep: () => i.pattern,
      Glob: () => i.pattern,
      WebFetch: () => i.url,
      WebSearch: () => i.query,
      Agent: () => i.description,
      Task: () => i.description,
      Skill: () => i.skill,
      Monitor: () => i.description,
    }[tool.name]?.() ?? ''
  if (tool.name === 'AskUserQuestion') return `? ${firstLine(i.questions?.[0]?.question)}`
  return arg ? `${name}(${short(firstLine(arg), 120)})` : name
}

// ---------------------------------------------------------------- agents

// Event tags from pr-babysit and logger that mean a person has to decide.
const ATTENTION = new Set(['failed', 'manual', 'stuck', 'conflict', 'conflicts', 'error', 'crash', 'auth', 'setup', 'blocked'])
// A monitor that ended on its own (expired, failed, its session restarted)
// stays on the board for Settings' hub.endedFor minutes, so you see it went.
// One you stopped leaves at once.

export function monitorKind(command) {
  if (/watch_pr\.py/.test(command)) return 'pr-babysit'
  if (/watch_logs\.py/.test(command)) return 'logger'
  return basename(String(command).trim().split(/\s+/).find(w => !/^(python3?|node|bash|sh|-u)$/.test(w)) ?? 'monitor')
}

// The process running a monitor, from a list of { pid, ppid, pgid, start,
// cmdline }: Claude runs each one as a shell of its own, a child of the
// session's claude process that leads its own process group, as
// `eval '<command>'` (or `-c <command>` at the end, for other shells). The
// whole command must match: a Bash call that only mentions it, also a child
// of claude, mustn't be taken for it. The newest wins, as the strip shows
// only the latest monitor of a name.
export function monitorProcess(procs, sessionPid, command) {
  const cmd = String(command ?? '')
  if (!sessionPid || !cmd) return null
  const evald = `eval '${cmd.replaceAll("'", `'"'"'`)}'`
  const runs = line => line.includes(evald) || line.trimEnd().endsWith(` -c ${cmd}`)
  const mine = procs.filter(p => p.ppid === sessionPid && runs(p.cmdline))
  return mine.sort((a, b) => b.start - a.start)[0] ?? null
}

// A tab can park its conversation in a background job (parkedJobId) and
// then only shows it: its own session file stops at the status it had when
// it parked, and its transcript at that point. So the two are one agent:
// the job's session, with the tab's session as `viewer`, whose pane it
// shows in. A tab parked on a job that's gone is idle, not stuck where it
// stopped.
export function pairParked(list) {
  const jobs = new Map(list.filter(s => s.jobId).map(s => [s.jobId, s]))
  const viewers = new Map()
  const out = []
  for (const s of list) {
    if (!s.parkedJobId) continue
    if (jobs.has(s.parkedJobId)) viewers.set(s.parkedJobId, s)
  }
  for (const s of list) {
    if (s.parkedJobId && jobs.has(s.parkedJobId)) continue
    if (s.parkedJobId) out.push({ session: { ...s, status: 'idle' }, viewer: null })
    else out.push({ session: s, viewer: (s.jobId && viewers.get(s.jobId)) || null })
  }
  return out
}

// A worktree session runs in <repo>/.claude/worktrees/<name>.
export function repoOf(cwd) {
  const m = cwd.match(/^(.*)\/\.claude\/worktrees\/([^/]+)/)
  return m ? { repo: basename(m[1]), worktree: m[2] } : { repo: basename(cwd), worktree: '' }
}

// `pane` is the session's tmux pane on the tab server, or null; `alive(cmd)`
// says whether a monitor's command still runs (true, false, or null when
// unknown); `reviewedAt` is when you last looked at the session's result;
// `stopped` holds the tasks the hub stopped.
// An agent's name, the first there is of: the one set with /rename, the one
// it was launched with (--name, or the session file's name when that wasn't
// derived from the folder), the title Claude Code gave it, its first prompt.
function nameOf(session, t) {
  const given = session.nameSource === 'derived' ? '' : session.name
  const prompt = firstLine(t.prompt?.text)
  return (
    t.names.custom ||
    t.names.agent ||
    given ||
    t.names.ai ||
    (prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt) ||
    'New session'
  )
}

export function classify({ session, t, pane, reviewedAt = 0, alive = () => null, stopped = new Set(), now = Date.now() }) {
  const { repo, worktree } = repoOf(session.cwd)
  const bg = session.kind === 'bg' || session.kind === 'background'
  const status = session.status === 'waiting' ? 'waiting' : session.status === 'busy' ? 'busy' : 'idle'
  const pending = t.tool && !t.tool.done ? t.tool : null

  let state = 'idle'
  let since = session.statusUpdatedAt ?? session.startedAt ?? 0
  let cmd = ''
  let need = null
  if (status === 'waiting') {
    state = 'needs'
    if (pending?.name === 'AskUserQuestion') {
      need = 'question'
      cmd = describeTool(pending)
    } else if (pending) {
      need = 'permission'
      cmd = `Allow ${describeTool(pending, session.cwd)}?`
    } else {
      need = 'input'
      cmd = `Waiting: ${session.waitingFor ?? 'input needed'}`
    }
  } else if (status === 'busy') {
    state = 'working'
    cmd = pending ? describeTool(pending, session.cwd) : 'Thinking…'
    if (pending) since = pending.at
  } else {
    const finished = t.turnEndAt && t.turnEndAt >= (t.prompt?.at ?? 0)
    state = finished && t.turnEndAt > reviewedAt ? 'done' : 'idle'
    if (finished) since = t.turnEndAt
    cmd = plain(t.reply?.text) || (t.prompt ? `> ${firstLine(t.prompt.text)}` : 'New session')
  }

  const monitors = []
  const latest = {}
  for (const m of Object.values(t.monitors)) {
    if (!latest[m.description] || latest[m.description].at < m.at) latest[m.description] = m
  }
  // A monitor runs inside its session's process, so one armed before this
  // process started went with the last one, even when no notification said
  // so.
  const started = session.startedAt ?? 0
  for (const m of Object.values(latest)) {
    const ended = m.ended ?? (m.at < started ? { reason: 'restarted', at: started } : null)
    if (stopped.has(m.task) || ended?.reason === 'stopped') continue
    if (ended && now - ended.at > settings()['hub.endedFor'] * 60 * 1000) continue
    const event = m.events.at(-1) ?? null
    let mstate = 'watching'
    if (ended) mstate = 'ended'
    else if (alive(m.command) === false) mstate = 'stale'
    if (mstate !== 'ended') {
      if (state === 'needs') mstate = 'action'
      else if (status === 'idle' && event && ATTENTION.has(event.tag) && event.at > reviewedAt) mstate = 'action'
    }
    monitors.push({
      key: `${session.sessionId}:${m.task}`,
      task: m.task,
      description: m.description,
      kind: monitorKind(m.command),
      command: m.command,
      state: mstate,
      busy: status === 'busy',
      event,
      startedAt: m.at,
      ended,
    })
  }
  // A session that is watching something lives in the monitors strip; it
  // shows in a lane only when it needs you.
  const watching = monitors.some(m => m.state !== 'ended')
  const action = monitors.find(m => m.state === 'action')
  if (watching && state !== 'needs' && action) {
    state = 'needs'
    need = 'monitor'
    cmd = action.event ? action.event.line : action.description
    since = action.event?.at ?? since
  }

  return {
    id: session.sessionId,
    pid: session.pid,
    kind: pane ? 'tab' : bg ? 'bg' : 'term',
    title: nameOf(session, t),
    repo,
    worktree,
    cwd: session.cwd,
    branch: t.branch,
    state,
    need,
    cmd,
    // since: when the current tool started, or the state did; stateSince:
    // when the session's status last changed.
    since,
    stateSince: session.statusUpdatedAt ?? session.startedAt ?? 0,
    prompt: firstLine(t.prompt?.text),
    ctx: t.ctx,
    model: t.model,
    jobId: session.jobId ?? null,
    pane: pane ?? null,
    monitor: watching,
    monitors,
  }
}

// ---------------------------------------------------------------- board

// The order inside each lane: Needs you and Idle oldest first (the longest
// wait is the most urgent, the longest idle the first to close), Working and
// Done newest first.
export function lanes(agents) {
  const by = state => agents.filter(a => a.state === state && (!a.monitor || state === 'needs'))
  const old = (a, b) => a.since - b.since
  const recent = (a, b) => b.since - a.since
  return {
    needs: by('needs').sort(old),
    working: by('working').sort(recent),
    done: by('done').sort(recent),
    idle: by('idle').sort(old),
  }
}

export function monitorsOf(agents) {
  const rank = { action: 0, stale: 1, watching: 2, ended: 3 }
  return agents
    .flatMap(a => a.monitors.map(m => ({ ...m, agent: a })))
    .sort((a, b) => rank[a.state] - rank[b.state] || (b.event?.at ?? b.startedAt) - (a.event?.at ?? a.startedAt))
}

export function counts(agents) {
  const l = lanes(agents)
  return {
    needs: l.needs.length,
    working: l.working.length,
    done: l.done.length,
    idle: l.idle.length,
    watching: agents.reduce((n, a) => n + a.monitors.filter(m => m.state === 'watching').length, 0),
    monitors: agents.reduce((n, a) => n + a.monitors.length, 0),
  }
}

// How each lane fits its cards in `height` rows. Needs you never shrinks a
// card, since every one is a decision; Working drops to a card with only its
// command once full cards don't fit; Done keeps its newest two as cards and
// folds the rest to a line each; Idle is always one line. Returns each item's
// height: a full card is its top border (the title), two lines and its
// bottom border.
export function cardHeights(lane, n, height, doneCards = 2) {
  const FULL = 4
  if (lane === 'needs') return Array(n).fill(FULL)
  if (lane === 'working') return Array(n).fill(n * FULL <= height ? FULL : 3)
  if (lane === 'done') return Array.from({ length: n }, (_, i) => (i < doneCards ? FULL : 1))
  return Array(n).fill(1)
}

// The first item to show so that `selected` is on screen, given the heights
// and the rows available (one row is kept for a "more" cue when it scrolls).
export function scrollTo(heights, height, selected, from = 0) {
  if (selected < 0) return 0
  let top = Math.min(from, selected)
  const fits = (a, b) => heights.slice(a, b + 1).reduce((n, h) => n + h, 0) <= height - (a > 0 ? 1 : 0) - 1
  while (top < selected && !fits(top, selected)) top++
  return top
}

// ---------------------------------------------------------------- new agents

const quote = s => `'${String(s).replaceAll("'", `'\\''`)}'`
export const slug = s =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-')
    .slice(0, 40) || 'agent'

// What starting a new agent runs. A tab agent is a command line typed into a
// new tmux tab's shell, so the shell stays when Claude exits; a background
// agent is `claude --bg`, which prints its id and returns. Either can start in
// its own worktree (`-w`); monitors always run in the background, in place.
export function launch(spec) {
  const opts = []
  if (spec.model && spec.model !== 'default') opts.push('--model', spec.model)
  if (spec.mode && spec.mode !== 'default') opts.push('--permission-mode', spec.mode)
  if (spec.effort && spec.effort !== 'default') opts.push('--effort', spec.effort)
  let prompt = spec.prompt?.trim() ?? ''
  let name = ''
  let where = spec.runAs ?? 'tab'
  if (spec.kind === 'pr') {
    prompt = `/pr-babysit ${spec.target.trim()}`
    const num = spec.target.match(/(?:pull|merge_requests)\/(\d+)/)?.[1]
    name = `babysit ${num ? `#${num}` : basename(spec.target.trim())}`
    where = 'bg'
  } else if (spec.kind === 'logs') {
    prompt = `/logger watch ${spec.target.trim()}`
    name = `logs ${short(spec.target.trim(), 30)}`
    where = 'bg'
  } else {
    // A name given is a slug already: the todo list's hand-off sends one.
    name = spec.name || slug(prompt)
  }
  // A prompt that starts with - would read as an option.
  if (prompt.startsWith('-')) prompt = ` ${prompt}`
  const wt = spec.kind === 'task' && spec.worktree ? ['-w', slug(name)] : []
  if (where === 'bg') return { where, cwd: spec.cwd, argv: ['claude', '--bg', ...wt, '--name', name, ...opts, prompt], name }
  const args = [...wt, ...opts]
  return {
    where,
    cwd: spec.cwd,
    name,
    line: ['claude', ...args.map(a => (/^[\w./=-]+$/.test(a) ? a : quote(a))), quote(prompt)].join(' '),
  }
}
