#!/usr/bin/env node
// agentd: the one process that watches every Claude session, so a rail in
// each window and a hub in each window cost no more than one. Once a second
// it reads Claude's session files, the new lines of their transcripts and the
// tab server's panes, and writes what it found to state.json, which the hub
// and the rails read (client.mjs). It also marks each agent's tmux tab with
// its state's glyph (tmux.conf draws it).
// It runs while a hub or rail does: they register in clients/, and it exits
// once none is left. A second copy exits at once, so starting it is safe.
//   agentd.mjs [--once]   --once prints one state to stdout and exits

import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addEntry, classify, emptyTranscript } from './model.mjs'
import { STATE, MONITOR } from './term.mjs'
import { RUN, alivePid } from './client.mjs'

const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const SESSIONS = join(CLAUDE, 'sessions')
const PROJECTS = join(CLAUDE, 'projects')
const TABS_SOCKET = process.env.AGENT_HUB_TABS_SOCKET || 'ghostty'
const TICK_MS = 1000
const PROC_SCAN_MS = 5000
const IDLE_EXIT_MS = 15000
const ONCE = process.argv.includes('--once')

const exec = (cmd, args) =>
  new Promise(resolve =>
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)),
  )

// ------------------------------------------------------------ singleton

const PID_FILE = join(RUN, 'agentd.pid')

function claim() {
  mkdirSync(join(RUN, 'clients'), { recursive: true })
  mkdirSync(join(RUN, 'reviewed'), { recursive: true })
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(PID_FILE, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch {
      let pid = 0
      let age = Infinity
      try {
        pid = Number(readFileSync(PID_FILE, 'utf8')) || 0
        age = Date.now() - statSync(PID_FILE).mtimeMs
      } catch {}
      if (alivePid(pid)) return false
      // Empty and new: another copy is between creating it and writing to it.
      if (!pid && age < 2000) return false
      try {
        unlinkSync(PID_FILE)
      } catch {}
    }
  }
  return false
}

function release() {
  try {
    if (Number(readFileSync(PID_FILE, 'utf8')) === process.pid) unlinkSync(PID_FILE)
  } catch {}
}

// ------------------------------------------------------------ sessions

// The live Claude processes. A session file outlives a crashed process, and
// a pid can be reused, so the process must still be the one that wrote it.
function sessions() {
  let names = []
  try {
    names = readdirSync(SESSIONS).filter(n => n.endsWith('.json'))
  } catch {
    return []
  }
  const list = []
  for (const name of names) {
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS, name), 'utf8'))
      if (!s.sessionId || !s.pid) continue
      const stat = readFileSync(`/proc/${s.pid}/stat`, 'utf8')
      // Field 22, the start time; the command name before it can hold spaces.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (s.procStart && String(s.procStart) !== start) continue
      list.push(s)
    } catch {}
  }
  return list
}

// ------------------------------------------------------------ transcripts

const transcripts = new Map() // session id -> { path, offset, rest (bytes), t }

function findTranscript(s) {
  const guess = join(PROJECTS, s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`)
  if (existsSync(guess)) return guess
  try {
    for (const dir of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, dir, `${s.sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {}
  return null
}

// Reads only what was appended since last time. Lines that can't matter
// (the request snapshots, which are most of the file) skip JSON parsing.
function transcript(s) {
  let tr = transcripts.get(s.sessionId)
  if (!tr) {
    const path = findTranscript(s)
    if (!path) return emptyTranscript()
    tr = { path, offset: 0, rest: Buffer.alloc(0), t: emptyTranscript() }
    transcripts.set(s.sessionId, tr)
  }
  let size
  try {
    size = statSync(tr.path).size
  } catch {
    return tr.t
  }
  if (size < tr.offset) Object.assign(tr, { offset: 0, rest: Buffer.alloc(0), t: emptyTranscript() })
  if (size === tr.offset) return tr.t
  // A megabyte at a time, decoding only whole lines: a long session's file can
  // be bigger than one string may be, and a character can straddle two reads.
  const fd = openSync(tr.path, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    while (tr.offset < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - tr.offset), tr.offset)
      if (n <= 0) break
      tr.offset += n
      const data = Buffer.concat([tr.rest, buf.subarray(0, n)])
      const end = data.lastIndexOf(10)
      tr.rest = Buffer.from(end < 0 ? data : data.subarray(end + 1))
      if (end >= 0) readLines(tr.t, data.subarray(0, end).toString('utf8'))
    }
  } finally {
    closeSync(fd)
  }
  return tr.t
}

