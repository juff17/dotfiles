import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { tokens } from '../hub/term.mjs'
import { SECTIONS, get, row, set } from '../hub/settings.mjs'
import * as nav from './settings-nav.mjs'
import { P } from '../hub/term.mjs'
import { AGENTS, fileOf, header, instructions } from '../hub/prompts.mjs'
import { current, fixedPart, fullPrompt, items, onKey, start, wrap } from './settings-nav.mjs'

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

// Each test gets its own empty settings file and prompts folder, and two
// skills on disk.
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-nav-'))
  process.env.AGENT_HUB_SETTINGS = join(dir, 'settings.json')
  process.env.AGENT_HUB_PROMPTS = join(dir, 'prompts')
  process.env.AGENT_HUB_SKILLS = join(dir, 'skills')
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(dir, 'skills', name), { recursive: true })
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), '')
  }
  mkdirSync(join(dir, 'skills', 'not-a-skill'))
})

// A state on the setting `key`, as ↑↓ and tab would leave it.
function on(key) {
  const sec = SECTIONS.findIndex(s => s.rows.some(r => r.key === key))
  const s = start(SECTIONS[sec].id)
  s.sel = items(s).findIndex(r => r.key === key)
  return s
}
const press = (s, ...keys) => keys.map(k => onKey(s, k))

test('← lowers a number and → raises it, a step at a time', () => {
  const key = 'layout.diagramsPercent'
  const s = on(key)
  const { default: def, step } = row(key)
  press(s, LEFT)
  assert.equal(get(key), def - step)
  press(s, LEFT, LEFT)
  assert.equal(get(key), def - 3 * step)
  press(s, RIGHT)
  assert.equal(get(key), def - 2 * step)
  press(s, 'l')
  assert.equal(get(key), def - step)
  press(s, 'h')
  assert.equal(get(key), def - 2 * step)
})

test('a number stops at the ends of its range', () => {
  const key = 'layout.diagramsPercent'
  const s = on(key)
  set(key, row(key).min)
  press(s, LEFT)
  assert.equal(get(key), row(key).min)
  set(key, row(key).max)
  press(s, RIGHT)
  assert.equal(get(key), row(key).max)
})

test('← and → walk a choice back and on, round the list', () => {
  const key = 'newAgent.task.model'
  const s = on(key)
  const values = row(key).choices.map(c => c.value)
  const at = values.indexOf(row(key).default)
  press(s, RIGHT)
  assert.equal(get(key), values[(at + 1) % values.length])
  press(s, LEFT, LEFT)
  assert.equal(get(key), values[(at - 1 + values.length) % values.length])
})

test('on a row of flags ← and → pick a flag, and space turns it over', () => {
  const key = 'hub.broke'
  const s = on(key)
  const values = row(key).choices.map(c => c.value)
  press(s, RIGHT, RIGHT)
  assert.equal(s.flag, 2)
  press(s, LEFT, LEFT, LEFT)
  assert.equal(s.flag, values.length - 1)
  assert.deepEqual(get(key), row(key).default)
  press(s, ' ')
  assert.deepEqual(get(key), values.slice(0, -1))
})

test('space turns a switch over, and r puts it back', () => {
  const key = 'hub.askStopMonitor'
  const s = on(key)
  press(s, ' ')
  assert.equal(get(key), !row(key).default)
  press(s, 'r')
  assert.equal(get(key), row(key).default)
})

test('↑ and ↓ move between settings, stopping at the ends', () => {
  const s = start(SECTIONS[0].id)
  press(s, DOWN, DOWN)
  assert.equal(s.sel, 2)
  press(s, UP)
  assert.equal(s.sel, 1)
  press(s, UP, UP)
  assert.equal(s.sel, 0)
  press(s, 'G', DOWN)
  assert.equal(current(s), items(s).at(-1))
})

test('tab and shift+tab move between sections, round the list', () => {
  const s = start(SECTIONS[0].id)
  press(s, DOWN, '\t')
  assert.deepEqual([s.sec, s.sel], [1, 0])
  press(s, '\x1b[Z', '\x1b[Z')
  assert.equal(s.sec, SECTIONS.length - 1)
})

test('esc, q, ctrl+c and alt+s close it; other keys don’t', () => {
  for (const k of ['\x1b', 'q', '\x03', '\x1bs']) assert.equal(onKey(start(), k), 'quit', JSON.stringify(k))
  for (const k of [LEFT, RIGHT, UP, DOWN, ' ', 'x', 'e', 'v']) assert.equal(onKey(start(), k), undefined, JSON.stringify(k))
})

