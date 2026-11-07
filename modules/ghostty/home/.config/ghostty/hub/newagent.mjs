#!/usr/bin/env node
// The hub's New agent form, run in a tmux popup over the whole window so it
// has room whether the hub shows the board or the narrow list beside an open
// session. It only asks: what you chose goes to the result file as JSON and
// the hub starts the agent once the popup closes; Esc leaves no file.
//   newagent.mjs <result file> <{"folder": "...", "recents": [...]}>

import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BOLD, P, bg, clean, enter, fg, leave, paint, render, tokens, width } from './term.mjs'

const HOME = homedir()
const [RESULT, OPTS] = process.argv.slice(2)
const { folder = '', recents = [] } = JSON.parse(OPTS || '{}')

const KINDS = [
  { id: 'task', glyph: '✻', color: P.blue, label: 'Task', sub: 'a worker with a prompt' },
  { id: 'pr', glyph: '◉', color: P.teal, label: 'Babysit a PR', sub: 'monitor until it merges' },
  { id: 'logs', glyph: '◉', color: P.teal, label: 'Watch logs', sub: 'monitor a service' },
]
const RUN_AS = [
  { id: 'tab', label: 'New tab', sub: 'in this window' },
  { id: 'worktree', label: 'Worktree + new tab', sub: 'on its own branch' },
  { id: 'bg', label: 'Background', sub: 'no tab; lives in the hub' },
]
const CHOICES = {
  model: ['default', 'opus', 'sonnet', 'haiku'],
  mode: ['default', 'auto', 'acceptEdits', 'plan'],
  effort: ['default', 'low', 'medium', 'high', 'xhigh'],
}
const BOX = bg(P.base)
// Space between the popup's border and the form.
const MARGIN_X = 3
const MARGIN_Y = 1

const tilde = p => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)
const expand = p => (p.startsWith('~') ? HOME + p.slice(1) : p)
const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24

const root = (folder || recents[0] || join(HOME, 'projects')).replace(/\/\.claude\/worktrees\/.*$/, '')
const d = {
  kind: 0,
  runAs: 0,
  model: 0,
  mode: 0,
  effort: 0,
  recent: Math.max(0, recents.indexOf(root)),
  field: 'prompt',
  folder: { text: tilde(root), at: tilde(root).length },
  prompt: { text: '', at: 0 },
  target: { text: '', at: 0 },
  error: null,
}
let hits = []

function fields() {
  const k = KINDS[d.kind].id
  return ['kind', 'folder', 'recent', k === 'task' ? 'prompt' : 'target', ...(k === 'task' ? ['runAs'] : []), 'model', 'mode', 'effort', 'start']
}

function input(field, w, on) {
  const { text, at } = d[field]
  const shown = clean(text)
  if (!on) return render([[shown || ' ', fg(P.text)]], w, BOX)
  // Keep the cursor in view on a long line.
  const start = Math.max(0, at - w + 2)
  const before = shown.slice(start, at)
  const cur = shown[at] ?? ' '
  const after = shown.slice(at + 1)
  return render([[before, fg(P.text)], [cur, '\x1b[7m'], [after, fg(P.text)]], w, BOX)
}

