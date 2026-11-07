import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compose, frameBox, slice } from './backdrop.mjs'

test('the frame takes its share of the screen, centered', () => {
  assert.deepEqual(frameBox(200, 60, 85), { left: 15, top: 4, w: 170, h: 51 })
})

test('a small screen gives the frame all of it', () => {
  assert.deepEqual(frameBox(60, 40, 85), { left: 0, top: 0, w: 60, h: 40 })
  assert.deepEqual(frameBox(200, 60, 100), { left: 0, top: 0, w: 200, h: 60 })
})

test('panes land where tmux draws them, with dividers between', () => {
  const grid = compose(
    [
      { left: 0, top: 0, width: 5, height: 1, lines: ['top'] },
      { left: 0, top: 2, width: 2, height: 1, lines: ['ab'] },
      { left: 3, top: 2, width: 2, height: 1, lines: ['cdef'] },
    ],
    5,
    3,
  )
  assert.deepEqual(
    grid.map(r => r.join('')),
    ['top  ', '─────', 'ab│cd'],
  )
})

test('picture placeholders become blanks', () => {
  const cell = '\u{10EEEE}̅̅'
  const grid = compose([{ left: 0, top: 0, width: 4, height: 1, lines: [`a${cell}${cell}b`] }], 4, 1)
  assert.equal(grid[0].join(''), 'a  b')
})

test('a wide character cut by a slice end becomes a blank', () => {
  const grid = compose([{ left: 0, top: 0, width: 4, height: 1, lines: ['a漢b'] }], 4, 1)
  assert.equal(slice(grid[0], 0, 4), 'a漢b')
  assert.equal(slice(grid[0], 0, 2), 'a ')
  assert.equal(slice(grid[0], 2, 4), ' b')
})
