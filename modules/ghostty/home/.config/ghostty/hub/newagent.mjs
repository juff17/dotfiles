#!/usr/bin/env node
// The hub's New agent form, run in a tmux popup over the whole window so it
// has room whether the hub shows the board or the narrow list beside an open
// session. It only asks: what you chose goes to the result file as JSON and
// the hub starts the agent once the popup closes; Esc leaves no file.
//   newagent.mjs <result file> <{"folder": "...", "recents": [...]}>

import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { caretParts, editLine, insertAt, length } from './line.mjs'
import { load as settings } from './settings.mjs'
import { BOLD, ITALIC, P, bg, clean, enter, fg, leave, paint, render, tokens, width } from './term.mjs'

const HOME = homedir()

const KINDS = [
  { id: 'task', glyph: '✻', color: P.blue, label: 'Task', sub: 'a worker with a prompt' },
  { id: 'pr', glyph: '◉', color: P.teal, label: 'Babysit a PR', sub: 'monitor until it merges' },
  { id: 'logs', glyph: '◉', color: P.teal, label: 'Watch logs', sub: 'monitor a service' },
]
const RUN_AS = [
  { id: 'tab', label: 'New tab', sub: 'a tab in this window' },
  { id: 'bg', label: 'Background', sub: 'no tab; lives in the hub' },
]
const BRANCH = [
  { id: 'current', label: 'Current branch', sub: 'works in the folder as it is' },
  { id: 'worktree', label: 'Worktree', sub: 'its own worktree and branch' },
]
const CHOICES = {
  model: ['default', 'fable', 'opus', 'sonnet', 'haiku'],
  mode: ['default', 'auto', 'acceptEdits', 'plan'],
  effort: ['default', 'low', 'medium', 'high', 'xhigh'],
}
// What each kind starts with comes from Settings (newAgent.<kind>.*); 'default'
// is still a choice, for Claude's own.
const BOX = bg(P.base)
// Space between the popup's border and the form.
const MARGIN_X = 3
const MARGIN_Y = 1
const HINTS = '↑/↓ field   ←/→ choose   tab complete folder   ctrl+s start   esc cancel'
// The tallest form is a task's: the prompt, a gap, kind and its note, a gap,
// folder, recent, a gap, run as, branch and their note, a gap, model, mode,
// effort, a gap, Start. Below it a gap, then the keys.
const BODY_ROWS = 17
const LABEL_COLS = 10

// The popup's size, border included, which the hub opens it at: just room
// for the form, with the folder and prompt as wide as the keys line.
export const POPUP = {
  w: width(HINTS) + 2 * MARGIN_X + 2,
  h: BODY_ROWS + 2 + 2 * MARGIN_Y + 2,
}

const tilde = p => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)
const expand = p => (p.startsWith('~') ? HOME + p.slice(1) : p)
const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24

let RESULT = null
let recents = []
let d = null
let hits = []
// While Tab cycles through the folders that match: where they are, their
// names and which one is in the field.
let menu = null

export function fields() {
  const k = KINDS[d.kind].id
  return [k === 'task' ? 'prompt' : 'target', 'kind', 'folder', 'recent', ...(k === 'task' ? ['runAs', 'branch'] : []), 'model', 'mode', 'effort', 'start']
}

// `ghost` is the rest of a suggestion, drawn dim after the text with the
// cursor on its first character, as fish and zsh-autosuggestions do.
function input(field, w, on, ghost = '') {
  const { text, at } = d[field]
  const shown = clean(text)
  if (!on) return render([[shown || ' ', fg(P.text)]], w, BOX)
  // Cut around the cursor on a long line, so it stays in view.
  const { before, under, after } = caretParts(shown, at, w)
  if (ghost && at === length(shown)) {
    const [first, ...rest] = ghost
    return render([[before, fg(P.text)], [first, `\x1b[7m${fg(P.overlay1)}`], [rest.join(''), fg(P.overlay1)]], w, BOX)
  }
  return render([[before, fg(P.text)], [under, '\x1b[7m'], [after, fg(P.text)]], w, BOX)
}

// ------------------------------------------------------------ folders

