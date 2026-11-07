#!/usr/bin/env node
// The tray's view of agentd: what the panel widget counts and its inbox
// lists, in five sections, as JSON.
//   ▲ you     a permission prompt, a question, a session waiting on input,
//             or a monitor event you have to act on (manual job, auth)
//   ✗ broke   a monitor that saw a failure (pipeline failed, crash, stuck)
//   ✻ work    task agents working
//   ◉ watch   monitors watching, or gone quiet
//   ✓ done    finished and not yet looked at
// An item is new until `seen` records it, which is how the widget keeps its
// ring until you open the inbox.
//   tray.mjs snapshot   print the items once; keeps agentd running
//   tray.mjs seen       mark every current item as seen
//   tray.mjs watch      print a snapshot on every change, for testing

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUN, alivePid, follow, readState } from './client.mjs'
import { lanes, monitorsOf } from './model.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEEN = join(RUN, 'tray-seen.json')
// The client file the widget keeps fresh by asking for snapshots; agentd
// counts it while it was touched in the last few seconds (agentd.mjs).
export const TRAY_CLIENT = 'tray'

// Monitor event tags that mean something broke, rather than something to do.
const BROKE = new Set(['failed', 'stuck', 'conflict', 'conflicts', 'error', 'crash'])

const where = a => (a.pane ? `tab ${a.pane.tab}` : a.kind === 'bg' ? 'background' : 'terminal')
const place = a => (a.worktree ? `${a.repo} ⑂ ${a.worktree}` : a.repo)

// One inbox row. `actions` are what its buttons do; the first is the usual
// answer. `id` stays the same while the row is about the same thing, so the
// widget can tell new rows from ones it has shown.
const row = (section, glyph, id, agent, title, meta, since, actions) => ({ section, glyph, id, agent: agent.id, title, meta, since, actions })

export function trayItems(agents, seen = new Set()) {
  const l = lanes(agents)
  const items = []
  for (const a of l.needs) {
    const raised = a.need === 'monitor' ? a.monitors.find(m => m.state === 'action') : null
    if (raised) {
      const broke = BROKE.has(raised.event?.tag)
      items.push(
        row(broke ? 'broke' : 'you', broke ? '✗' : '▲', `m:${raised.key}:${raised.event?.at ?? 0}`, a, a.cmd, `${place(a)} · ${raised.description}`, a.since, ['go']),
      )
    } else if (a.need === 'permission')
      items.push(row('you', '▲', `p:${a.id}:${a.since}`, a, a.cmd, `${place(a)} · ${where(a)}`, a.since, ['allow', 'deny', 'go']))
    else if (a.need === 'question') items.push(row('you', '?', `q:${a.id}:${a.since}`, a, a.cmd, `${place(a)} · ${where(a)}`, a.since, ['go']))
    else items.push(row('you', '▲', `i:${a.id}:${a.since}`, a, a.cmd, `${place(a)} · ${where(a)}`, a.since, ['go']))
  }
  for (const a of l.working) items.push(row('work', '✻', `w:${a.id}`, a, a.title, `${place(a)} · ${a.cmd}`, a.stateSince, ['go']))
  for (const m of monitorsOf(agents)) {
    if (m.state === 'action' || m.state === 'ended') continue
    const glyph = m.state === 'stale' ? '◌' : '◉'
    const title = m.event?.line ?? m.description
    const meta = `${place(m.agent)} · ${m.description}${m.state === 'stale' ? ' · gone quiet' : ''}`
    items.push(row('watch', glyph, `m:${m.key}:${m.event?.at ?? 0}`, m.agent, title, meta, m.event?.at ?? m.startedAt, ['go']))
  }
  for (const a of l.done) items.push(row('done', '✓', `d:${a.id}:${a.since}`, a, a.title, `${place(a)} · ${a.cmd}`, a.since, ['go']))
  for (const it of items) it.new = it.section !== 'work' && !seen.has(it.id)
  const count = s => items.filter(it => it.section === s).length
  return {
    counts: { you: count('you'), broke: count('broke'), work: count('work'), watch: count('watch'), done: count('done') },
    // The ring: anything new but work. The flash: something new that needs you.
    unseen: items.some(it => it.new),
    alert: items.some(it => it.new && (it.section === 'you' || it.section === 'broke')),
    items,
  }
}

function readSeen() {
  try {
    return new Set(JSON.parse(readFileSync(SEEN, 'utf8')))
  } catch {
    return new Set()
  }
}

// Keeps agentd running while the widget asks, and starts it when it isn't.
function keepAlive() {
  mkdirSync(join(RUN, 'clients'), { recursive: true })
  const me = join(RUN, 'clients', TRAY_CLIENT)
  writeFileSync(me, '')
  const now = new Date()
  utimesSync(me, now, now)
  let pid = 0
  try {
    pid = Number(readFileSync(join(RUN, 'agentd.pid'), 'utf8'))
  } catch {}
  if (!alivePid(pid)) spawn(process.execPath, [join(HERE, 'agentd.mjs')], { detached: true, stdio: 'ignore' }).unref()
}

const snapshot = state => ({ at: state?.at ?? 0, ...trayItems(state?.agents ?? [], readSeen()) })

const cmd = process.argv[2]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (cmd === 'snapshot') {
    keepAlive()
    process.stdout.write(`${JSON.stringify(snapshot(readState()))}\n`)
  } else if (cmd === 'seen') {
    const ids = trayItems(readState()?.agents ?? []).items.map(it => it.id)
    mkdirSync(RUN, { recursive: true })
    writeFileSync(SEEN, JSON.stringify(ids))
  } else if (cmd === 'watch') {
    follow(state => process.stdout.write(`${JSON.stringify(snapshot(state), null, 2)}\n`))
  } else {
    process.stderr.write('tray.mjs snapshot | seen | watch\n')
    process.exit(1)
  }
}
