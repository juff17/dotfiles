// What agentd decides, kept apart from its loop so it can be tested: reading
// session files and transcripts, parsing tmux's pane list, matching a
// session to its pane, the tab-glyph commands, monitor liveness, and the
// singleton and client bookkeeping under RUN. Nothing here runs on import;
// the paths and process lookups it needs are passed in.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addEntry, emptyTranscript } from './model.mjs'
import { STATE, MONITOR } from './term.mjs'

// ------------------------------------------------------------ /proc

// The fields after a /proc/<pid>/stat's command name, which can hold spaces
// and parens, so it's cut at the last ')'. Index 1 is the parent pid, 19 the
// start time (fields 4 and 22 of the whole line).
const statFields = stat => stat.slice(stat.lastIndexOf(')') + 2).split(' ')
export const procStart = stat => statFields(stat)[19]
export const parentPid = stat => Number(statFields(stat)[1])

const readStat = pid => readFileSync(`/proc/${pid}/stat`, 'utf8')

// ------------------------------------------------------------ singleton

// Takes the pid file for `pid`, or reports that a live copy holds it.
export function claim(pidFile, pid, alivePid) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(pidFile, 'wx')
      writeFileSync(fd, String(pid))
      closeSync(fd)
      return true
    } catch {
      let held = 0
      let age = Infinity
      try {
        held = Number(readFileSync(pidFile, 'utf8')) || 0
        age = Date.now() - statSync(pidFile).mtimeMs
      } catch {}
      if (alivePid(held)) return false
      // Empty and new: another copy is between creating it and writing to it.
      if (!held && age < 2000) return false
      try {
        unlinkSync(pidFile)
      } catch {}
    }
  }
  return false
}

export function release(pidFile, pid) {
  try {
    if (Number(readFileSync(pidFile, 'utf8')) === pid) unlinkSync(pidFile)
  } catch {}
}

// ------------------------------------------------------------ sessions

// The live Claude processes. A session file outlives a crashed process, and
// a pid can be reused, so the process must still be the one that wrote it.
export function sessions(dir, stat = readStat) {
  let names = []
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch {
    return []
  }
  const list = []
  for (const name of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (!s.sessionId || !s.pid) continue
      const start = procStart(stat(s.pid))
      if (s.procStart && String(s.procStart) !== start) continue
      list.push(s)
    } catch {}
  }
  return list
}

// ------------------------------------------------------------ transcripts

export function findTranscript(projects, s) {
  const guess = join(projects, s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`)
  if (existsSync(guess)) return guess
  try {
    for (const dir of readdirSync(projects)) {
      const p = join(projects, dir, `${s.sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {}
  return null
}

// Reads each session's transcript, only what was appended since last time.
// `chunk` is the read size, a parameter so tests can make lines straddle reads.
export function transcriptReader(projects, chunk = 1 << 20) {
  const transcripts = new Map() // session id -> { path, offset, rest (bytes), t, subs }
  const read = s => {
    let tr = transcripts.get(s.sessionId)
    if (!tr) {
      const path = findTranscript(projects, s)
      if (!path) return emptyTranscript()
      tr = { path, offset: 0, rest: Buffer.alloc(0), t: emptyTranscript(), subs: new Map() }
      transcripts.set(s.sessionId, tr)
    }
    return tail(tr)
  }
  // A background subagent (Agent with run_in_background) asks for permission
  // in its own transcript, subagents/agent-<id>.jsonl beside the session's,
  // while the session's own turn may have ended long ago. So a waiting
  // session also reads the subagents that haven't finished; their .meta.json
  // says which those are. agentd reads them only while the session waits,
  // but they're kept, so the next wait reads just what was added. Call after
  // read(s).
  const subagents = s => {
    const tr = transcripts.get(s.sessionId)
    if (!tr) return []
    const dir = join(tr.path.replace(/\.jsonl$/, ''), 'subagents')
    let files = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    } catch {
      return []
    }
    const out = []
    for (const f of files) {
      const path = join(dir, f)
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
      } catch {}
      if (meta.finished) {
        tr.subs.delete(f)
        continue
      }
      let sub = tr.subs.get(f)
      if (!sub) {
        sub = { path, offset: 0, rest: Buffer.alloc(0), t: emptyTranscript() }
        tr.subs.set(f, sub)
      }
      out.push({ description: meta.description ?? '', t: tail(sub) })
    }
    return out
  }
  const tail = tr => {
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
      const buf = Buffer.alloc(chunk)
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
  // Forgets the sessions that are gone, so a new one with a reused id starts over.
  const keep = live => {
    for (const id of transcripts.keys()) if (!live.has(id)) transcripts.delete(id)
  }
  return { read, subagents, keep, cached: () => [...transcripts.keys()] }
}

// Lines that can't matter (the request snapshots, which are most of the file)
// skip JSON parsing.
export function readLines(t, text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('{"type":"api-request')) continue
    if (
      !line.includes('"type":"assistant"') &&
      !line.includes('"type":"user"') &&
      !line.includes('"queue-operation"') &&
      !line.includes('-title"') &&
      !line.includes('"type":"agent-name"')
    )
      continue
    try {
      addEntry(t, JSON.parse(line))
    } catch {}
  }
}

