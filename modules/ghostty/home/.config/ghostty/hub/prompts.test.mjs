import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { launch } from './model.mjs'
import { AGENTS, compose, fileOf, instructions, promptsDir } from './prompts.mjs'
import { handoffSpec } from '../viewer/todo.mjs'

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
  assert.match(handoff.argv.at(-1), /^Before anything else, make your own worktree .* Work on this item .* HANDOFF RULES$/)
  assert.doesNotMatch(handoff.argv.at(-1), /TASK RULES/, 'a hand-off isn’t a task from New agent')
  assert.equal(launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://x/pull/1' }).argv.at(-1), '/pr-babysit https://x/pull/1')
  assert.equal(launch({ kind: 'monitor', skill: 'logs', cwd: '/p', target: 'docker logs api' }).argv.at(-1), '/logger watch docker logs api')
})

const REPO_PROMPTS = fileURLToPath(new URL('../prompts', import.meta.url))

test('the repo keeps an example for each agent’s instructions, with nothing to send', () => {
  for (const id of AGENTS) {
    const example = join(REPO_PROMPTS, `${id}.md.example`)
    assert.ok(existsSync(example), example)
    process.env.AGENT_HUB_PROMPTS = mkdtempSync(join(tmpdir(), 'prompts-'))
    writeFileSync(fileOf(id), readFileSync(example))
    assert.equal(instructions(id), '', `${id}.md.example is only a comment`)
  }
})

test('install copies the examples once, leaving your own files alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  writeFileSync(join(dir, 'task.md.example'), 'example task')
  writeFileSync(join(dir, 'todo-handoff.md.example'), 'example hand-off')
  writeFileSync(join(dir, 'todo-handoff.md'), 'mine')
  const lib = fileURLToPath(new URL('../bin/ghostty-lib.sh', import.meta.url))
  const copy = () => execFileSync('bash', ['-c', 'source "$1"; copy_prompt_examples "$2"', 'bash', lib, dir])
  copy()
  assert.equal(readFileSync(join(dir, 'task.md'), 'utf8'), 'example task')
  assert.equal(readFileSync(join(dir, 'todo-handoff.md'), 'utf8'), 'mine')
  writeFileSync(join(dir, 'task.md'), 'edited')
  copy()
  assert.equal(readFileSync(join(dir, 'task.md'), 'utf8'), 'edited', 'a second install keeps your edits')
})
