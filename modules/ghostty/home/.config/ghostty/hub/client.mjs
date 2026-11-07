// The hub's and the rail's side of agentd: start it if it isn't running,
// stay registered so it keeps running, and follow state.json.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RUN = join(process.env.XDG_RUNTIME_DIR || '/tmp', 'agent-hub')
const HERE = dirname(fileURLToPath(import.meta.url))

export function alivePid(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function ensureDaemon() {
  let pid = 0
  try {
    pid = Number(readFileSync(join(RUN, 'agentd.pid'), 'utf8'))
  } catch {}
  if (alivePid(pid)) return
  spawn(process.execPath, [join(HERE, 'agentd.mjs')], { detached: true, stdio: 'ignore' }).unref()
}

export function readState() {
  try {
    return JSON.parse(readFileSync(join(RUN, 'state.json'), 'utf8'))
  } catch {
    return null
  }
}

// Calls onState with each new state, and checks every few seconds that
// agentd still runs (it exits when it finds no clients for a while, and a
// client can outlive a crash of it).
export function follow(onState) {
  mkdirSync(join(RUN, 'clients'), { recursive: true })
  const me = join(RUN, 'clients', String(process.pid))
  writeFileSync(me, '')
  process.on('exit', () => {
    try {
      unlinkSync(me)
    } catch {}
  })
  ensureDaemon()
  let at = 0
  const check = () => {
    const s = readState()
    if (s && s.at !== at) {
      at = s.at
      onState(s)
    }
  }
  try {
    watch(RUN, (_, name) => name === 'state.json' && check())
  } catch {}
  setInterval(() => {
    writeFileSync(me, '')
    ensureDaemon()
    check()
  }, 3000)
  check()
}

// A monitor the hub stopped, as <session id>.<task id> in stopped/, so it
// leaves the board at once rather than lingering as ended.
export function markStopped(sessionId, task) {
  try {
    mkdirSync(join(RUN, 'stopped'), { recursive: true })
    writeFileSync(join(RUN, 'stopped', `${sessionId}.${task}`), '')
  } catch {}
}

export function markReviewed(id) {
  try {
    mkdirSync(join(RUN, 'reviewed'), { recursive: true })
    writeFileSync(join(RUN, 'reviewed', id), '')
  } catch {}
}
