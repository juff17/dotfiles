// node --test modules/ghostty/home/.config/ghostty/hub/keys.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DIAGRAMS_KEY, KEYS, NEW_AGENT_KEY, OPEN_AGENT_KEY, PEEK_CLOSING_KEY, answerConfirm, filterKey, hitAt, keyAction, mouseAction } from './keys.mjs'
import { tokens } from './term.mjs'

test('every board key names its action', () => {
  assert.deepEqual(KEYS, {
    h: 'laneLeft',
    l: 'laneRight',
    '\x1b[D': 'laneLeft',
    '\x1b[C': 'laneRight',
    j: 'down',
    k: 'up',
    '\x1b[B': 'down',
    '\x1b[A': 'up',
    '\t': 'tab',
    '\r': 'open',
    a: 'allow',
    d: 'deny',
    e: 'reviewed',
    E: 'reviewAll',
    o: 'goToTab',
    x: 'close',
    '\x18': 'close',
    n: 'new',
    '/': 'filter',
    '\x1b': 'back',
    q: 'workspace',
  })
})

test('keys without a binding, and names off Object, do nothing', () => {
  for (const k of ['z', 'H', 'J', ' ', '\x7f', '\x1b[H', 'toString', 'constructor', '__proto__']) assert.equal(keyAction(k), null, k)
  assert.equal(keyAction('j'), 'down')
})

test('the keys the layout and the tray send arrive as one token each', () => {
  const keys = [NEW_AGENT_KEY, PEEK_CLOSING_KEY, OPEN_AGENT_KEY, DIAGRAMS_KEY]
  assert.deepEqual(new Set(keys).size, 4)
  assert.deepEqual([...tokens(`j${keys.join('')}k`)].map(t => t.key), ['j', ...keys, 'k'])
  for (const k of keys) assert.equal(keyAction(k), null)
})

test('a question: y yes, n or any other key no', () => {
  const c = { text: 'Close tab 1?' }
  assert.deepEqual(answerConfirm(c, 'y'), { yes: true, remember: null })
  for (const k of ['n', 'Y', 'a', '\r', '\x1b', 'j']) assert.deepEqual(answerConfirm(c, k), { yes: false, remember: null }, k)
})

test('a question you can skip: a says yes and remembers not to ask', () => {
  const c = { text: 'Stop monitor?', skip: 'stop-monitor' }
  assert.deepEqual(answerConfirm(c, 'a'), { yes: true, remember: 'stop-monitor' })
  assert.deepEqual(answerConfirm(c, 'y'), { yes: true, remember: null })
  assert.deepEqual(answerConfirm(c, 'n'), { yes: false, remember: null })
})

test('the filter: typing adds, backspace takes off, enter keeps it, esc clears it', () => {
  let s = { filter: '', filtering: true }
  for (const k of ['r', 'a', 'i', 'X']) s = filterKey(s.filter, k)
  assert.deepEqual(s, { filter: 'raiX', filtering: true })
  s = filterKey(s.filter, '\x7f')
  assert.deepEqual(s, { filter: 'rai', filtering: true })
  assert.deepEqual(filterKey(s.filter, '\r'), { filter: 'rai', filtering: false })
  assert.deepEqual(filterKey(s.filter, '\x1b'), { filter: '', filtering: false })
  assert.deepEqual(filterKey('', '\x7f'), { filter: '', filtering: true })
})

test('the filter ignores ↑, ↓, tab and other control keys, and takes j and k as letters', () => {
  for (const k of ['\x1b[A', '\x1b[B', '\t', '\x02']) assert.deepEqual(filterKey('ab', k), { filter: 'ab', filtering: true }, JSON.stringify(k))
  assert.equal(filterKey('', 'j').filter, 'j')
  assert.equal(filterKey('a', ' ').filter, 'a ')
  assert.equal(filterKey('', 'é').filter, 'é')
})

test('in the filter ← and → move the caret, and keys type and delete there', () => {
  assert.deepEqual(filterKey('rai', '\x1b[D'), { filter: 'rai', filtering: true, at: 2 })
  assert.deepEqual(filterKey('rai', 'n', 2), { filter: 'rani', filtering: true, at: 3 })
  assert.deepEqual(filterKey('rani', '\x1b[C', 3), { filter: 'rani', filtering: true }, 'at the end the caret goes')
  assert.deepEqual(filterKey('ab😀', '\x7f'), { filter: 'ab', filtering: true }, 'an emoji goes whole')
  assert.deepEqual(filterKey('rai', '\x1b', 1), { filter: '', filtering: false })
})

test('the wheel moves the selection: down a step, up a step', () => {
  assert.deepEqual(mouseAction({ button: 65, up: false }), { wheel: 1 })
  assert.deepEqual(mouseAction({ button: 64, up: false }), { wheel: -1 })
})

test('a left press clicks; releases, other buttons and drags do not', () => {
  assert.deepEqual(mouseAction({ button: 0, up: false }), { click: true })
  // Shift, Alt and Ctrl held (4, 8, 16) still click.
  assert.deepEqual(mouseAction({ button: 16, up: false }), { click: true })
  assert.equal(mouseAction({ button: 0, up: true }), null)
  assert.equal(mouseAction({ button: 1, up: false }), null)
  assert.equal(mouseAction({ button: 2, up: false }), null)
  assert.equal(mouseAction({ button: 32, up: false }), null)
})

test('a click finds the region under it, edges included; the wheel only lanes', () => {
  const button = { x1: 90, x2: 100, y1: 1, y2: 1 }
  const card = { x1: 1, x2: 22, y1: 4, y2: 7, wheel: 0 }
  const lane3 = { x1: 25, x2: 46, y1: 4, y2: 7, wheel: 1 }
  const hits = [button, card, lane3]
  assert.equal(hitAt(hits, 90, 1), button)
  assert.equal(hitAt(hits, 100, 1), button)
  assert.equal(hitAt(hits, 89, 1), undefined)
  assert.equal(hitAt(hits, 22, 7), card)
  assert.equal(hitAt(hits, 23, 5), undefined)
  assert.equal(hitAt(hits, 30, 5, true), lane3)
  assert.equal(hitAt(hits, 95, 1, true), undefined)
  assert.equal(hitAt([], 1, 1), undefined)
})
