import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fromText, insert, layout, textKey, toText } from './textarea.mjs'

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const type = (t, ...keys) => keys.map(k => textKey(t, k))
const at = t => [t.row, t.col]

test('it starts with the cursor at the end of the text', () => {
  const t = fromText('one\ntwo')
  assert.deepEqual(t.lines, ['one', 'two'])
  assert.deepEqual(at(t), [1, 3])
  assert.deepEqual(at(fromText('')), [0, 0])
})

test('typing goes in at the cursor, and ↵ splits the line there', () => {
  const t = fromText('ab')
  type(t, LEFT, 'X', '\r', 'Y')
  assert.equal(toText(t), 'aX\nYb')
  assert.deepEqual(at(t), [1, 1])
})

test('backspace joins a line to the one above at its start; delete joins the next', () => {
  const t = fromText('one\ntwo')
  type(t, '\x01', '\x7f')
  assert.equal(toText(t), 'onetwo')
  assert.deepEqual(at(t), [0, 3])
  type(t, '\r', UP, '\x05', '\x1b[3~')
  assert.equal(toText(t), 'onetwo')
})

test('arrows move across line ends and keep to a shorter line', () => {
  const t = fromText('long line\nab')
  type(t, '\x01', LEFT)
  assert.deepEqual(at(t), [0, 9], '← at a line’s start goes to the end of the one above')
  type(t, RIGHT)
  assert.deepEqual(at(t), [1, 0])
  type(t, '\x05', UP, '\x05', DOWN)
  assert.deepEqual(at(t), [1, 2], '↓ to a shorter line stops at its end')
  type(t, UP, UP, DOWN, DOWN, DOWN)
  assert.deepEqual(at(t), [1, 2], 'nothing past the first or last line')
})

test('ctrl+u drops the line before the cursor and ctrl+w the word before it', () => {
  const t = fromText('keep this\nfix the bug')
  type(t, '\x17')
  assert.equal(toText(t), 'keep this\nfix the ')
  type(t, '\x15')
  assert.equal(toText(t), 'keep this\n')
})

test('ctrl+s saves and esc cancels; other escapes do nothing', () => {
  const t = fromText('x')
  assert.equal(textKey(t, '\x13'), 'save')
  assert.equal(textKey(t, '\x1b'), 'cancel')
  assert.equal(textKey(t, '\x1b[5~'), undefined)
  assert.equal(toText(t), 'x')
})

test('a paste keeps its lines and lands the cursor after it', () => {
  const t = fromText('ab')
  type(t, LEFT)
  insert(t, 'one\r\ntwo\nthree')
  assert.equal(toText(t), 'aone\ntwo\nthreeb')
  assert.deepEqual(at(t), [2, 5])
})

test('characters count whole, emoji included', () => {
  const t = fromText('a😀b')
  type(t, LEFT, '\x7f')
  assert.equal(toText(t), 'ab')
})

test('layout carries a long line on and puts the cursor in its row', () => {
  const t = fromText('abcdefgh\nxy')
  assert.deepEqual(layout(t, 3), { rows: ['abc', 'def', 'gh', 'xy'], cursor: { y: 3, i: 2 } })
  type(t, UP, '\x01', RIGHT, RIGHT, RIGHT)
  assert.deepEqual(layout(t, 3).cursor, { y: 1, i: 0 }, 'at a row’s break it starts the next row')
  const full = fromText('abc')
  assert.deepEqual(layout(full, 3), { rows: ['abc', ''], cursor: { y: 1, i: 0 } }, 'past a full row it takes a new one')
  assert.deepEqual(layout(fromText('😀😀'), 3).rows, ['😀', '😀'], 'a wide character doesn’t split')
})