function draw() {
  const W = cols()
  const H = rows()
  const w = W - 2 * MARGIN_X
  const kind = KINDS[d.kind].id
  const body = []
  const label = (name, f) => [[name.padEnd(10), fg(d.field === f ? P.blue : P.sub)]]
  const row = (f, spans) => body.push({ f, line: spans })
  const note = text => row(null, [[`${' '.repeat(10)}${text}`, fg(P.overlay1)]])
  row('kind', [
    ...label('Kind', 'kind'),
    ...KINDS.flatMap((x, i) => [
      [`${i === d.kind ? '●' : '○'} `, fg(x.color)],
      [x.label, i === d.kind ? BOLD + fg(P.text) : fg(P.sub)],
      ['   ', ''],
    ]),
  ])
  note(KINDS[d.kind].sub)
  row(null, [])
  row('folder', [...label('Folder', 'folder'), { input: 'folder' }])
  row('recent', [
    ...label('Recent', 'recent'),
    ...recents.flatMap((p, i) => [[` ${p.split('/').pop()} `, i === d.recent && d.field === 'recent' ? fg(P.crust) + bg(P.blue) : fg(P.text) + bg(P.surface0)], [' ', '']]),
  ])
  row(null, [])
  if (kind === 'task') row('prompt', [...label('Task', 'prompt'), { input: 'prompt' }])
  else row('target', [...label(kind === 'pr' ? 'PR link' : 'Watch', 'target'), { input: 'target' }])
  if (kind === 'pr') note('starts /pr-babysit in the background; it lands in Monitors')
  if (kind === 'logs') note('a command or service, e.g. docker compose logs api; runs /logger')
  if (kind === 'task') {
    row(null, [])
    row('runAs', [
      ...label('Run as', 'runAs'),
      ...RUN_AS.flatMap((x, i) => [[`${i === d.runAs ? '●' : '○'} `, fg(P.blue)], [x.label, i === d.runAs ? BOLD + fg(P.text) : fg(P.sub)], ['   ', '']]),
    ])
    note(RUN_AS[d.runAs].sub)
  }
  row(null, [])
  for (const f of ['model', 'mode', 'effort'])
    row(f, [...label(f[0].toUpperCase() + f.slice(1), f), [`‹ ${CHOICES[f][d[f]]} ›`, d.field === f ? fg(P.text) + bg(P.surface0) : fg(P.text)]])
  row(null, [])
  const lands =
    kind !== 'task' ? 'lands in Monitors, as a background session' : RUN_AS[d.runAs].id === 'bg' ? 'lands in Working, no tab' : 'opens its session in the hub'
  row('start', [[' Start ', BOLD + (d.field === 'start' ? fg(P.crust) + bg(P.blue) : fg(P.blue) + bg(P.surface0))], ['  ctrl+s', fg(P.sub)], [`   ${lands}`, fg(P.overlay1)]])

  // The form sits at the top; the error and the keys keep the bottom rows.
  hits = []
  const blank = render([], W, BOX)
  const lines = Array.from({ length: MARGIN_Y }, () => blank)
  const pad = render([], MARGIN_X, BOX)
  for (const b of body.slice(0, Math.max(0, H - MARGIN_Y - 3))) {
    const spans = b.line.filter(s => !s.input)
    const inp = b.line.find(s => s.input)
    let inner
    if (inp) {
      const lw = spans.reduce((n, [t]) => n + width(t), 0)
      inner = render(spans, lw, BOX) + input(inp.input, w - lw, d.field === b.f)
    } else inner = render(spans, w, BOX)
    if (b.f) hits.push({ y: lines.length + 1, f: b.f })
    lines.push(pad + inner + pad)
  }
  while (lines.length < H - 2) lines.push(blank)
  lines.push(pad + render(d.error ? [[d.error, BOLD + fg(P.peach)]] : [], w, BOX) + pad)
  lines.push(pad + render([['↑/↓ field   ←/→ choose   tab complete folder   ctrl+s start   esc cancel', fg(P.overlay1)]], w, BOX) + pad)
  paint(lines.slice(0, H))
}

