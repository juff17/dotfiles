import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { KEY_ROWS, RESERVED, captured, clash, ghosttyConf, layoutConf, statements, tmuxConf, tmuxKey } from './keybinds.mjs'
import { row } from './settings.mjs'

const CONF = readFileSync(layoutConf(), 'utf8')
const defaults = () => Object.fromEntries(KEY_ROWS.map(r => [r.key, r.default]))
const bound = text => text.split('\n').filter(l => l.startsWith('bind -n ')).map(l => l.split(' ')[2])

test('every alt row has its statement in layout.conf, and no default is reserved', () => {
  const all = statements(CONF)
  for (const r of KEY_ROWS.filter(r => r.kind === 'alt')) assert.ok(all.has(tmuxKey(r.default)), r.key)
  for (const r of KEY_ROWS) assert.equal(RESERVED[r.default], undefined, r.key)
})

test('a statement runs over the lines its braces keep open', () => {
  const all = statements('bind -n M-a {\n  one\n  if -F "#{x}" { two }\n}\nbind -n M-b run x\nset -g y')
  assert.equal(all.get('M-a'), 'bind -n M-a {\n  one\n  if -F "#{x}" { two }\n}')
  assert.equal(all.get('M-b'), 'bind -n M-b run x')
})

test('the defaults bind each alt row where layout.conf does', () => {
  assert.deepEqual(bound(tmuxConf(defaults(), CONF)).sort(), KEY_ROWS.filter(r => r.kind === 'alt').map(r => tmuxKey(r.default)).sort())
})

test('a moved key binds the same command at the new key, and an unbound one binds nothing', () => {
  const text = tmuxConf({ ...defaults(), 'keys.help': 'alt+x', 'keys.todo': '' }, CONF)
  const keys = bound(text)
  assert.ok(keys.includes('M-x') && !keys.includes('M-h') && !keys.includes('M-t'))
  assert.match(text, /^bind -n M-x run-shell -b '"#\{@conf\}\/bin\/ghostty-help"/m)
  assert.match(text, /^unbind -q -n M-h$/m)
})

test('an alt key layout.conf binds for something else is never unbound', () => {
  const text = tmuxConf(defaults(), `${CONF}\nbind -n M-q run other\n`)
  assert.doesNotMatch(text, /^unbind -q -n M-q$/m)
  assert.match(text, /^unbind -q -n M-z$/m)
})

test('Ghostty gets lines only for keys moved off their default', () => {
  assert.equal(ghosttyConf(defaults()).split('\n').filter(l => l.startsWith('keybind')).length, 0)
  const lines = ghosttyConf({ ...defaults(), 'keys.newTab': 'ctrl+shift+y', 'keys.closeTab': '' }).split('\n').filter(l => l.startsWith('keybind'))
  assert.deepEqual(lines, ['keybind = ctrl+shift+t=unbind', 'keybind = ctrl+shift+y=csi:9001~', 'keybind = ctrl+shift+w=unbind'])
})

test('a keypress names an alt key with or without alt, and a Ghostty key with or without ctrl', () => {
  const alt = row('keys.help')
  const gh = row('keys.newTab')
  assert.equal(captured(alt, '\x1bx'), 'alt+x')
  assert.equal(captured(alt, 'x'), 'alt+x')
  assert.equal(captured(alt, '\x1bX'), 'alt+x')
  assert.equal(captured(gh, 'y'), 'ctrl+shift+y')
  assert.equal(captured(gh, '\x19'), 'ctrl+shift+y')
  for (const k of ['\x1b[A', '\r', '\t', '-', ' ']) assert.equal(captured(alt, k), null, JSON.stringify(k))
})

test('a key another row or something else has clashes', () => {
  const v = defaults()
  assert.match(clash(row('keys.help'), 'alt+t', v), /Todo popup/)
  assert.match(clash(row('keys.help'), 'alt+a', v), /Approvals popup/)
  assert.match(clash(row('keys.help'), 'alt+p', v), /Claude Code/)
  assert.match(clash(row('keys.newTab'), 'ctrl+shift+c', v), /copy/)
  assert.match(clash(row('keys.help'), 'alt+1', v), /go to a tab/)
  assert.match(clash(row('keys.help'), 'alt+9', v), /go to a tab/)
  assert.equal(clash(row('keys.help'), 'alt+h', v), null)
  assert.equal(clash(row('keys.help'), 'alt+x', v), null)
  assert.equal(clash(row('keys.help'), '', v), null)
})
