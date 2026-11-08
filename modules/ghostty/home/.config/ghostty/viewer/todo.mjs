// The todo list shared by bin/ghostty-todo (what Claude and the /todo skill
// call) and the viewer's Todo mode (todo-view.mjs). One JSON file holds every
// repo's items. Each write takes a lock and replaces the file whole, so the
// viewer never reads half a write.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { slug } from '../hub/model.mjs'
import { load as settings } from '../hub/settings.mjs'
import { instructions, skillOf } from '../hub/prompts.mjs'

export const STORE =
  process.env.TODO_FILE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'ghostty-layout/todos.json')

// In the order the viewer groups them. short fits the CLI's list and the
// category picker.
export const CATEGORIES = [
  { name: 'bug', short: 'bug', color: '#f38ba8' },
  { name: 'feature', short: 'feat', color: '#89b4fa' },
  { name: 'follow-up', short: 'follow', color: '#cba6f7' },
  { name: 'docs', short: 'docs', color: '#94e2d5' },
  { name: 'question', short: 'ask', color: '#f9e2af' },
  { name: 'other', short: 'other', color: '#a6adc8' },
]
export const DEFAULT_CATEGORY = 'follow-up'
const ALIASES = { fix: 'bug', feat: 'feature', follow: 'follow-up', followup: 'follow-up', doc: 'docs', ask: 'question', q: 'question', misc: 'other' }

// What kind of work an item is, beside its category: finding something out,
// making a call, doing something, judging someone's work, or upkeep.
// Optional, so an item can have none.
export const TYPES = [
  { name: 'research', color: '#fab387' },
  { name: 'decide', color: '#f5c2e7' },
  { name: 'action', color: '#a6e3a1' },
  { name: 'review', color: '#74c7ec' },
  { name: 'chore', color: '#9399b2' },
]
const TYPE_ALIASES = { do: 'action', act: 'action', task: 'action' }

// Done items stay this long by default, then a write drops them; Settings
// (todo.keepDone, in days) changes it.
export const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000
const keepDoneMs = () => settings()['todo.keepDone'] * 24 * 60 * 60 * 1000

// A filing item holds a message Claude is turning into a todo (ghostty-todo
// file) until `add --filing` replaces it with the real one. ghostty-todo
// stops Claude well before this; past it the item counts as failed anyway,
// in case the filer died without saying so. Settings can give the filer
// longer (todo.filing.limit), so this keeps two minutes past that.
export const FILING_TIMEOUT_MS = 5 * 60 * 1000
const filingTimeoutMs = () => Math.max(FILING_TIMEOUT_MS, (settings()['todo.filing.limit'] + 2) * 60 * 1000)

// 'filing', 'failed', or '' for an ordinary item.
export function filingState(item, now = Date.now(), timeout = filingTimeoutMs()) {
  if (!item.filing) return ''
  return item.filing.error || now - item.filing.started > timeout ? 'failed' : 'filing'
}

// A category from what someone typed: a name, an alias or a unique prefix.
export function category(input) {
  const word = String(input ?? '').trim().toLowerCase()
  if (!word) return undefined
  if (ALIASES[word]) return ALIASES[word]
  const matches = CATEGORIES.filter(c => c.name.startsWith(word))
  return matches.length === 1 ? matches[0].name : undefined
}

// A type from what someone typed, as category() reads one; none gives null,
// which clears it.
export function taskType(input) {
  const word = String(input ?? '').trim().toLowerCase()
  if (!word) return undefined
  if (word === 'none') return null
  if (TYPE_ALIASES[word]) return TYPE_ALIASES[word]
  const matches = TYPES.filter(t => t.name.startsWith(word))
  return matches.length === 1 ? matches[0].name : undefined
}

export const typeColorOf = name => TYPES.find(t => t.name === name)?.color ?? '#a6adc8'

export const colorOf =name => CATEGORIES.find(c => c.name === name)?.color ?? '#cdd6f4'

export function newId(items, random = Math.random) {
  const taken = new Set(items.map(i => i.id))
  for (let length = 3; ; length++) {
    for (let tries = 0; tries < 20; tries++) {
      const id = Array.from({ length }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)]).join('')
      if (!taken.has(id)) return id
    }
  }
}

export const prune = (items, now = Date.now(), keep = keepDoneMs()) => items.filter(i => !i.done || now - i.done < keep)

// Finds an item by its id, or by a unique start of one.
export function find(items, id) {
  const exact = items.find(i => i.id === id)
  if (exact) return exact
  const matches = items.filter(i => i.id.startsWith(id))
  return matches.length === 1 ? matches[0] : undefined
}