// ------------------------------------------------------------ tmux

export const PANE_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_active}\t#{session_attached}\t#{@agent} #{@agent_fg}\t#{pane_pid}'
export const HUB_SHOWN_FORMAT = '#{session_name} #{window_name} #{window_active}'

// The Ghostty windows showing their hub, or the diagrams window, rather than
// their workspace: a tab in front of one of those isn't being looked at.
export function parseHubShown(text) {
  const wins = new Set()
  for (const line of (text ?? '').split('\n')) {
    const [session, name, active] = line.split(' ')
    if ((name === 'hub' || name === 'diagrams') && active === '1') wins.add(Number(session.replace(/^layout-/, '')))
  }
  return wins
}

export const sessionRank = name => (/^ghostty-\d+$/.test(name) ? 2 : /^hubtabs-\d+$/.test(name) ? 1 : 0)

// `text` is list-panes in PANE_FORMAT, `hub` the windows parseHubShown found.
export function parsePanes(text, hub) {
  const map = new Map()
  map.marks = new Map() // window id -> its glyph and color as tmux has them now
  for (const line of (text ?? '').split('\n')) {
    const [pane, session, window, index, active, attached, mark, pid] = line.split('\t')
    if (!pane) continue
    if (mark?.trim()) map.marks.set(window, mark)
    const seen = map.get(pane)
    // A tab shows in up to three sessions: the workspace's (ghostty-N), the
    // hub's tab session (hubtabs-N), which links in the workspace tabs
    // running Claude and keeps the tabs opened from the hub, and the peek session grouped with
    // that. The pane belongs to the first of those it's in; a tab only the
    // hub has is `hub`.
    const rank = sessionRank(session)
    const win = Number(session.match(/^(?:ghostty|hubtabs)-(\d+)$/)?.[1] ?? seen?.win ?? 0)
    const looked = active === '1' && Number(attached) > 0 && !(rank === 2 && hub.has(win))
    if (!seen || rank > sessionRank(seen.session))
      map.set(pane, {
        pane,
        session,
        win,
        window,
        tab: Number(index),
        pid: Number(pid),
        hub: rank === 1,
        looked: looked || Boolean(seen?.looked),
      })
    else if (looked) seen.looked = true
  }
  return map
}

// Tab glyphs: the tmux arguments that set @agent and @agent_fg on the windows
// whose agent changed and clear them where the agent left, or [] when nothing
// changed. `marked` is what tmux has now (parsePanes' marks), rather than
// memory, so a mark that something else cleared (a tab server that restarted
// and reused window ids) is put back. A window with several agents shows the
// most urgent.
const RANK = { needs: 0, working: 1, done: 2, idle: 3 }

export function tabMarkArgs(agents, marked = new Map()) {
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
  return args.slice(0, -1)
}

// The hub's tab session, hubtabs-N, holds the hub's own tabs and only those
// workspace tabs (ghostty-N) that run Claude, so a plain shell, such as the
// tab the window opened with, stays out of the hub, where closing it would
// close the window. These are the tmux arguments that link a workspace tab in
// once Claude runs there and unlink it once Claude has been gone for
// HUB_UNLINK_MS, so a session file caught mid-write doesn't drop it for a
// tick. A tab in front of an attached hub session (peek-N) stays until you
// leave it, so the session you're in doesn't jump away when Claude exits. A
// window with no hubtabs session yet is left to hub_tabs (ghostty-lib.sh).
// Links come first: unlinking a session's last tab ends the session.
// `text` is list-panes in PANE_FORMAT, `claude` the windows Claude runs in
// now, and `seen` maps each window to when Claude last ran there; it's
// updated in place.
export const HUB_UNLINK_MS = 3000

