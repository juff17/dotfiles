#!/usr/bin/env node
// The tray's view of agentd: what the panel widget counts and its inbox
// lists, in five sections, as JSON.
//   ▲ you     a permission prompt, a question, a session waiting on input,
//             or a monitor event you have to act on (manual job, auth)
//   ✗ broke   a monitor that saw a failure (pipeline failed, crash, stuck)
//   ✻ work    task agents working
//   ◉ watch   monitors watching, or gone quiet
//   ✓ done    finished and not yet looked at
// A session can also post a note for something only it knows needs you (a
// fix ready to push, a finished rebase): pr-babysit's notify.sh writes one
// JSON file per note to notes/ ({ title, message, session, pane, at }). A note
// is a ▲ row until you go to it or dismiss it, and is dropped after a day
// (Settings' tray.noteHours).
// A babysitter's proposals (pr-babysit's approval.py: a reply, a push, a job
// to retry or run) are rows of their own, whose buttons approve, skip or
// open them in the Alt+A popup (bin/ghostty-approvals).
// An item is new until `seen` records it, which is how the widget keeps its
// ring until you open the inbox.
//   tray.mjs snapshot           print the items once; keeps agentd running
//   tray.mjs seen               mark every current item as seen
//   tray.mjs act <action> <id>  allow, deny, go, dismiss, or an approval's
//                              post, push, run, retry, skip, edit, review; prints the result
//   tray.mjs hub                show the hub; prints the result
//   tray.mjs watch              print a snapshot on every change, for testing

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUN, alivePid, follow, markReviewed, readState } from './client.mjs'
import { brokeTags, lanes, monitorsOf } from './model.mjs'
import { load as settings } from './settings.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEEN = join(RUN, 'tray-seen.json')
const DISMISSED = join(RUN, 'tray-dismissed.json')
const NOTES = join(RUN, 'notes')
// The file the hub reads when asked to open an agent (hub.mjs OPEN_AGENT_KEY).
export const HUB_OPEN = join(RUN, 'hub-open')
const OPEN_AGENT_KEY = '\x1b[9102~'
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const TABS = ['-L', process.env.AGENT_HUB_TABS_SOCKET || 'ghostty']
const LAYOUT = ['-L', process.env.GHOSTTY_LAYOUT_SOCKET || 'ghostty-layout']
// The client file the widget keeps fresh by asking for snapshots; agentd
// counts it while it was touched in the last few seconds (agentd.mjs).
export const TRAY_CLIENT = 'tray'

const where = a => (a.pane ? `${a.pane.hub ? 'hub tab' : 'tab'} ${a.pane.tab}` : a.kind === 'bg' ? 'background' : 'terminal')
const place = a => (a.worktree ? `${a.repo} ⑂ ${a.worktree}` : a.repo)
// Where a prompt is, and the subagent asking when it isn't the session.
const asker = a => [place(a), where(a), a.via && `agent: ${a.via}`].filter(Boolean).join(' · ')

// One inbox row. `actions` are what its buttons do; the first is the usual
// answer. `id` stays the same while the row is about the same thing, so the
// widget can tell new rows from ones it has shown.
const row = (section, glyph, id, agent, title, meta, since, actions) => ({ section, glyph, id, agent: agent?.id ?? '', title, meta, since, actions })

// ------------------------------------------------------------ approvals

// What a babysitter proposed and waits on (pr-babysit's approval.py): one
// JSON file each, pending until approved or rejected; a failed one stays
// until it's tried again, proposed again or dismissed.
export const APPROVALS = join(RUN, 'approvals')

export function readApprovals(dir = APPROVALS) {
  let files = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const f of files.sort()) {
    try {
      const p = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (p.status === 'pending' || p.status === 'failed') out.push(p)
    } catch {}
  }
  return out
}