// The folders the Folder field's last part could be: those that start with
// it, or, when none does, those that do ignoring case. Hidden ones only when
// the part starts with a dot, as in a shell.
export function matchesOf(text) {
  const full = expand(text)
  const dir = full.endsWith('/') ? full : dirname(full)
  const part = full.endsWith('/') ? '' : basename(full)
  let all = []
  try {
    all = readdirSync(dir, { withFileTypes: true })
      .filter(e => (part.startsWith('.') || !e.name.startsWith('.')) && isDir(dir, e))
      .map(e => e.name)
      .sort()
  } catch {}
  let names = all.filter(n => n.startsWith(part))
  if (!names.length) names = all.filter(n => n.toLowerCase().startsWith(part.toLowerCase()))
  return { dir, part, names }
}

function isDir(dir, e) {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return statSync(join(dir, e.name)).isDirectory()
  } catch {
    return false
  }
}

// The cursor is in code points, as hub/line.mjs keeps it.
const setFolder = text => (d.folder = { text, at: length(text) })
const pathTo = (dir, name) => tilde(join(dir, name))

// What's left of the first match, while the cursor is at the end of a part
// it extends.
export function suggestion() {
  if (d.field !== 'folder' || menu || d.folder.at !== length(d.folder.text)) return ''
  const { part, names } = matchesOf(d.folder.text)
  return part && names[0]?.startsWith(part) ? `${names[0].slice(part.length)}/` : ''
}

// Tab as in zsh: one match is filled in with its slash; several fill in
// what they share, and once nothing more is shared, Tab steps through them
// (Shift+Tab back) until another key keeps the one shown.
function tab(back) {
  if (menu) {
    menu.i = (menu.i + (back ? menu.names.length - 1 : 1)) % menu.names.length
    return setFolder(`${pathTo(menu.dir, menu.names[menu.i])}/`)
  }
  const { dir, part, names } = matchesOf(d.folder.text)
  if (!names.length) return
  if (names.length === 1) return setFolder(`${pathTo(dir, names[0])}/`)
  let common = names[0]
  for (const n of names) while (!n.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1)
  if (common.length > part.length) return setFolder(pathTo(dir, common))
  menu = { dir, names, i: back ? names.length - 1 : 0 }
  setFolder(`${pathTo(dir, names[menu.i])}/`)
}

// Under Folder while you type in it: the folders that match, the one Tab is
// on highlighted, in place of Recent.
function matchesRow(w) {
  const { part, names } = menu ?? matchesOf(d.folder.text)
  const head = [['Matches'.padEnd(LABEL_COLS), fg(P.blue)]]
  if (!menu && !part && !d.folder.text.endsWith('/')) return null
  if (!names.length) return [...head, ['no folder matches', ITALIC + fg(P.overlay1)]]
  const chip = (n, i) => [` ${n} `, menu && i === menu.i ? fg(P.crust) + bg(P.blue) : fg(P.text) + bg(P.surface0)]
  const room = w - LABEL_COLS
  // Starts late enough that the highlighted one fits, and says what's hidden.
  let from = 0
  const fits = (a, b) => names.slice(a, b + 1).reduce((n, x) => n + width(x) + 3, 0) + (a > 0 ? 2 : 0) + 8 <= room
  while (menu && from < menu.i && !fits(from, menu.i)) from++
  const spans = from > 0 ? [['… ', fg(P.overlay1)]] : []
  let used = from > 0 ? 2 : 0
  let i = from
  for (; i < names.length; i++) {
    const cost = width(names[i]) + 3
    if (used + cost + (i < names.length - 1 ? 8 : 0) > room) break
    spans.push(chip(names[i], i), [' ', ''])
    used += cost
  }
  if (i < names.length) spans.push([`+${names.length - i} more`, fg(P.overlay1)])
  return [...head, ...spans]
}

