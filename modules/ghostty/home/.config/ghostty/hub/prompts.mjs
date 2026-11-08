// What each kind of agent is told, beyond the part the code builds: the skill
// its prompt runs through, and your own instructions after it. The ⚙ panel's
// Prompts section changes both. A prompt is sent as
//   /<skill> <the fixed part> <your instructions>
// where the fixed part is what the agent is for (the task you typed, a todo's
// hand-off, `/pr-babysit <link>`) and stays out of reach. PR babysit and the
// log watcher are their skill, so theirs can't change.
//
// Your instructions are a Markdown file per agent in prompts/ beside hub/, in
// the dotfiles repo: Node follows install.sh's links to this module's real
// path, so an edit lands in the repo and git keeps it. HTML comments in a
// file are left out, so each can say what it's for. The skill picked is a
// setting (hub/settings.mjs, the prompts.* keys).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { load } from './settings.mjs'

// AGENT_HUB_PROMPTS and AGENT_HUB_SKILLS point these elsewhere, for tests.
// Each is read on every call.
export const promptsDir = () => process.env.AGENT_HUB_PROMPTS || join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')
export const skillsDir = () =>
  process.env.AGENT_HUB_SKILLS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills')

// `skillKey` is the setting that picks the skill; `linked` is the one skill
// an agent always runs.
export const AGENTS = [
  { id: 'task', name: 'Task', skillKey: 'prompts.task.skill', about: 'a task started from New agent' },
  { id: 'pr-babysit', name: 'PR babysit', linked: 'pr-babysit', about: 'a babysitter started from New agent' },
  { id: 'logger', name: 'Log watcher', linked: 'logger', about: 'a log watcher started from New agent' },
  { id: 'todo-handoff', name: 'Todo hand-off', skillKey: 'prompts.handoff.skill', about: 'each todo handed to an agent with w' },
  { id: 'todo-filing', name: 'Todo filing', skillKey: 'prompts.filing.skill', about: 'the Claude that files a todo typed with a' },
  // Part of the hand-off's prompt, there only when its agent gets its own
  // worktree: merging is your call, and the worktree may still hold work you
  // want, so by default the agent asks before doing either.
  {
    id: 'todo-worktree',
    name: 'Worktree rules',
    partOf: 'todo-handoff',
    about: 'a todo hand-off whose agent gets its own worktree',
    default:
      "When the work is ready, commit it in the worktree and ask me whether to merge it; never merge unasked.\nAfter it's merged, ask me whether to remove the worktree; never remove it unasked.",
  },
]
export const agent = id => AGENTS.find(a => a.id === id)

export const fileOf = id => join(promptsDir(), `${id}.md`)

// What a file starts as, and goes back to when cleared.
const HOW = {
  'todo-filing': 'added to its system prompt after the fixed one',
  'todo-worktree': 'sent after the hand-off’s prompt, joined into one line; empty sends none',
}
export const header = id =>
  `<!-- Your instructions for ${agent(id).about}: ${HOW[id] ?? 'sent after the fixed prompt, joined into one line'}. Settings edits this file, on the agent's row. -->\n`

// Your instructions for an agent, without comments; with no file, its
// default, else none ('').
export function instructions(id) {
  try {
    return readFileSync(fileOf(id), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
  } catch {
    return agent(id).default ?? ''
  }
}

export const defaultOf = id => agent(id).default ?? ''

// Your instructions for an agent, saved under the file's header; none
// leaves just the header.
export function save(id, text) {
  mkdirSync(promptsDir(), { recursive: true })
  const body = text.trim()
  writeFileSync(fileOf(id), `${header(id)}${body ? `${body}\n` : ''}`)
}

// Back to the default, or to none for an agent without one.
export const clear = id => save(id, defaultOf(id))

// The skills that can be picked: each folder in ~/.claude/skills with a
// SKILL.md, by name.
export function skills() {
  try {
    return readdirSync(skillsDir(), { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(skillsDir(), d.name, 'SKILL.md')))
      .map(d => d.name)
      .sort()
  } catch {
    return []
  }
}

// The skill an agent's prompt runs through, or '' for none.
export function skillOf(id) {
  const a = agent(id)
  if (a.linked) return a.linked
  const v = load()[a.skillKey]
  return v && v !== 'none' ? v : ''
}

// ←/→ on an agent's skill: the next one round none and the skills on disk.
// One no longer on disk stays in the ring while it's picked.
export function stepSkill(current, dir, names = skills()) {
  const ring = ['none', ...names]
  if (!ring.includes(current)) ring.push(current)
  const i = ring.indexOf(current)
  return ring[(i + dir + ring.length) % ring.length]
}

const oneLine = s => s.replace(/\s*\n\s*/g, ' ').trim()

// The prompt an agent is sent, from its fixed part: on one line, as a tab
// agent's command is typed into a shell, where a newline would run it early.
// The linked skill is in the fixed part already (`/pr-babysit <link>`).
export function compose(id, fixed) {
  const a = agent(id)
  const skill = a.linked ? '' : skillOf(id)
  return [skill && `/${skill}`, oneLine(fixed), oneLine(instructions(id))].filter(Boolean).join(' ')
}