export function age(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (24 * 60))}d`
}

const startOfDay = now => {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

// What the viewer shows: open items grouped by category in CATEGORIES order,
// the repo `here` (a main repo's root) first in each group and newest first
// after that, and the items done since midnight. `only` keeps just here's.
// Items Claude is still filing go apart, oldest first: they have no real
// category yet and don't count as open.
export function arrange(items, { here = '', only = false, now = Date.now() } = {}) {
  const shown = items.filter(i => !only || i.root === here)
  const filing = shown.filter(i => i.filing).sort((a, b) => a.created - b.created)
  const real = shown.filter(i => !i.filing)
  const order = (a, b) => (b.root === here) - (a.root === here) || b.created - a.created
  const groups = CATEGORIES.map(c => ({ ...c, items: real.filter(i => !i.done && i.cat === c.name).sort(order) })).filter(
    g => g.items.length,
  )
  const today = startOfDay(now)
  const doneToday = real.filter(i => i.done && i.done >= today).sort((a, b) => b.done - a.done)
  return { groups, filing, doneToday, open: groups.reduce((n, g) => n + g.items.length, 0) }
}

export function load(file = STORE) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data.items) ? data.items : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new Error(`Can't read ${file}: ${error.message}`)
  }
}

// When the file last changed, to tell whether to read it again.
export function stamp(file = STORE) {
  try {
    const { mtimeMs, size } = statSync(file)
    return `${mtimeMs}:${size}`
  } catch {
    return ''
  }
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// A lock held longer than this belongs to a writer that died.
const STALE_LOCK_MS = 10000

// Runs change(items) under the lock and saves what it returns, pruned of old
// done items. Returns change's result's `value`, if any.
export function update(change, file = STORE) {
  mkdirSync(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock)
      } catch {}
      if (tries > 250) throw new Error(`${lock} is held; remove it if no todo command is running`)
      pause(20)
    }
  }
  try {
    const { items, value } = change(load(file))
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ v: 1, items: prune(items) }, null, 1)}\n`)
    renameSync(tmp, file)
    return value
  } finally {
    rmdirSync(lock)
  }
}

export function add(fields, file = STORE) {
  return update(items => {
    const item = { id: newId(items), created: Date.now(), done: null, cat: DEFAULT_CATEGORY, note: '', ...fields }
    return { items: [...items, item], value: item }
  }, file)
}

// Applies fields to the item `id` names; returns the changed item, or
// undefined when no single item matches.
export function change(id, fields, file = STORE) {
  return update(items => {
    const item = find(items, id)
    if (!item) return { items }
    const changed = { ...item, ...(typeof fields === 'function' ? fields(item) : fields) }
    return { items: items.map(i => (i === item ? changed : i)), value: changed }
  }, file)
}

// Turns the filing item `id` into a real one with these fields. Undefined
// when no item is filing under that id: it was dropped, or filed already.
export function fill(id, fields, file = STORE) {
  return update(items => {
    const item = items.find(i => i.id === id && i.filing)
    if (!item) return { items }
    const { filing, ...rest } = item
    const filled = { ...rest, ...fields }
    return { items: items.map(i => (i === item ? filled : i)), value: filled }
  }, file)
}

export function remove(id, file = STORE) {
  return update(items => {
    const item = find(items, id)
    return { items: items.filter(i => i !== item), value: item }
  }, file)
}

const git = (args, cwd) =>
  new Promise(done => execFile('git', args, { cwd, encoding: 'utf8' }, (error, out) => done(error ? '' : out.trim())))

// Where dir sits: the main repo's root and name (the same for all its
// worktrees), the worktree's own root, and the branch. Outside git, the
// folder stands in for the repo.
export async function repoOf(dir) {
  const top = await git(['rev-parse', '--show-toplevel'], dir)
  // Outside a repo the folder still scopes "this repo", but its name would
  // read as a repo, so it is labelled none.
  if (!top) return { root: resolve(dir), repo: 'none', worktree: '', branch: '' }
  const common = resolve(top, await git(['rev-parse', '--git-common-dir'], top))
  const root = basename(common) === '.git' ? dirname(common) : top
  const branch = (await git(['branch', '--show-current'], top)) || (await git(['rev-parse', '--short', 'HEAD'], top))
  return { root, repo: basename(root), worktree: top === root ? '' : top, branch }
}

// The repos the filer may put an item in: those already on the list, and
// the git repos beside them (a projects folder), which it searches when the
// message doesn't name one. A message typed in one tab is often about
// another repo, and without the paths Claude can only file it where the tab is.
export function knownRepos(items, { exists = existsSync, list = dir => readdirSync(dir) } = {}) {
  const roots = new Set(items.filter(i => i.repo !== 'none' && i.root).map(i => i.root))
  for (const parent of new Set([...roots].map(r => dirname(r)))) {
    let names = []
    try {
      names = list(parent)
    } catch {}
    for (const name of names) roots.add(join(parent, name))
  }
  return [...roots]
    .filter(root => exists(join(root, '.git')))
    .sort()
    .map(root => ({ repo: basename(root), root }))
}

// How the viewer hands an item to an agent, as the hub's New agent form
// would start a task: one agent per item, in the item's repo. In its own
// worktree it starts from the main checkout; on the current branch, from the
// worktree or folder the item was added in. Undefined when none of those is
// on disk any more. Outside git there is no worktree to make, so the spec
// says worktree: false.
export const HANDOFF_MODELS = ['opus', 'sonnet', 'haiku']

// Whether the item's repo is a git repo still, which claude -w needs.
export const inGit = (item, exists = existsSync) => item.repo !== 'none' && !!item.root && exists(join(item.root, '.git'))

// Where an item's agent works: its own repo, or, for an item added outside
// git, the folder the viewer has open (`here`: repoOf's fields plus folder).
// That folder's repo stands in, without the branch the item was added on.
export function handoffPlace(item, here, exists = existsSync) {
  if (inGit(item, exists) || !here?.folder) return item
  return { ...item, root: here.root, worktree: here.worktree, cwd: here.folder, repo: here.repo, branch: '' }
}

export function handoffSpec(item, { runAs = 'tab', worktree = true, model = 'opus', mode = 'auto', effort = 'medium' } = {}, exists = existsSync) {
  worktree = worktree && inGit(item, exists)
  const places = worktree ? [item.root, item.worktree, item.cwd] : [item.worktree, item.cwd, item.root]
  const cwd = places.find(d => d && exists(d))
  if (!cwd) return undefined
  // The id keeps two agents on similar titles from sharing a worktree.
  const name = slug(`${slug(item.title).split('-').slice(0, 4).join(' ')} ${item.id}`)
  const about = [`todo ${item.id}`, `a ${item.cat} in ${item.repo}`, item.branch && `added on ${item.branch}`].filter(Boolean).join(', ')
  // One line: a tab agent's command is typed into a shell, where a newline
  // would run it early.
  const prompt = [
    `Work on this item from my todo list (${about}): ${item.title.replace(/[.!?]+$/, '')}.`,
    item.note && item.note.trim().replace(/([^.!?])$/, '$1.'),
    // Settings › Todo › Worktree rules.
    worktree && instructions('todo-worktree'),
    `Once it's finished, mark it done: ~/.config/ghostty/bin/ghostty-todo done ${item.id}`,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s*\n\s*/g, ' ')
  return { kind: 'task', agent: 'todo-handoff', cwd, name, prompt, runAs, worktree, model, mode, effort }
}

