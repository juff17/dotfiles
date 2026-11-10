// The settings the rail's ⚙ panel (viewer/settings-view.mjs) changes: values
// the hub, the tray, the Todo list and pr-babysit's watcher used to have
// built in. They live in one flat JSON file of key → value, holding only the
// ones changed from their default, so the watcher (Python) and the tray
// widget (QML, through tray.mjs) can read it too. A value that's missing,
// of the wrong type or out of range reads as its default, so a hand-edited
// file can't break anything that reads it.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// AGENT_HUB_SETTINGS points everything at another file. It's read on each
// call, so a test can set it after importing a module that reads settings.
export const settingsFile = () =>
  process.env.AGENT_HUB_SETTINGS || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-hub', 'settings.json')

const opts = list => list.map(c => (Array.isArray(c) ? { value: c[0], label: c[1] } : { value: c, label: c }))
const head = name => ({ head: name })
const choice = (key, label, choices, def, sub = '') => ({ key, label, sub, type: 'choice', choices: opts(choices), default: def })
const number = (key, label, def, { min, max, step = 1, unit = '' }, sub = '') => ({ key, label, sub, type: 'number', min, max, step, unit, default: def })
const bool = (key, label, def, sub = '') => ({ key, label, sub, type: 'bool', default: def })
const flags = (key, label, choices, def, sub = '') => ({ key, label, sub, type: 'flags', choices: opts(choices), default: def })
// Where an agent's instructions are (hub/prompts.mjs): not a setting, but a
// line the panel shows beside the agent's settings.
const prompt = id => ({ prompt: id })

const MODEL = ['default', 'opus', 'sonnet', 'haiku']
const MODE = ['default', 'auto', 'acceptEdits', 'plan']
const EFFORT = ['default', 'low', 'medium', 'high', 'xhigh']
const agent = (prefix, model, sub = '') => [
  choice(`${prefix}.model`, 'Model', MODEL, model, sub),
  choice(`${prefix}.mode`, 'Permission mode', MODE, 'auto'),
  choice(`${prefix}.effort`, 'Effort', EFFORT, 'medium'),
]