test('a failed save shows in the footer and leaves the value', () => {
  // Its folder is a file, so the folder can't be made.
  const file = join(mkdtempSync(join(tmpdir(), 'settings-nav-')), 'file')
  writeFileSync(file, '')
  process.env.AGENT_HUB_SETTINGS = join(file, 'settings.json')
  const s = on('layout.diagramsPercent')
  press(s, LEFT)
  assert.match(s.note.text, /^Couldn't save/)
  assert.equal(get('layout.diagramsPercent'), row('layout.diagramsPercent').default)
})

// Clicks used to step a value forward wherever they landed, ‹ included, so
// the panel takes keys only now.
test('takes no clicks: a click is a mouse report, never a key', () => {
  assert.equal(nav.onMouse, undefined)
  const click = [...tokens('\x1b[<0;60;8M\x1b[<0;60;8m')]
  assert.equal(click.length, 2)
  assert.ok(click.every(t => t.mouse && !t.key))
})

// The Prompts section, on agent `id`.
function onAgent(id) {
  const s = start('prompts')
  s.sel = AGENTS.findIndex(a => a.id === id)
  return s
}
const write = (id, text) => {
  mkdirSync(process.env.AGENT_HUB_PROMPTS, { recursive: true })
  writeFileSync(fileOf(id), `${header(id)}${text}`)
}

test('Prompts lists the agents, and ↑↓ moves between them', () => {
  const s = start('prompts')
  assert.deepEqual(items(s), AGENTS)
  press(s, DOWN, DOWN)
  assert.equal(current(s).id, AGENTS[2].id)
})

test('← and → walk an agent’s skill round none and the skills on disk', () => {
  const s = onAgent('todo-handoff')
  press(s, RIGHT)
  assert.equal(get('prompts.handoff.skill'), 'alpha')
  press(s, RIGHT, RIGHT)
  assert.equal(get('prompts.handoff.skill'), 'none')
  press(s, LEFT)
  assert.equal(get('prompts.handoff.skill'), 'beta')
})

test('an agent linked to its skill has none to pick', () => {
  const s = onAgent('pr-babysit')
  press(s, RIGHT, LEFT)
  for (const r of SECTIONS.find(x => x.id === 'prompts').rows) assert.equal(get(r.key), 'none')
  assert.equal(s.note, null)
})

test('e asks for the editor, on an agent and in its open prompt', () => {
  const s = onAgent('task')
  assert.equal(onKey(s, 'e'), 'edit')
  press(s, 'v')
  assert.equal(s.view, 'task')
  assert.equal(onKey(s, 'e'), 'edit')
})

test('v or ↵ opens an agent’s whole prompt; esc goes back, not out', () => {
  const s = onAgent('logger')
  press(s, '\r')
  assert.equal(s.view, 'logger')
  press(s, DOWN, DOWN, UP)
  assert.equal(s.viewScroll, 1)
  assert.equal(onKey(s, '\x1b'), undefined)
  assert.equal(s.view, null)
  press(s, 'v')
  assert.equal(onKey(s, 'q'), undefined)
  assert.equal(s.view, null)
  assert.equal(onKey(s, '\x1bs'), 'quit', 'alt+s still closes the panel')
})

test('r clears your instructions only on a second r in a row', () => {
  const s = onAgent('todo-handoff')
  write('todo-handoff', 'Run the tests first.')
  press(s, 'r')
  assert.equal(instructions('todo-handoff'), 'Run the tests first.')
  assert.equal(s.note.color, P.peach)
  press(s, DOWN, 'r', UP)
  assert.equal(instructions('todo-handoff'), 'Run the tests first.', 'another key in between cancels it')
  assert.equal(s.note, null)
  press(s, 'r', 'r')
  assert.equal(instructions('todo-handoff'), '')
  assert.equal(readFileSync(fileOf('todo-handoff'), 'utf8'), header('todo-handoff'))
})

test('r with no instructions does nothing', () => {
  const s = onAgent('task')
  press(s, 'r', 'r')
  assert.equal(s.note, null)
})

test('the whole prompt puts the skill first and your instructions last', () => {
  write('todo-handoff', 'Run ./test.sh before you commit.\nKeep commits small.')
  const s = onAgent('todo-handoff')
  press(s, RIGHT)
  const [part] = fullPrompt('todo-handoff')
  assert.match(part.text, /^\/alpha Work on this item from my todo list \(todo \{id\}/)
  assert.match(part.text, /ghostty-todo done \{id\} Run \.\/test\.sh before you commit\. Keep commits small\.$/)
  assert.doesNotMatch(part.text, /\n/)
})

test('a linked agent’s prompt is its skill and target, then yours', () => {
  write('pr-babysit', "Don't rebase on your own.")
  assert.deepEqual(fullPrompt('pr-babysit'), [{ tag: 'AS SENT', text: "/pr-babysit {target} Don't rebase on your own." }])
})

test('the filer gets your instructions in its system prompt and the skill in its message', () => {
  write('todo-filing', 'Prefer the dotfiles repo.')
  const s = onAgent('todo-filing')
  press(s, RIGHT, RIGHT)
  const [system, message] = fullPrompt('todo-filing')
  assert.ok(system.text.startsWith(fixedPart('todo-filing')))
  assert.ok(system.text.endsWith('\nPrefer the dotfiles repo.'))
  assert.equal(message.text, '/beta add todo: {what you typed}')
})

test('wrap cuts text at spaces, and a long word where the line ends', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four'])
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrap('a\nb', 10), ['a', 'b'])
})
