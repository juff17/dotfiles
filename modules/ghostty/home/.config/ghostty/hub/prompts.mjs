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
]
export const agent = id => AGENTS.find(a => a.id === id)

export const fileOf = id => join(promptsDir(), `${id}.md`)

// What a file starts as, and goes back to when cleared.
export const header = id =>
  `<!-- Your instructions for ${agent(id).about}: ${
    id === 'todo-filing' ? 'added to its system prompt after the fixed one' : 'sent after the fixed prompt, joined into one line'
  }. Settings › Prompts edits this file. -->\n`

// Your instructions for an agent, without comments; '' when there are none.
export function instructions(id) {
  try {
    return readFileSync(fileOf(id), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
  } catch {
    return ''
  }
}

// The file to edit, made with its header if it isn't there yet.
export function ensureFile(id) {
  const file = fileOf(id)
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, header(id))
  }
  return file
}

export function clear(id) {
  mkdirSync(promptsDir(), { recursive: true })
  writeFileSync(fileOf(id), header(id))
}

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