function draw() {
  const W = cols()
  const H = rows()
  const w = W - 2 * MARGIN_X
  const kind = KINDS[d.kind].id
  const body = []
  const label = (name, f) => [[name.padEnd(LABEL_COLS), fg(d.field === f ? P.blue : P.sub)]]
  const row = (f, spans) => body.push({ f, line: spans })
  const note = text => row(null, [[`${' '.repeat(LABEL_COLS)}${text}`, fg(P.overlay1)]])
  // What to do comes first, where the cursor starts; the choices follow.
  if (kind === 'task') row('prompt', [...label('Task', 'prompt'), { input: 'prompt' }])
  else row('target', [...label(kind === 'pr' ? 'PR link' : 'Watch', 'target'), { input: 'target' }])
  if (kind === 'pr') note('starts /pr-babysit in the background; it lands in Monitors')
  if (kind === 'logs') note('a command or service, e.g. docker compose logs api; runs /logger')
  row(null, [])
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
  row('folder', [...label('Folder', 'folder'), { input: 'folder', ghost: suggestion() }])
  row(
    'recent',
    (d.field === 'folder' && matchesRow(w)) || [
      ...label('Recent', 'recent'),
      ...recents.flatMap((p, i) => [[` ${p.split('/').pop()} `, i === d.recent && d.field === 'recent' ? fg(P.crust) + bg(P.blue) : fg(P.text) + bg(P.surface0)], [' ', '']]),
    ],
  )
  if (kind === 'task') {
    row(null, [])
    const radio = (f, name, opts) =>
      row(f, [
        ...label(name, f),
        ...opts.flatMap((x, i) => [[`${i === d[f] ? '●' : '○'} `, fg(P.blue)], [x.label, i === d[f] ? BOLD + fg(P.text) : fg(P.sub)], ['   ', '']]),
      ])
    radio('runAs', 'Run as', RUN_AS)
    radio('branch', 'Branch', BRANCH)
    note(`${RUN_AS[d.runAs].sub} · ${BRANCH[d.branch].sub}`)
  }
  row(null, [])
  for (const f of ['model', 'mode', 'effort'])
    row(f, [...label(f[0].toUpperCase() + f.slice(1), f), [`‹ ${CHOICES[f][d[f]]} ›`, d.field === f ? fg(P.text) + bg(P.surface0) : fg(P.text)]])
  row(null, [])
  const lands =
    kind !== 'task' ? 'lands in Monitors, as a background session' : RUN_AS[d.runAs].id === 'bg' ? 'lands in Working, no tab' : 'opens its session in the hub'
  // An error stands in for where the agent lands, beside the Start it stopped.
  row('start', [
    [' Start ', BOLD + (d.field === 'start' ? fg(P.crust) + bg(P.blue) : fg(P.blue) + bg(P.surface0))],
    ['  ctrl+s', fg(P.sub)],
    d.error ? [`   ${d.error}`, BOLD + fg(P.peach)] : [`   ${lands}`, fg(P.overlay1)],
  ])

  // The keys keep the bottom row, so they stay put as the form changes length.
  hits = []
  const blank = render([], W, BOX)
  const lines = Array.from({ length: MARGIN_Y }, () => blank)
  const pad = render([], MARGIN_X, BOX)
  for (const b of body.slice(0, Math.max(0, H - 2 * MARGIN_Y - 2))) {
    const spans = b.line.filter(s => !s.input)
    const inp = b.line.find(s => s.input)
    let inner
    if (inp) {
      const lw = spans.reduce((n, [t]) => n + width(t), 0)
      inner = render(spans, lw, BOX) + input(inp.input, w - lw, d.field === b.f, inp.ghost)
    } else inner = render(spans, w, BOX)
    if (b.f) hits.push({ y: lines.length + 1, f: b.f })
    lines.push(pad + inner + pad)
  }
  while (lines.length < H - MARGIN_Y - 1) lines.push(blank)
  lines.push(pad + render([[HINTS, fg(P.overlay1)]], w, BOX) + pad)
  while (lines.length < H) lines.push(blank)
  paint(lines.slice(0, H))
}

// One key, or pasted text, for the field you're on. Returns { done } once
// the form is finished: the spec to start, or null for cancel.
export function key(k, paste) {
  const fs = fields()
  const at = fs.indexOf(d.field)
  const move = n => (d.field = fs[Math.min(fs.length - 1, Math.max(0, at + n))])
  d.error = null
  if (k !== '\t' && k !== '\x1b[Z') menu = null
  if (paste !== undefined) {
    if (['folder', 'prompt', 'target'].includes(d.field)) insert(d[d.field], paste.replace(/\s*\n\s*/g, ' '))
    return
  }
  const text = ['folder', 'prompt', 'target'].includes(d.field) ? d[d.field] : null
  const choice = { kind: [KINDS.length, 'kind'], runAs: [RUN_AS.length, 'runAs'], branch: [BRANCH.length, 'branch'], recent: [recents.length, 'recent'] }[d.field] ??
    (CHOICES[d.field] ? [CHOICES[d.field].length, d.field] : null)
  if (k === '\x1b' || k === '\x03') return { done: null }
  if (k === '\x13') return submit()
  if (d.field === 'folder' && (k === '\t' || (k === '\x1b[Z' && menu))) return tab(k === '\x1b[Z')
  if (k === '\x1b[A' || k === '\x1b[Z') return move(-1)
  if (k === '\x1b[B') return move(1)
  if (k === '\r') return d.field === 'start' ? submit() : move(1)
  if (k === '\t') return move(1)
  // → or End at the end of the folder takes the suggestion.
  if (d.field === 'folder' && (k === '\x1b[C' || k === '\x1b[F' || k === '\x05')) {
    const rest = suggestion()
    if (rest) return setFolder(d.folder.text + rest)
  }
  if (choice && (k === '\x1b[C' || k === '\x1b[D' || k === ' ')) {
    const [n, prop] = choice
    if (!n) return
    // Recent is -1 while Folder isn't one of them: → takes the first, ← the last.
    d[prop] = d[prop] < 0 ? (k === '\x1b[D' ? n - 1 : 0) : (d[prop] + (k === '\x1b[D' ? n - 1 : 1)) % n
    if (prop === 'recent') {
      const p = tilde(recents[d.recent] ?? '')
      setFolder(p)
    }
    if (prop === 'kind') {
      startWith(KINDS[d.kind].id)
      if (!fields().includes(d.field)) d.field = 'kind'
    }
    return
  }
  if (text) Object.assign(text, editLine(text.text, text.at, k))
}