// The filer's whole job, so it files this one item and touches nothing else;
// dontAsk denies every tool but the read-only search and the add.
// `cli` is the ghostty-todo the filer runs.
export const filerPrompt = (item, repos, roots, cli) => `You file one todo and then stop. The user's message after "add todo:" describes it.
Write a title of at most about 50 characters that says what to do. Pick one category: bug (something is broken), feature (something new to build), follow-up (unfinished work), docs, question (something to decide or find out) or other. When the message makes it clear, also pick one type: research (find something out), decide (make a call), action (do or build something), review (judge someone's work, like a PR) or chore (upkeep); otherwise leave --type out. Write a note of one to three sentences only when the title doesn't say it all, keeping what the message says about where and why. Don't add causes, fixes or details the message doesn't give.
Then decide which repo it belongs in. Search for the right one, even when it was sent from a repo: the user often types a todo in one tab about another repo, or about no repo at all. Bugs and features almost always belong in a repo, and other categories often do too. Errands and anything else not about code (buy coffee filters, book a dentist) belong in none.
It was sent from ${item.repo === 'none' ? `${item.root}, outside any repo` : `the ${item.repo} repo (${item.root})`}. These git repos are on disk, in ${roots.join(', ') || '(no known folders)'}:
${repos.map(r => `${r.repo}: ${r.root}`).join('\n') || '(none)'}
When the message names one, even loosely ("my dotfiles", "pixel mcp" for pixel-mcp), that's the repo. Otherwise search these repos for what the message is about with Grep, Glob, Read and ls: the feature, tool, file or command it mentions. The user's words often aren't the code's, so grep for its key words and the other names the code may use for the same thing (a task bar app may be a tray, panel, widget or plasmoid), and read the READMEs and docs of the repos that match. Skip node_modules and other vendored folders. Keep it to a handful of searches.
Pass --dir <the repo's path, from the list above> when one repo clearly holds what the message is about, even the one it was sent from. Pass --dir none when it isn't about code, or when you searched and no repo holds it.
Then run this one command, once:
${cli} add --filing ${item.id} --dir <repo path or none> --cat <category> [--type <type>] --note "<note>" <title>
Search only to find the repo: don't work on the item.`

// What the filer is sent (Settings › Prompts): the system prompt above with
// your instructions after it, and the message with its skill first.
export const filerSystem = (item, repos, roots, cli) => [filerPrompt(item, repos, roots, cli), instructions('todo-filing')].filter(Boolean).join('\n')
export const filerSkill = () => skillOf('todo-filing')
export const filerMessage = text => [filerSkill() && `/${filerSkill()}`, `add todo: ${text}`].filter(Boolean).join(' ')
