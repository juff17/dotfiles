import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { launch } from './model.mjs'
import { compose, fileOf, instructions, promptsDir } from './prompts.mjs'
import { filerSystem, handoffSpec } from '../viewer/todo.mjs'

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  process.env.AGENT_HUB_SETTINGS = join(dir, 'settings.json')
  process.env.AGENT_HUB_PROMPTS = join(dir, 'prompts')
})
const write = (id, text) => {
  mkdirSync(promptsDir(), { recursive: true })
  writeFileSync(fileOf(id), text)
}

test('instructions leave out comments and blank space, and read as none when missing', () => {
  assert.equal(instructions('task'), '')
  write('task', '<!-- about this file -->\n\n  Be brief.\n<!-- more\nnotes -->\n')
  assert.equal(instructions('task'), 'Be brief.')
})

test('compose puts your instructions after the prompt, on one line', () => {
  assert.equal(compose('task', 'fix the page'), 'fix the page')
  write('task', 'Run the tests.\nKeep it small.')
  assert.equal(compose('task', 'fix the page'), 'fix the page Run the tests. Keep it small.')
})

test('launch adds a task’s or a hand-off’s instructions, and nothing to a monitor', () => {
  write('task', 'TASK RULES')
  write('todo-handoff', 'HANDOFF RULES')
  const task = launch({ kind: 'task', cwd: '/p', prompt: 'write docs', runAs: 'bg' })
  assert.equal(task.argv.at(-1), 'write docs TASK RULES')
  assert.equal(task.name, 'write-docs', 'the name comes from what you typed')
  const item = { id: 'k2x', title: 'Fix it', note: '', cat: 'bug', repo: 'dot', branch: '', root: '/r', worktree: '', cwd: '/r' }
  const handoff = launch(handoffSpec(item, { runAs: 'bg' }, () => true))
  assert.match(handoff.argv.at(-1), /^Work on this item .* HANDOFF RULES$/)
  assert.doesNotMatch(handoff.argv.at(-1), /TASK RULES/, 'a hand-off isn’t a task from New agent')
  assert.equal(launch({ kind: 'pr', cwd: '/p', target: 'https://x/pull/1' }).argv.at(-1), '/pr-babysit https://x/pull/1')
  assert.equal(launch({ kind: 'logs', cwd: '/p', target: 'docker logs api' }).argv.at(-1), '/logger watch docker logs api')
})

test('the filer gets its instructions after its system prompt, lines kept', () => {
  const item = { id: 'k2x', repo: 'dot', root: '/r' }
  const bare = filerSystem(item, [], [], 'ghostty-todo')
  write('todo-filing', 'Prefer the dotfiles repo.\nNever file under none.')
  assert.equal(filerSystem(item, [], [], 'ghostty-todo'), `${bare}\nPrefer the dotfiles repo.\nNever file under none.`)
})
