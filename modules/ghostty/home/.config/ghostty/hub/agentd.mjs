#!/usr/bin/env node
// agentd: the one process that watches every Claude session, so a rail in
// each window and a hub in each window cost no more than one. Once a second
// it reads Claude's session files, the new lines of their transcripts and the
// tab server's panes, and writes what it found to state.json, which the hub
// and the rails read (client.mjs). It also marks each agent's tmux tab with
// its state's glyph (tmux.conf draws it).
// It runs while a hub, a rail or the tray widget does: they register in
// clients/, and it exits once none is left. A second copy exits at once, so starting it is safe.
//   agentd.mjs [--once]   --once prints one state to stdout and exits

import { execFile } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { classify, pairParked } from './model.mjs'
import { RUN, alivePid } from './client.mjs'
import {
  HUB_SHOWN_FORMAT,
  PANE_FORMAT,
  aliveIn,
  claim,
  clientsAlive,
  paneOf,
  parseHubShown,
  parsePanes,
  release,
  review,
  reviews,
  scanProcs,
  sessions,
  stoppedTasks,
  tabMarkArgs,
  transcriptReader,
} from './daemon.mjs'

const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const SESSIONS = join(CLAUDE, 'sessions')
const PROJECTS = join(CLAUDE, 'projects')
const TABS_SOCKET = process.env.AGENT_HUB_TABS_SOCKET || 'ghostty'
const LAYOUT_SOCKET = process.env.GHOSTTY_LAYOUT_SOCKET || 'ghostty-layout'
const TICK_MS = 1000
const PROC_SCAN_MS = 5000
const IDLE_EXIT_MS = 15000
const ONCE = process.argv.includes('--once')

const PID_FILE = join(RUN, 'agentd.pid')
const CLIENTS = join(RUN, 'clients')
const REVIEWED = join(RUN, 'reviewed')
const STOPPED = join(RUN, 'stopped')

const exec = (cmd, args) =>
  new Promise(resolve =>
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)),
  )

const transcripts = transcriptReader(PROJECTS)

async function panes() {
  const [text, hub] = await Promise.all([
    exec('tmux', ['-L', TABS_SOCKET, 'list-panes', '-a', '-F', PANE_FORMAT]),
    exec('tmux', ['-L', LAYOUT_SOCKET, 'list-windows', '-a', '-F', HUB_SHOWN_FORMAT]),
  ])
  return parsePanes(text, parseHubShown(hub))
}

async function markTabs(agents, marked) {
  const args = tabMarkArgs(agents, marked)
  if (args.length) await exec('tmux', ['-L', TABS_SOCKET, ...args])
}

// Whether a monitor's command still runs, from a process scan at most every PROC_SCAN_MS.
let procs = null
let procsAt = 0
const alive = cmd => aliveIn(procs, cmd)

// ------------------------------------------------------------ loop

let last = ''
let lastPanes = new Map()
let lonelySince = 0

async function tick() {
  const now = Date.now()
  const list = sessions(SESSIONS)
  const pane = await panes()
  lastPanes = pane
  const seen = reviews(REVIEWED)
  const stopped = stoppedTasks(STOPPED)
  const agents = []
  const live = new Set()
  for (const { session: s, viewer } of pairParked(list)) {
    live.add(s.sessionId)
    const t = transcripts.read(s)
    const p = paneOf(viewer ?? s, pane)
    if (p?.looked) {
      review(REVIEWED, s.sessionId)
      seen.set(s.sessionId, now)
    }
    agents.push(classify({ session: s, t, pane: p, reviewedAt: seen.get(s.sessionId) ?? 0, alive, stopped: stopped.get(s.sessionId), now }))
  }
  transcripts.keep(live)
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
  for (const dir of [CLIENTS, REVIEWED, STOPPED]) mkdirSync(dir, { recursive: true })
  if (!claim(PID_FILE, process.pid, alivePid)) return
  process.on('exit', () => release(PID_FILE, process.pid))
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0))
  for (;;) {
    try {
      const agents = await tick()
      write(agents)
      await markTabs(agents, lastPanes.marks)
    } catch (err) {
      process.stderr.write(`agentd: ${err?.stack ?? err}\n`)
    }
    if (clientsAlive(CLIENTS, alivePid)) lonelySince = 0
    else if (!lonelySince) lonelySince = Date.now()
    else if (Date.now() - lonelySince > IDLE_EXIT_MS) break
    await new Promise(r => setTimeout(r, TICK_MS))
  }
  // Nothing keeps the glyphs current from here on, so they go.
  await markTabs([], (await panes()).marks)
}

await main()