function readLines(t, text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('{"type":"api-request')) continue
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"queue-operation"'))
      continue
    try {
      addEntry(t, JSON.parse(line))
    } catch {}
  }
}

// ------------------------------------------------------------ tmux

const PANE_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_active}\t#{session_attached}\t#{@agent} #{@agent_fg}\t#{pane_pid}'
const LAYOUT_SOCKET = process.env.GHOSTTY_LAYOUT_SOCKET || 'ghostty-layout'

// The Ghostty windows showing their hub rather than their workspace: a tab
// in front of one of those isn't being looked at.
async function hubShown() {
  const text = await exec('tmux', ['-L', LAYOUT_SOCKET, 'list-windows', '-a', '-F', '#{session_name} #{window_name} #{window_active}'])
  const wins = new Set()
  for (const line of (text ?? '').split('\n')) {
    const [session, name, active] = line.split(' ')
    if (name === 'hub' && active === '1') wins.add(Number(session.replace(/^layout-/, '')))
  }
  return wins
}

async function panes() {
  const [text, hub] = await Promise.all([exec('tmux', ['-L', TABS_SOCKET, 'list-panes', '-a', '-F', PANE_FORMAT]), hubShown()])
  const map = new Map()
  map.marks = new Map() // window id -> its glyph and color as tmux has them now
  for (const line of (text ?? '').split('\n')) {
    const [pane, session, window, index, active, attached, mark, pid] = line.split('\t')
    if (!pane) continue
    if (mark?.trim()) map.marks.set(window, mark)
    const seen = map.get(pane)
    // A peek session from the hub shares the windows of a tab session; the
    // tab session's name is the one the pane belongs to.
    const own = /^ghostty-\d+$/.test(session)
    const win = Number(session.match(/^ghostty-(\d+)$/)?.[1] ?? seen?.win ?? 0)
    const looked = active === '1' && Number(attached) > 0 && !(own && hub.has(win))
    if (!seen || own)
      map.set(pane, {
        pane,
        session: own ? session : seen?.session ?? session,
        win,
        window,
        tab: Number(index),
        pid: Number(pid),
        looked: looked || Boolean(seen?.looked),
      })
    else if (looked) seen.looked = true
  }
  return map
}

// Tab glyphs: one tmux call per change, setting @agent and @agent_fg on the
// windows whose agent changed and clearing them where the agent left. The
// marks tmux has now come with the panes, rather than from memory, so a mark
// that something else cleared (a tab server that restarted and reused window
// ids) is put back.
const RANK = { needs: 0, working: 1, done: 2, idle: 3 }

async function markTabs(agents, marked = new Map()) {
  const want = new Map()
  for (const a of agents) {
    if (!a.pane) continue
    const look = a.monitor && a.state !== 'needs' ? MONITOR.watching : STATE[a.state]
    const prev = want.get(a.pane.window)
    if (!prev || RANK[a.state] < prev.rank) want.set(a.pane.window, { rank: RANK[a.state], value: `${look.glyph} ${look.color}` })
  }
  const args = []
  for (const [win, { value }] of want) {
    if (marked.get(win) === value) continue
    const [glyph, color] = value.split(' ')
    args.push('set', '-w', '-t', win, '@agent', glyph, ';', 'set', '-w', '-t', win, '@agent_fg', color, ';')
  }
  for (const win of marked.keys()) {
    if (!want.has(win)) args.push('set', '-wu', '-t', win, '@agent', ';', 'set', '-wu', '-t', win, '@agent_fg', ';')
  }
  if (args.length) await exec('tmux', ['-L', TABS_SOCKET, ...args.slice(0, -1)])
}