export function hubLinkArgs(text, claude, seen, now = Date.now()) {
  // No pane list (tmux failed) says nothing about which tabs closed.
  if (text == null) return []
  const work = new Map() // N -> its workspace windows
  const hub = new Map() // N -> the windows hubtabs-N has
  const shown = new Set()
  for (const line of (text ?? '').split('\n')) {
    const [, session, window, , active, attached] = line.split('\t')
    if (!window) continue
    const [, kind, n] = /^(ghostty|hubtabs)-(\d+)$/.exec(session) ?? []
    if (kind) {
      const map = kind === 'ghostty' ? work : hub
      if (!map.has(n)) map.set(n, new Set())
      map.get(n).add(window)
    } else if (/^peek-\d+$/.test(session) && active === '1' && Number(attached) > 0) shown.add(window)
  }
  for (const w of claude) seen.set(w, now)
  const links = []
  const unlinks = []
  for (const [n, tabs] of work) {
    const own = hub.get(n)
    if (!own) continue
    for (const w of tabs) {
      if (claude.has(w)) {
        if (!own.has(w)) links.push('link-window', '-d', '-s', w, '-t', `=hubtabs-${n}:`, ';')
      } else if (own.has(w) && !shown.has(w) && now - (seen.get(w) ?? -Infinity) > HUB_UNLINK_MS)
        unlinks.push('unlink-window', '-t', `=hubtabs-${n}:${w}`, ';')
    }
  }
  const open = new Set([...work.values()].flatMap(tabs => [...tabs]))
  for (const w of seen.keys()) if (!open.has(w)) seen.delete(w)
  return [...links, ...unlinks].slice(0, -1)
}

// Pane ids repeat across tmux servers, so a session's pane only counts when
// the session's own tmux names this server's session and window, and Claude
// runs under the pane's process. Claude records whichever session the pane
// was in when it started: a tab opened in the hub's open session names that
// peek-N, one New agent opened names hubtabs-N, and a workspace tab Claude
// started in while the hub showed it can name either. They all hold the tab
// session's windows as well as the hub's own, so they count too, even after
// the peek is gone.
export function paneOf(s, panes, parent = pid => parentPid(readStat(pid))) {
  const m = String(s.tmux ?? '').match(/^([^:]+):(@\d+)\.(%\d+)$/)
  const p = m && panes.get(m[3])
  if (!p || (p.session !== m[1] && !/^(?:peek|hubtabs)-\d+$/.test(m[1])) || p.window !== m[2]) return null
  let pid = s.pid
  for (let i = 0; i < 16 && pid > 1; i++) {
    if (pid === p.pid) return p
    try {
      pid = parent(pid)
    } catch {
      return null
    }
  }
  return null
}

// ------------------------------------------------------------ monitors

// Every process's command line, for telling whether a monitor still runs.
export function scanProcs(dir = '/proc') {
  const list = []
  try {
    for (const pid of readdirSync(dir)) {
      if (!/^\d+$/.test(pid)) continue
      try {
        list.push(readFileSync(join(dir, pid, 'cmdline'), 'utf8').replaceAll('\0', ' ').trim())
      } catch {}
    }
  } catch {
    return null
  }
  return list
}

// A monitor's command without the redirect or pipe its tool added, which the
// process's own command line doesn't have.
export const coreOf = cmd => String(cmd).replace(/\s*(2>&1|\|.*)\s*$/, '').trim()

// null when it can't tell: no process scan, or nothing left to look for.
export function aliveIn(procs, cmd) {
  if (!procs) return null
  const core = coreOf(cmd)
  return core ? procs.some(p => p.includes(core)) : null
}

// ------------------------------------------------------------ reviews

// When you last saw each session's result: a file per session in reviewed/,
// touched by the hub, and by agentd while a session's tab is in front.
export function reviews(dir) {
  const map = new Map()
  try {
    for (const id of readdirSync(dir)) {
      try {
        map.set(id, statSync(join(dir, id)).mtimeMs)
      } catch {}
    }
  } catch {}
  return map
}

export function review(dir, id) {
  try {
    writeFileSync(join(dir, id), '')
  } catch {}
}

// The monitors the hub stopped, by session: files <session id>.<task id> in
// stopped/, written by the hub (client.mjs).
export function stoppedTasks(dir) {
  const map = new Map()
  try {
    for (const name of readdirSync(dir)) {
      const [session, task] = name.split('.')
      if (!task) continue
      if (!map.has(session)) map.set(session, new Set())
      map.get(session).add(task)
    }
  } catch {}
  return map
}

// ------------------------------------------------------------ clients

// A client is a process, named by its pid in clients/, or the tray widget,
// which can't stay registered as a process: it touches clients/tray each
// time it asks for a snapshot (tray.mjs), so a fresh file counts. A dead
// pid's file is removed.
export const TRAY_FRESH_MS = 15000

export function clientsAlive(dir, alivePid, now = Date.now()) {
  try {
    return readdirSync(dir).some(pid => {
      if (!/^\d+$/.test(pid)) {
        try {
          return now - statSync(join(dir, pid)).mtimeMs < TRAY_FRESH_MS
        } catch {
          return false
        }
      }
      if (alivePid(Number(pid))) return true
      try {
        unlinkSync(join(dir, pid))
      } catch {}
      return false
    })
  } catch {
    return false
  }
}