export const SECTIONS = [
  {
    id: 'newAgent',
    name: 'New agent',
    where: 'what New agent (alt+n) starts with; the form can still change it',
    rows: [
      head('Task'),
      ...agent('newAgent.task', 'opus'),
      choice('newAgent.task.runAs', 'Run as', [['tab', 'new tab'], ['bg', 'background']], 'tab'),
      choice('newAgent.task.branch', 'Branch', [['worktree', 'worktree'], ['current', 'current branch']], 'worktree'),
      prompt('task'),
      head('Form'),
      number('newAgent.recent', 'Recent folders shown', 8, { min: 1, max: 8 }, 'under Folder; 8 is all the form has room for'),
    ],
  },
  {
    id: 'prBabysit',
    name: 'PR babysit',
    where: 'babysitters started from New agent, and the watcher every babysit runs',
    rows: [
      head('Agent'),
      ...agent('newAgent.pr', 'sonnet', 'when started from New agent'),
      head('Watcher'),
      number('prBabysit.interval', 'Check the PR every', 60, { min: 15, max: 600, step: 15, unit: 's' }, 'watch_pr.py --interval'),
      number('prBabysit.stuckAfter', 'A job is stuck after', 30, { min: 5, max: 240, step: 5, unit: 'm' }, 'waiting for a runner; watch_pr.py --stuck-after'),
      number('prBabysit.errorAfter', 'Warn after failed checks', 5, { min: 1, max: 20 }, 'API calls failing this many checks in a row raise an error; it keeps trying'),
    ],
  },
  {
    id: 'logger',
    name: 'Log watcher',
    where: 'log watchers started from New agent, and what every watch_logs.py passes on',
    rows: [
      head('Agent'),
      ...agent('newAgent.logs', 'sonnet', 'when started from New agent'),
      head('Watcher'),
      number('logger.dedup', 'Hide repeats for', 120, { min: 0, max: 3600, step: 30, unit: 's' }, 'the same line again within this is dropped; 0 keeps every one; --dedup'),
      number('logger.floodLimit', 'Most lines per 10 s', 25, { min: 5, max: 200, step: 5 }, 'past this, lines are dropped and counted'),
      number('logger.traceLines', 'Stack trace lines kept', 15, { min: 0, max: 100, step: 5 }, 'after the error line that starts one'),
      number('logger.lineChars', 'Longest line', 400, { min: 80, max: 2000, step: 40, unit: ' chars' }, 'longer lines are cut'),
    ],
  },
  {
    id: 'todo',
    name: 'Todo',
    where: 'the Todo list: w hands todos to agents, a files one with Claude',
    rows: [
      head('Hand-off'),
      choice('todo.handoff.model', 'Model', ['opus', 'sonnet', 'haiku'], 'opus', 'm in the hand-off picker'),
      choice('todo.handoff.mode', 'Permission mode', MODE, 'auto'),
      choice('todo.handoff.effort', 'Effort', EFFORT, 'medium'),
      choice('todo.handoff.runAs', 'Run in', [['tab', 'new tab'], ['bg', 'background']], 'tab', 't in the picker; the alt+t popup outside a window always runs in the background'),
      choice('todo.handoff.branch', 'Branch', [['worktree', 'own worktree'], ['branch', 'branch it was added on']], 'worktree', 'b in the picker; only for todos added in git'),
      prompt('todo-handoff'),
      head('Filing'),
      choice('todo.filing.model', 'Model', [['haiku', 'haiku 5.5'], ['sonnet', 'sonnet 5.5']], 'haiku', 'writes the title, category and note'),
      choice('todo.filing.effort', 'Effort', ['low', 'medium', 'high'], 'medium'),
      number('todo.filing.limit', 'Give up after', 3, { min: 1, max: 10, unit: 'm' }, 'then the item shows the error'),
      head('List'),
      number('todo.keepDone', 'Keep done items', 7, { min: 1, max: 60, unit: 'd' }, 'under “done today”, then dropped'),
      number('todo.noteSecs', 'Notes show for', 4, { min: 2, max: 30, unit: 's' }, 'what the list says after you add, hand off or finish something'),
    ],
  },
  {
    id: 'hub',
    name: 'Hub & monitors',
    where: 'the agent hub’s board and its Monitors tray',
    rows: [
      head('Lanes'),
      number('hub.doneCards', 'Done cards before folding', 2, { min: 0, max: 6 }, 'the rest fold to a line each'),
      number('hub.listCols', 'List width beside a session', 46, { min: 36, max: 80, step: 2, unit: ' cols' }),
      number('hub.boardCols', 'Narrowest board', 96, { min: 60, max: 200, step: 4, unit: ' cols' }, 'a narrower hub shows one list instead of the lanes'),
      number('hub.noteSecs', 'Notes show for', 8, { min: 2, max: 60, unit: 's' }, 'what the footer says after you start, stop or close something'),
      head('Monitors'),
      number('hub.monitorRows', 'Rows kept for monitors', 5, { min: 1, max: 5 }, 'more than 5 needs a UI test at that size first'),
      number('hub.endedFor', 'Ended monitors leave after', 5, { min: 1, max: 60, unit: 'm' }),
      number('hub.maxEvents', 'Events kept per monitor', 20, { min: 5, max: 100, step: 5 }),
      bool('hub.askStopMonitor', 'Ask before stopping a monitor', true, 'x in the hub asks “Stop monitor …?”; its session keeps running'),
      flags(
        'hub.attention',
        'Count as needing you',
        ['failed', 'manual', 'stuck', 'conflict', 'error', 'crash', 'auth', 'setup', 'blocked'],
        ['failed', 'manual', 'stuck', 'conflict', 'error', 'crash', 'auth', 'setup', 'blocked'],
        'events that put a monitor’s agent in Needs you',
      ),
      flags('hub.broke', 'Count as broke', ['failed', 'stuck', 'conflict', 'error', 'crash'], ['failed', 'stuck', 'conflict', 'error', 'crash'], 'events that turn a monitor ✗ red in the tray'),
    ],
  },
  {
    id: 'tray',
    name: 'Tray',
    where: 'the Agents widget in the panel and its Meta+A inbox',
    rows: [
      head('Widget'),
      number('tray.flash', 'Flash on a new ▲ or ✗', 2, { min: 0, max: 10, unit: 's' }, '0 turns the flash off'),
      number('tray.noteHours', 'Notes expire after', 24, { min: 1, max: 168, unit: 'h' }, 'notify.sh items you haven’t opened'),
      bool('tray.foldDone', 'Fold done items', true, 'into one line until you press Show'),
      number('tray.messageSecs', 'Results show for', 6, { min: 2, max: 30, unit: 's' }, 'what the inbox says after Allow, Deny or Go'),
      number('tray.pollSecs', 'Check agents every', 2, { min: 1, max: 10, unit: 's' }),
      head('Inbox'),
      number('tray.inboxWidth', 'Width', 600, { min: 400, max: 1200, step: 50, unit: ' px' }),
      number('tray.inboxHeight', 'Most height', 720, { min: 300, max: 1400, step: 60, unit: ' px' }, 'it grows with its items up to this'),
    ],
  },
  {
    id: 'editor',
    name: 'Editor',
    where: 'what alt+e opens the current tab in',
    rows: [
      head('Opening'),
      choice(
        'editor.app',
        'Editor',
        [['code', 'VS Code'], ['cursor', 'Cursor'], ['codium', 'VSCodium'], ['zed', 'Zed'], ['subl', 'Sublime Text']],
        'code',
        'its command (code, cursor, codium, zed, subl) has to be on PATH',
      ),
      choice('editor.window', 'Window', [['default', 'editor decides'], ['new', 'new window'], ['reuse', 'reuse a window']], 'default'),
      choice('editor.open', 'Open', [['root', 'repo or worktree'], ['folder', 'tab’s folder']], 'root', 'outside git it opens the folder either way'),
    ],
  },
  {
    id: 'layout',
    name: 'Layout',
    where: 'the parts of every Ghostty window',
    rows: [
      head('Window'),
      number('layout.railCols', 'Rail width', 6, { min: 5, max: 12, unit: ' cols' }),
      number('layout.diagramsPercent', 'Alt+D window size', 85, { min: 50, max: 100, step: 5, unit: '%' }, 'of the Ghostty window'),
      number('layout.viewerPercent', 'Viewer pane width', 30, { min: 20, max: 70, step: 5, unit: '%' }, 'in new windows; GHOSTTY_VIEWER_SHARE wins'),
      number('layout.topRows', 'btop height', 10, { min: 4, max: 30, unit: ' rows' }, 'in new windows; GHOSTTY_TOP_ROWS wins'),
      head('Popups'),
      number('layout.todoWidth', 'Alt+T width', 70, { min: 40, max: 100, step: 5, unit: '%' }),
      number('layout.todoHeight', 'Alt+T height', 75, { min: 40, max: 100, step: 5, unit: '%' }),
      number('layout.helpPercent', 'Alt+H size', 80, { min: 40, max: 100, step: 5, unit: '%' }),
      number('layout.settingsPercent', 'Settings size', 80, { min: 40, max: 100, step: 5, unit: '%' }, 'takes effect the next time it opens'),
    ],
  },
  {
    id: 'viewers',
    name: 'Viewers',
    where: 'the left pane’s Diagrams and Diff, and Alt+D',
    rows: [
      head('Diagrams'),
      number('viewer.zoomStep', 'Zoom per step', 15, { min: 5, max: 50, step: 5, unit: '%' }, 'a wheel notch or + / -'),
      number('viewer.panPercent', 'Pan per key', 20, { min: 5, max: 50, step: 5, unit: '%' }, 'of the view, for h j k l'),
      number('viewer.maxZoom', 'Most zoom', 16, { min: 2, max: 32, unit: '×' }, 'big diagrams can stop sooner: the picture has only so many cells'),
      head('Diff'),
      number('viewer.scrollLines', 'Lines per scroll', 3, { min: 1, max: 20 }, 'a wheel notch, or J / K'),
    ],
  },
]