// The action that approves each kind, as its button says it.
export const APPROVE = { reply: 'post', push: 'push', manual: 'run', deploy: 'approve', retry: 'retry', move: 'move' }
const APPROVE_ACTIONS = new Set([...Object.values(APPROVE), 'again'])
const GLYPH = { reply: '↩', push: '↑', manual: '▶', deploy: '▶', retry: '✗', move: '⇅' }
// The longest reply the inbox's three-line preview shows whole.
export const PREVIEW_MOST = 200

const sessionOf = (p, agents) =>
  agents.find(x => p.claude_session && x.id === p.claude_session) ?? agents.find(x => p.pane && x.pane?.pane === p.pane)

// One proposal as an inbox row. With Settings' buttons off, a row only
// opens the popup or the session.
export function approvalRow(p, agents, buttons = true) {
  const a = sessionOf(p, agents)
  const where = `${p.pr?.repo ?? ''} ${p.pr?.ref ?? ''}`.trim()
  const base = { kind: p.kind, approval: p.id }
  if (p.status === 'failed')
    return {
      ...row('broke', '✗', `af:${p.id}`, a, `${p.title} failed`, `${where} · ${p.result?.message ?? ''}`, p.result?.at ?? p.at, [
        ...(buttons ? ['again'] : []),
        'go',
        'dismiss',
      ]),
      ...base,
    }
  const added = (p.commits ?? []).reduce((n, c) => n + (c.added ?? 0), 0)
  const removed = (p.commits ?? []).reduce((n, c) => n + (c.removed ?? 0), 0)
  const job = p.job ?? {}
  const detail = {
    reply: ['babysit · reply'],
    push: [`${p.local} → ${p.branch}`, `+${added} −${removed}`],
    manual: [job.stage ? `${job.stage} stage` : 'manual job'],
    deploy: ['deployment'],
    retry: [job.reason || 'looks flaky'],
    move: [`onto ${String(p.onto ?? '').slice(0, 7)}`],
  }[p.kind] ?? []
  const title = p.kind === 'retry' ? `${job.name} failed, looks flaky` : p.title
  if (p.removes?.length) detail.push(`replaces ${p.removes.length} on the remote`)
  // The tray approves only what it shows whole: a reply short enough for its
  // preview, and a push that takes nothing off the branch. Anything else
  // opens in Alt+A first.
  const whole = p.kind !== 'reply' || (String(p.body ?? '').length <= PREVIEW_MOST && !/\n/.test(p.body ?? ''))
  const actions = !buttons
    ? ['review', ...(a ? ['go'] : [])]
    : p.kind === 'reply' && !whole
      ? ['review', 'skip']
      : p.kind === 'push' && p.removes?.length
        ? ['review', 'go']
        : ({
            reply: ['post', 'edit', 'skip'],
            push: ['push', 'review', 'go'],
            retry: ['retry', 'go'],
          }[p.kind] ?? [APPROVE[p.kind], 'skip'])
  return {
    ...row(p.kind === 'retry' ? 'broke' : 'you', GLYPH[p.kind] ?? '▲', `a:${p.id}`, a, title, [where, ...detail].join(' · '), p.at, actions),
    ...base,
    preview: p.kind === 'reply' ? p.body : '',
  }
}

