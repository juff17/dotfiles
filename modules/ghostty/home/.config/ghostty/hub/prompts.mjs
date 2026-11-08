// Your own instructions for some kinds of agent, sent after the prompt the
// code builds for them: a task from New agent (after what you typed), a todo
// handed off with w, and the Claude that files a todo typed with a.
//
// They're a Markdown file per agent in prompts/ beside hub/, in the dotfiles
// repo; edit the file to change them. Node follows install.sh's links to this
// module's real path, so the path Settings shows is the repo's. HTML comments
// in a file are left out, so each can say what it's for.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// AGENT_HUB_PROMPTS points this elsewhere, for tests. It's read on every call.
export const promptsDir = () => process.env.AGENT_HUB_PROMPTS || join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export const AGENTS = ['task', 'todo-handoff', 'todo-filing']

export const fileOf = id => join(promptsDir(), `${id}.md`)

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

// The prompt with your instructions after it, on one line: a tab agent's
// command is typed into a shell, where a newline would run it early.
const oneLine = s => s.replace(/\s*\n\s*/g, ' ').trim()
export const compose = (id, prompt) => [oneLine(prompt), oneLine(instructions(id))].filter(Boolean).join(' ')