export const ROWS = SECTIONS.flatMap(s => s.rows.filter(r => r.key))
const BY_KEY = new Map(ROWS.map(r => [r.key, r]))
export const row = key => BY_KEY.get(key)

export function valid(r, v) {
  if (r.type === 'choice') return r.choices.some(c => c.value === v)
  if (r.type === 'bool') return typeof v === 'boolean'
  if (r.type === 'number') return Number.isFinite(v) && v >= r.min && v <= r.max
  if (r.type === 'flags') return Array.isArray(v) && v.every(x => r.choices.some(c => c.value === x))
  return false
}

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

// Values carried over from prefs.json, beside the file, which is where the
// hub kept "don't ask again" before there were settings.
function legacy(file) {
  return readJson(join(dirname(file), 'prefs.json')).skip?.['stop-monitor'] ? { 'hub.askStopMonitor': false } : {}
}

// What the file holds, with the carried-over values it doesn't set itself.
const raw = file => ({ ...legacy(file), ...readJson(file) })

// Every setting's value. The hub and agentd read it often, so it's read
// again only when the file changes.
let cache = { file: '', mtime: -1, values: null }
export function load(file = settingsFile()) {
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {}
  if (cache.file === file && cache.mtime === mtime && cache.values) return cache.values
  const saved = raw(file)
  const values = {}
  for (const r of ROWS) values[r.key] = valid(r, saved[r.key]) ? saved[r.key] : r.default
  cache = { file, mtime, values: Object.freeze(values) }
  return cache.values
}