export function trayItems(agents, seen = new Set(), dismissed = new Set(), notes = [], approvals = []) {
  const l = lanes(agents)
  const brokeSet = brokeTags()
  const buttons = settings()['approvals.trayButtons']
  const items = approvals.map(p => approvalRow(p, agents, buttons))
  for (const a of l.needs) {
    const raised = a.need === 'monitor' ? a.monitors.find(m => m.state === 'action') : null
    if (raised) {
      const broke = brokeSet.has(raised.event?.tag)
      items.push(
        row(broke ? 'broke' : 'you', broke ? '✗' : '▲', `m:${raised.key}:${raised.event?.at ?? 0}`, a, a.cmd, `${place(a)} · ${raised.description}`, a.since, ['go']),
      )
    } else if (a.need === 'permission')
      items.push(row('you', '▲', `p:${a.id}:${a.since}`, a, a.cmd, asker(a), a.since, ['allow', 'deny', 'go']))
    else if (a.need === 'question') items.push(row('you', '?', `q:${a.id}:${a.since}`, a, a.cmd, asker(a), a.since, ['go']))
    else items.push(row('you', '▲', `i:${a.id}:${a.since}`, a, a.cmd, `${place(a)} · ${where(a)}`, a.since, ['go']))
  }
  for (const n of notes) {
    // The session that wrote it, by id, else by its tmux pane.
    const a = agents.find(x => n.session && x.id === n.session) ?? agents.find(x => n.pane && x.pane?.pane === n.pane)
    const meta = [n.title, a && place(a), a && where(a)].filter(Boolean).join(' · ')
    items.push(row('you', '▲', `n:${n.file}`, a, n.message, meta, n.at, a ? ['go', 'dismiss'] : ['dismiss']))
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
  const shown = items.filter(it => !dismissed.has(it.id))
  items.length = 0
  items.push(...shown)
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

// The notes still due, oldest first; ones older than a day are removed.
export function readNotes(now = Date.now()) {
  let files = []
  try {
    files = readdirSync(NOTES).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const notes = []
  for (const file of files.sort()) {
    try {
      const n = JSON.parse(readFileSync(join(NOTES, file), 'utf8'))
      if (now - (Number(n.at) || 0) > settings()['tray.noteHours'] * 60 * 60 * 1000) unlinkSync(join(NOTES, file))
      else notes.push({ ...n, file: file.replace(/\.json$/, ''), at: Number(n.at) || 0 })
    } catch {}
  }
  return notes
}

const dropNote = item => {
  try {
    if (item.id.startsWith('n:')) unlinkSync(join(NOTES, `${item.id.slice(2)}.json`))
  } catch {}
}

function readSet(path) {
  try {
    return new Set(JSON.parse(readFileSync(path, 'utf8')))
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

// The widget has no settings of its own; it takes the tray's from here.
export function widgetSettings() {
  const s = settings()
  return {
    count: s['tray.count'],
    ring: s['tray.ring'],
    desktop: s['tray.desktop'],
    soundYou: s['tray.soundYou'],
    soundBroke: s['tray.soundBroke'],
    sound: s['tray.sound'],
    quiet: s['tray.quiet'],
    flashMs: s['tray.flash'] * 1000,
    foldDone: s['tray.foldDone'],
    messageMs: s['tray.messageSecs'] * 1000,
    pollMs: s['tray.pollSecs'] * 1000,
    inboxWidth: s['tray.inboxWidth'],
    inboxHeight: s['tray.inboxHeight'],
  }
}

const snapshot = state => ({
  at: state?.at ?? 0,
  ...trayItems(state?.agents ?? [], readSet(SEEN), readSet(DISMISSED), readNotes(), readApprovals()),
  settings: widgetSettings(),
})

// ------------------------------------------------------------ actions

const run = args =>
  new Promise(resolve =>
    execFile(args[0], args.slice(1), { encoding: 'utf8' }, (err, out, errOut) =>
      resolve({ ok: !err, out: out ?? '', err: (errOut || err?.message || '').trim() }),
    ),
  )

// Allow or deny a permission prompt by pressing its key in the agent's pane:
// 1 for Yes, Esc for No. As in the hub, only while Claude says it is waiting
// and the prompt's first choice is at the bottom of the screen, so a key
// never lands in Claude's input box or cancels a turn the inbox was behind on.
async function answer(a, allow) {
  if (!a.pane) return { ok: false, message: `Open ${a.title} to answer it` }
  let waiting = false
  try {
    waiting = JSON.parse(readFileSync(join(CLAUDE_DIR, 'sessions', `${a.pid}.json`), 'utf8')).status === 'waiting'
  } catch {}
  const screen = await run(['tmux', ...TABS, 'capture-pane', '-p', '-t', a.pane.pane])
  const bottom = screen.out.split('\n').filter(l => l.trim()).slice(-15).join('\n')
  if (!waiting || !/❯\s*1\.\s*Yes/.test(bottom)) return { ok: false, message: `${a.title} isn't showing a permission prompt right now` }
  const sent = await run(['tmux', ...TABS, 'send-keys', '-t', a.pane.pane, allow ? '1' : 'Escape'])
  if (!sent.ok) return { ok: false, message: `Couldn't answer: ${sent.err}` }
  return { ok: true, message: `${allow ? 'Allowed' : 'Denied'} ${a.cmd.replace(/^Allow |\?$/g, '')}` }
}

// Takes you to the agent: its live session opened in the hub, beside the
// list of the rest, as Enter on the board does. A tab agent opens in the hub
// of its own Ghostty window, through a grouped session, so the workspace
// stays on the tab it was on; a background agent opens with claude attach.
// `raise` asks the widget to bring Ghostty to the front, which only the
// panel can do. The todo list goes to its handed-off agents this way too,
// naming its own window as `layout` for a background agent.
export async function go(a, layout = '') {
  if (!a.pane && !a.jobId) return { ok: false, message: `${a.title} runs outside the layout, so there's nowhere to take you` }
  layout = a.pane?.win ? `layout-${a.pane.win}` : layout || (await layoutSession())
  if (!layout) return { ok: false, message: 'No Ghostty layout window is open to show it in' }
  const hub = (await run(['tmux', ...LAYOUT, 'show', '-v', '-t', layout, '@hub'])).out.trim()
  if (!hub) return { ok: false, message: 'The hub is not running' }
  writeFileSync(HUB_OPEN, a.id)
  await run(['tmux', ...LAYOUT, 'select-window', '-t', `${layout}:hub`])
  await run(['tmux', ...LAYOUT, 'send-keys', '-t', hub, '-l', OPEN_AGENT_KEY])
  return { ok: true, raise: true, message: `${a.title}, in the hub` }
}

// The layout session to show things in: one a Ghostty window is attached
// to, else any.
async function layoutSession() {
  const sessions = (await run(['tmux', ...LAYOUT, 'list-sessions', '-F', '#{session_attached} #{session_name}'])).out
  return sessions
    .split('\n')
    .filter(Boolean)
    .sort()
    .reverse()
    .map(l => l.split(' ')[1])[0]
}

export async function showHub() {
  const layout = await layoutSession()
  if (!layout) return { ok: false, message: 'No Ghostty layout window is open' }
  const shown = await run(['tmux', ...LAYOUT, 'select-window', '-t', `${layout}:hub`])
  return shown.ok ? { ok: true, raise: true, message: 'The hub' } : { ok: false, message: `Couldn't show the hub: ${shown.err}` }
}

// Runs pr-babysit's approval.py for a proposal: the copy that wrote it, so
// a babysit from a worktree's skill is approved by the same code. Under zsh,
// whose ~/.zshenv is where the tokens are exported; the panel that runs
// this didn't load it.
export async function runApproval(p, args, exec = run) {
  if (!p?.script || !/\/approval\.py$/.test(p.script) || !existsSync(p.script)) return { ok: false, message: 'The babysit script that proposed this is gone' }
  const cmd = ['python3', p.script, ...args]
  const r = await exec(existsSync('/bin/zsh') || existsSync('/usr/bin/zsh') ? ['zsh', '-c', 'exec "$@"', 'approval', ...cmd] : cmd)
  try {
    const out = JSON.parse(r.out.trim().split('\n').pop())
    return { ok: Boolean(out.ok), message: out.message ?? '' }
  } catch {
    return { ok: false, message: r.err.split('\n').pop() || 'The approval script failed' }
  }
}

// Opens the Alt+A popup on one proposal, in the Ghostty window you used last.
async function openPopup(pid) {
  const clients = (await run(['tmux', ...LAYOUT, 'list-clients', '-F', '#{client_activity} #{client_name}'])).out
  const client = clients.split('\n').filter(Boolean).sort().reverse()[0]?.split(' ')[1]
  if (!client) return { ok: false, message: 'No Ghostty layout window is open to show it in' }
  const shown = await run([join(HERE, '..', 'bin', 'ghostty-approvals'), client, pid])
  return shown.ok ? { ok: true, raise: true, message: 'In Alt+A' } : { ok: false, message: `Couldn't open Alt+A: ${shown.err}` }
}

async function actOnApproval(action, it) {
  const p = readApprovals().find(x => x.id === it.approval)
  if (!p) return { ok: false, message: 'That approval is gone' }
  if (action === 'edit' || action === 'review') return openPopup(p.id)
  // x on a waiting proposal turns it down, so its session hears of it.
  if (action === 'skip' || (action === 'dismiss' && p.status === 'pending')) return runApproval(p, ['reject', p.id])
  if (action === 'dismiss') return runApproval(p, ['dismiss', p.id])
  if (APPROVE_ACTIONS.has(action)) return runApproval(p, ['approve', p.id])
  return { ok: false, message: `Unknown action ${action}` }
}

export async function act(action, id, agents = readState()?.agents ?? []) {
  const it = trayItems(agents, new Set(), readSet(DISMISSED), readNotes(), readApprovals()).items.find(i => i.id === id)
  if (!it) return { ok: false, message: 'That item is gone' }
  if (it.approval && action !== 'go') return actOnApproval(action, it)
  // A note leaves once you go to it or dismiss it.
  if (it.id.startsWith('n:') && (action === 'go' || action === 'dismiss')) dropNote(it)
  if (it.id.startsWith('n:') && action === 'dismiss') return { ok: true, message: 'Dismissed' }
  const a = agents.find(x => x.id === it.agent)
  if (!a) return action === 'dismiss' ? { ok: true, message: 'Dismissed' } : { ok: false, message: 'The session that sent this is gone' }
  if (action === 'dismiss') {
    // Kept only while those items are still listed, so the file stays small.
    const live = new Set(trayItems(agents).items.map(i => i.id))
    const keep = [...readSet(DISMISSED)].filter(x => live.has(x))
    mkdirSync(RUN, { recursive: true })
    writeFileSync(DISMISSED, JSON.stringify([...keep, id]))
    if (it.section !== 'work') markReviewed(a.id)
    return { ok: true, message: 'Dismissed' }
  }
  if (action === 'allow' || action === 'deny') {
    if (!it.actions.includes(action)) return { ok: false, message: 'Only a permission prompt takes allow or deny' }
    return answer(a, action === 'allow')
  }
  if (action === 'go') {
    if (it.section !== 'work') markReviewed(a.id)
    return go(a)
  }
  return { ok: false, message: `Unknown action ${action}` }
}

const cmd = process.argv[2]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (cmd === 'snapshot') {
    keepAlive()
    process.stdout.write(`${JSON.stringify(snapshot(readState()))}\n`)
  } else if (cmd === 'seen') {
    const ids = trayItems(readState()?.agents ?? [], new Set(), new Set(), readNotes(), readApprovals()).items.map(it => it.id)
    mkdirSync(RUN, { recursive: true })
    writeFileSync(SEEN, JSON.stringify(ids))
  } else if (cmd === 'act') {
    act(process.argv[3], process.argv[4]).then(r => process.stdout.write(`${JSON.stringify(r)}\n`))
  } else if (cmd === 'hub') {
    showHub().then(r => process.stdout.write(`${JSON.stringify(r)}\n`))
  } else if (cmd === 'watch') {
    follow(state => process.stdout.write(`${JSON.stringify(snapshot(state), null, 2)}\n`))
  } else {
    process.stderr.write('tray.mjs snapshot | seen | act <allow|deny|go|dismiss> <id> | hub | watch\n')
    process.exit(1)
  }
}