// Pane ids repeat across tmux servers, so a session's pane only counts when
// the session's own tmux names this server's session and window, and Claude
// runs under the pane's process. A tab opened or started from the hub's
// open session names that session's peek-N group (Claude records whichever
// session the pane was in), which shares the tab session's windows, so it
// counts too, even after the peek is gone.
function paneOf(s, panes) {
  const m = String(s.tmux ?? '').match(/^([^:]+):(@\d+)\.(%\d+)$/)
  const p = m && panes.get(m[3])
  if (!p || (p.session !== m[1] && !/^peek-\d+$/.test(m[1])) || p.window !== m[2]) return null
  let pid = s.pid
  for (let i = 0; i < 16 && pid > 1; i++) {
    if (pid === p.pid) return p
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    } catch {
      return null
    }
  }
  return null
}

// ------------------------------------------------------------ monitors

// Whether a monitor's command still runs, from every process's command line.
let procs = null
let procsAt = 0

function scanProcs() {
  const list = []
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        list.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim())
      } catch {}
    }
  } catch {
    return null
  }
  return list
}

const coreOf = cmd => String(cmd).replace(/\s*(2>&1|\|.*)\s*$/, '').trim()

function alive(cmd) {
  if (!procs) return null
  const core = coreOf(cmd)
  return core ? procs.some(p => p.includes(core)) : null
}

// ------------------------------------------------------------ reviews

// When you last saw each session's result: a file per session in reviewed/,
// touched by the hub, and by this loop while a session's tab is in front.
function reviews() {
  const map = new Map()
  try {
    for (const id of readdirSync(join(RUN, 'reviewed'))) {
      try {
        map.set(id, statSync(join(RUN, 'reviewed', id)).mtimeMs)
      } catch {}
    }
  } catch {}
  return map
}

function review(id) {
  try {
    writeFileSync(join(RUN, 'reviewed', id), '')
  } catch {}
}

// ------------------------------------------------------------ loop

let last = ''
let lastPanes = new Map()
let lonelySince = 0

function clientsAlive() {
  try {
    return readdirSync(join(RUN, 'clients')).some(pid => {
      if (alivePid(Number(pid))) return true
      try {
        unlinkSync(join(RUN, 'clients', pid))
      } catch {}
      return false
    })
  } catch {
    return false
  }
}

async function tick() {
  const now = Date.now()
  const list = sessions()
  const pane = await panes()
  lastPanes = pane
  const seen = reviews()
  const agents = []
  const live = new Set()
  for (const s of list) {
    live.add(s.sessionId)
    const t = transcript(s)
    const p = paneOf(s, pane)
    if (p?.looked) {
      review(s.sessionId)
      seen.set(s.sessionId, now)
    }
    agents.push(classify({ session: s, t, pane: p, reviewedAt: seen.get(s.sessionId) ?? 0, alive, now }))
  }
  for (const id of transcripts.keys()) if (!live.has(id)) transcripts.delete(id)
  const wantsProcs = agents.some(a => a.monitors.some(m => !m.ended))
  if (wantsProcs && now - procsAt > PROC_SCAN_MS) {
    procs = scanProcs()
    procsAt = now
  } else if (!wantsProcs) procs = null
  return agents
}

function write(agents) {
  const body = JSON.stringify(agents)
  if (body === last) return
  last = body
  const tmp = join(RUN, `state.json.${process.pid}`)
  writeFileSync(tmp, JSON.stringify({ at: Date.now(), agents }))
  renameSync(tmp, join(RUN, 'state.json'))
}

async function main() {
  if (ONCE) {
    procs = scanProcs()
    process.stdout.write(`${JSON.stringify(await tick(), null, 2)}\n`)
    return
  }
  if (!claim()) return
  process.on('exit', release)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0))
  for (;;) {
    try {
      const agents = await tick()
      write(agents)
      await markTabs(agents, lastPanes.marks)
    } catch (err) {
      process.stderr.write(`agentd: ${err?.stack ?? err}\n`)
    }
    if (clientsAlive()) lonelySince = 0
    else if (!lonelySince) lonelySince = Date.now()
    else if (Date.now() - lonelySince > IDLE_EXIT_MS) break
    await new Promise(r => setTimeout(r, TICK_MS))
  }
  // Nothing keeps the glyphs current from here on, so they go.
  await markTabs([], (await panes()).marks)
}

await main()