export const get = (key, file = settingsFile()) => load(file)[key]

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Sets one value and writes the file whole, through a rename so a reader
// never sees half of it. A value back at its default is left out, so a
// default changed here later reaches everyone who never changed it. Keys the
// file has that this version doesn't know are kept.
export function set(key, value, file = settingsFile()) {
  const r = row(key)
  if (!r || !valid(r, value)) throw new Error(`Not a value for ${key}: ${JSON.stringify(value)}`)
  const saved = raw(file)
  // Unless a carried-over value would come back in its place.
  if (same(value, r.default) && !(key in legacy(file))) delete saved[key]
  else saved[key] = value
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`)
  renameSync(tmp, file)
  cache = { file: '', mtime: -1, values: null }
  return load(file)
}

export const reset = (key, file = settingsFile()) => set(key, row(key).default, file)

// The next value ←/→ (dir -1 or 1) gives: the next choice round the list,
// or a number a step further, kept in range. Flags don't step.
export function step(r, value, dir) {
  if (r.type === 'choice') {
    const i = r.choices.findIndex(c => c.value === value)
    return r.choices[(i + dir + r.choices.length) % r.choices.length].value
  }
  if (r.type === 'number') return Math.min(r.max, Math.max(r.min, value + dir * r.step))
  if (r.type === 'bool') return !value
  return value
}

// A flag turned on or off, kept in the order the choices list them.
export const toggleFlag = (r, value, flag) => r.choices.map(c => c.value).filter(v => (v === flag ? !value.includes(v) : value.includes(v)))

export const show = (r, v) =>
  r.type === 'number' ? `${v}${r.unit}` : r.type === 'bool' ? (v ? 'on' : 'off') : r.type === 'choice' ? (r.choices.find(c => c.value === v)?.label ?? String(v)) : v.join(', ')
