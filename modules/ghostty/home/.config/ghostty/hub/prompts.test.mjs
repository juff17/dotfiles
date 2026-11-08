import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { launch } from './model.mjs'
import { AGENTS, clear, compose, ensureFile, fileOf, header, instructions, skillOf, skills, stepSkill } from './prompts.mjs'
import { set } from './settings.mjs'
import { handoffSpec } from '../viewer/todo.mjs'

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  process.env.AGENT_HUB_SETTINGS = join(dir, 'settings.json')
  process.env.AGENT_HUB_PROMPTS = join(dir, 'prompts')
  process.env.AGENT_HUB_SKILLS = join(dir, 'skills')
})
const write = (id, text) => {
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  writeFileSync(fileOf(id), text)
}

test('every agent with a skill to pick has its setting', () => {
  for (const a of AGENTS) assert.ok(a.linked || a.skillKey, a.id)
  for (const a of AGENTS.filter(x => x.skillKey)) assert.equal(skillOf(a.id), '')
})

test('instructions leave out comments and blank space, and read as none when missing', () => {
  assert.equal(instructions('task'), '')
  write('task', '<!-- about this file -->\n\n  Be brief.\n<!-- more\nnotes -->\n')
  assert.equal(instructions('task'), 'Be brief.')
})

test('a new or cleared file holds just its header', () => {
  const file = ensureFile('logger')
  assert.equal(readFileSync(file, 'utf8'), header('logger'))
  assert.equal(instructions('logger'), '')
  write('logger', 'x')
  ensureFile('logger')
  assert.equal(instructions('logger'), 'x', 'ensureFile leaves a file that’s there')
  clear('logger')
  assert.equal(readFileSync(file, 'utf8'), header('logger'))
})

test('skills are the folders with a SKILL.md, sorted', () => {
  assert.deepEqual(skills(), [])
  for (const name of ['zed', 'alpha', 'empty']) mkdirSync(join(dir, 'skills', name), { recursive: true })
  for (const name of ['zed', 'alpha']) writeFileSync(join(dir, 'skills', name, 'SKILL.md'), '')
  assert.deepEqual(skills(), ['alpha', 'zed'])
})

test('stepSkill goes round none and the skills, keeping one gone from disk', () => {
  assert.equal(stepSkill('none', 1, ['a', 'b']), 'a')
  assert.equal(stepSkill('none', -1, ['a', 'b']), 'b')
  assert.equal(stepSkill('b', 1, ['a', 'b']), 'none')
  assert.equal(stepSkill('gone', 1, ['a']), 'none')
  assert.equal(stepSkill('a', 1, []), 'none')
})

test('compose: skill, the fixed part, then your instructions, on one line', () => {
  assert.equal(compose('task', 'fix the page'), 'fix the page')
  write('task', 'Run the tests.\nKeep it small.')
  set('prompts.task.skill', 'ticket-implement')
  assert.equal(compose('task', 'fix the page'), '/ticket-implement fix the page Run the tests. Keep it small.')
})

test('a linked agent keeps its own skill and takes no other', () => {
  set('prompts.task.skill', 'other')
  write('pr-babysit', 'No rebasing.')
  assert.equal(compose('pr-babysit', '/pr-babysit https://x/pull/1'), '/pr-babysit https://x/pull/1 No rebasing.')
})

test('launch sends each agent its own skill and instructions', () => {
  write('task', 'TASK RULES')
  write('todo-handoff', 'HANDOFF RULES')
  write('logger', 'LOG RULES')
  set('prompts.task.skill', 'tsk')
  const task = launch({ kind: 'task', cwd: '/p', prompt: 'write docs', runAs: 'bg' })
  assert.equal(task.argv.at(-1), '/tsk write docs TASK RULES')
  assert.equal(task.name, 'write-docs', 'the name comes from what you typed')
  const logs = launch({ kind: 'logs', cwd: '/p', target: 'docker compose logs api' })
  assert.equal(logs.argv.at(-1), '/logger watch docker compose logs api LOG RULES')
  const item = { id: 'k2x', title: 'Fix it', note: '', cat: 'bug', repo: 'dot', branch: '', root: '/r', worktree: '', cwd: '/r' }
  const handoff = launch(handoffSpec(item, { runAs: 'bg' }, () => true))
  assert.match(handoff.argv.at(-1), /^Work on this item .* HANDOFF RULES$/)
  assert.doesNotMatch(handoff.argv.at(-1), /TASK RULES|\/tsk/, 'a hand-off isn’t a task from New agent')
})
