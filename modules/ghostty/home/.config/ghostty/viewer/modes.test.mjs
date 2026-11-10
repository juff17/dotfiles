import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { load } from '../hub/settings.mjs'
import { FIRST_EXIT, onModes, paneModes, popupOpens, startMode, tabs } from './modes.mjs'

const MODES_JS = fileURLToPath(new URL('./modes.mjs', import.meta.url))

function saved(values) {
  const file = join(mkdtempSync(join(tmpdir(), 'modes-')), 'settings.json')
  writeFileSync(file, JSON.stringify(values))
  return file
}

const LAZYGIT = { id: 'x-lazygit', name: 'lazygit', cmd: 'lazygit -p .', on: true }

test('the modes on are the list’s order, added ones with their command', () => {
  const v = load(saved({ 'workspace.modes': [{ id: 'todo', on: true }, { id: 'files', on: false }, LAZYGIT] }))
  assert.deepEqual(
    onModes(v).map(m => [m.id, m.name, m.cmd]),
    [
      ['todo', 'Todo', ''],
      ['x-lazygit', 'lazygit', 'lazygit -p .'],
      ['diff', 'Diff', ''],
      ['diagrams', 'Diagrams', ''],
    ],
  )
})

test('the pane opens in the mode Settings names, or the first on when that one is off', () => {
  assert.equal(startMode(load(saved({}))), 'files')
  assert.equal(startMode(load(saved({ 'workspace.startMode': 'todo' }))), 'todo')
  const off = load(saved({ 'workspace.startMode': 'files', 'workspace.modes': [{ id: 'files', on: false }, { id: 'diff', on: true }] }))
  assert.equal(startMode(off), 'diff')
})

test('a popup key opens while its mode is off, unless Settings turns it off too', () => {
  const modes = [{ id: 'todo', on: false }, { id: 'files', on: true }]
  assert.equal(popupOpens('todo', load(saved({ 'workspace.modes': modes }))), true)
  assert.equal(popupOpens('todo', load(saved({ 'workspace.modes': modes, 'workspace.popupsWhenOff': 'off' }))), false)
  assert.equal(popupOpens('diagrams', load(saved({ 'workspace.modes': modes, 'workspace.popupsWhenOff': 'off' }))), true)
})

test('a view in the pane switches by its tab’s exit code, Tab to the next round the list', () => {
  const pane = paneModes('Diff', { GV_MODES: 'Files\tDiff\tTodo', GV_AT: '2', GV_QUIT: '10' })
  assert.deepEqual(tabs(pane).map(t => t.label), [' Files ', ' Diff ', ' Todo '])
  assert.equal(pane.at, 2)
  assert.equal(pane.next, FIRST_EXIT)
  assert.equal(pane.exitOf(1), FIRST_EXIT + 1)
  assert.equal(pane.exitOf(2), 0, 'its own tab')
  assert.equal(pane.exitOf(-1), 0, 'no tab')
  assert.equal(pane.quit, 10)
})

test('a view on its own, or alone in the pane, switches nowhere', () => {
  const own = paneModes('Diff', {})
  assert.deepEqual([own.names, own.next, own.quit, own.exitOf(0)], [['Diff'], 0, 0, 0])
  assert.equal(paneModes('Diff', { GV_MODES: 'Files\tDiff', GV_AT: '7' }).alone, true, 'out of range')
  assert.equal(paneModes('Diff', { GV_MODES: 'Diff', GV_AT: '0' }).next, 0)
})

test('the script lists the modes on for bin/ghostty-viewer, a line each', () => {
  const env = { ...process.env, AGENT_HUB_SETTINGS: saved({ 'workspace.modes': [{ id: 'diff', on: true }, LAZYGIT, { id: 'files', on: false }] }) }
  const run = (...args) => execFileSync(process.execPath, [MODES_JS, ...args], { env, encoding: 'utf8' })
  assert.equal(run('list'), 'diff\tDiff\t\nx-lazygit\tlazygit\tlazygit -p .\ntodo\tTodo\t\ndiagrams\tDiagrams\t\n')
  assert.equal(run('start'), 'diff\n')
})