function key(k, paste) {
  const fs = fields()
  const at = fs.indexOf(d.field)
  const move = n => (d.field = fs[Math.min(fs.length - 1, Math.max(0, at + n))])
  d.error = null
  if (paste !== undefined) {
    if (['folder', 'prompt', 'target'].includes(d.field)) insert(d[d.field], paste.replace(/\s*\n\s*/g, ' '))
    return
  }
  const text = ['folder', 'prompt', 'target'].includes(d.field) ? d[d.field] : null
  const choice = { kind: [KINDS.length, 'kind'], runAs: [RUN_AS.length, 'runAs'], recent: [recents.length, 'recent'] }[d.field] ??
    (CHOICES[d.field] ? [CHOICES[d.field].length, d.field] : null)
  if (k === '\x1b' || k === '\x03') return finish(null)
  if (k === '\x13') return submit()
  if (k === '\x1b[A' || k === '\x1b[Z') return move(-1)
  if (k === '\x1b[B') return move(1)
  if (k === '\r') return d.field === 'start' ? submit() : move(1)
  if (k === '\t') return d.field === 'folder' ? complete() : move(1)
  if (choice && (k === '\x1b[C' || k === '\x1b[D' || k === ' ')) {
    const [n, prop] = choice
    if (!n) return
    d[prop] = (d[prop] + (k === '\x1b[D' ? n - 1 : 1)) % n
    if (prop === 'recent') {
      const p = tilde(recents[d.recent] ?? '')
      d.folder = { text: p, at: p.length }
    }
    if (prop === 'kind' && !fields().includes(d.field)) d.field = 'kind'
    return
  }
  if (!text) return
  if (k === '\x1b[D') text.at = Math.max(0, text.at - 1)
  else if (k === '\x1b[C') text.at = Math.min(text.text.length, text.at + 1)
  else if (k === '\x1b[H' || k === '\x01') text.at = 0
  else if (k === '\x1b[F' || k === '\x05') text.at = text.text.length
  else if (k === '\x7f' || k === '\b') {
    if (text.at > 0) {
      text.text = text.text.slice(0, text.at - 1) + text.text.slice(text.at)
      text.at--
    }
  } else if (k === '\x15') {
    text.text = text.text.slice(text.at)
    text.at = 0
  } else if (k === '\x17') {
    const head = text.text.slice(0, text.at).replace(/\S+\s*$/, '')
    text.text = head + text.text.slice(text.at)
    text.at = head.length
  } else if (k.length >= 1 && !k.startsWith('\x1b') && k >= ' ') insert(text, k)
}

function insert(text, s) {
  const c = clean(s)
  text.text = text.text.slice(0, text.at) + c + text.text.slice(text.at)
  text.at += c.length
}

// Tab in Folder: the longest common start of the folders that match.
function complete() {
  const full = expand(d.folder.text)
  const dir = full.endsWith('/') ? full : dirname(full)
  const part = full.endsWith('/') ? '' : full.slice(dir.length + (dir.endsWith('/') ? 0 : 1))
  let names = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(part) && (part.startsWith('.') || !e.name.startsWith('.')))
      .map(e => e.name)
  } catch {}
  if (!names.length) return
  let common = names[0]
  for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1)
  const next = tilde(join(dir, common)) + (names.length === 1 ? '/' : '')
  d.folder = { text: next, at: next.length }
}

function submit() {
  const kind = KINDS[d.kind].id
  const cwd = expand(d.folder.text.trim()).replace(/\/+$/, '') || HOME
  try {
    if (!statSync(cwd).isDirectory()) throw new Error()
  } catch {
    d.field = 'folder'
    d.error = `No folder ${tilde(cwd)}`
    return
  }
  if (kind === 'task' && !d.prompt.text.trim()) {
    d.field = 'prompt'
    d.error = 'Give the task a first prompt'
    return
  }
  if (kind !== 'task' && !d.target.text.trim()) {
    d.field = 'target'
    d.error = kind === 'pr' ? 'Paste the PR or MR link' : 'Say what to watch'
    return
  }
  finish({
    kind,
    cwd,
    prompt: d.prompt.text,
    target: d.target.text,
    runAs: RUN_AS[d.runAs].id,
    model: CHOICES.model[d.model],
    mode: CHOICES.mode[d.mode],
    effort: CHOICES.effort[d.effort],
  })
}

function finish(spec) {
  if (spec) writeFileSync(RESULT, JSON.stringify(spec))
  leave()
  process.exit(0)
}

if (!RESULT || !process.stdin.isTTY) {
  console.error('newagent.mjs <result file> <options json>, in a terminal; the hub runs it.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.mouse) {
      if (t.mouse.up || t.mouse.button & 64 || (t.mouse.button & 3) !== 0) continue
      const h = hits.find(r => r.y === t.mouse.y)
      if (!h) continue
      d.field = h.f
      if (h.f === 'start') submit()
    } else key(t.key ?? '', t.paste)
  }
  draw()
})
process.stdout.on('resize', draw)
process.on('SIGHUP', () => finish(null))
process.on('SIGTERM', () => finish(null))
enter()
draw()