function insert(text, s) {
  Object.assign(text, insertAt(text.text, text.at, clean(s)))
}

// The spec for the hub, or nothing with an error beside Start and the
// field to fix selected.
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
  return {
    done: {
      kind,
      cwd,
      prompt: d.prompt.text,
      target: d.target.text,
      runAs: RUN_AS[d.runAs].id,
      worktree: BRANCH[d.branch].id === 'worktree',
      model: CHOICES.model[d.model],
      mode: CHOICES.mode[d.mode],
      effort: CHOICES.effort[d.effort],
    },
  }
}

// Model, mode and effort go back to what the kind starts with.
function startWith(kind) {
  const s = settings()
  for (const f of ['model', 'mode', 'effort']) d[f] = Math.max(0, CHOICES[f].indexOf(s[`newAgent.${kind}.${f}`]))
}

function finish(spec) {
  if (spec) writeFileSync(RESULT, JSON.stringify(spec))
  leave()
  process.exit(0)
}

// A fresh form: on a task, in the folder given (a worktree's repo, so the
// new agent doesn't nest in another's worktree), or else the newest recent.
// Returns the form's state, which key() changes.
export function form({ folder = '', recents: given = [] } = {}) {
  recents = given
  menu = null
  const s = settings()
  const start = s['newAgent.defaultFolder'] === 'projects' ? '' : folder || recents[0]
  const root = (start || join(HOME, 'projects')).replace(/\/\.claude\/worktrees\/.*$/, '')
  d = {
    kind: 0,
    runAs: Math.max(0, RUN_AS.findIndex(r => r.id === s['newAgent.task.runAs'])),
    branch: Math.max(0, BRANCH.findIndex(b => b.id === s['newAgent.task.branch'])),
    model: 0,
    mode: 0,
    effort: 0,
    // Which recent Folder is, -1 for none, so none shows as chosen.
    recent: recents.indexOf(root),
    field: 'prompt',
    folder: { text: tilde(root), at: length(tilde(root)) },
    prompt: { text: '', at: 0 },
    target: { text: '', at: 0 },
    error: null,
  }
  startWith(KINDS[d.kind].id)
  return d
}

function main() {
  const [result, opts] = process.argv.slice(2)
  if (!result || !process.stdin.isTTY) {
    console.error('newagent.mjs <result file> <options json>, in a terminal; the hub runs it.')
    process.exit(1)
  }
  RESULT = result
  form(JSON.parse(opts || '{}'))
  process.stdin.setRawMode(true)
  process.stdin.on('data', data => {
    for (const t of tokens(data.toString('utf8'))) {
      if (t.mouse) {
        if (t.mouse.up || t.mouse.button & 64 || (t.mouse.button & 3) !== 0) continue
        const h = hits.find(r => r.y === t.mouse.y)
        if (!h) continue
        d.field = h.f
        const r = h.f === 'start' ? submit() : null
        if (r) return finish(r.done)
      } else {
        const r = key(t.key ?? '', t.paste)
        if (r?.done !== undefined) return finish(r.done)
      }
    }
    draw()
  })
  process.stdout.on('resize', draw)
  process.on('SIGHUP', () => finish(null))
  process.on('SIGTERM', () => finish(null))
  enter()
  draw()
}

// The hub imports POPUP; run as a program, this is the form.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
