// node --test modules/ghostty/home/.config/ghostty/hub/term.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wrap } from './term.mjs'

const text = lines => lines.map(l => l.map(([t]) => t).join(''))

test('wrap breaks at spaces, keeping each span its style', () => {
  const lines = wrap([['Close tab 2 (Hub peek)?  ', 'B'], ['y', 'T'], [' yes', 'S']], 12)
  assert.deepEqual(text(lines), ['Close tab 2', '(Hub peek)?', 'y yes'])
  assert.deepEqual(lines[2], [['y', 'T'], [' yes', 'S']])
})

test('a word made of spans with no space between stays on one line', () => {
  assert.deepEqual(text(wrap([['ab ', ''], ['c', 'x'], ['d', 'y']], 3)), ['ab', 'cd'])
})

test('a line that fits stays whole, its leading space kept', () => {
  assert.deepEqual(text(wrap([[' all here', '']], 20)), [' all here'])
})

test('past max lines, the rest joins the last line', () => {
  assert.deepEqual(text(wrap([['one two three four', '']], 5, 2)), ['one', 'two three four'])
})

test('nothing to wrap is one empty line', () => {
  assert.deepEqual(wrap([], 10), [[]])
})
