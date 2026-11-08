import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DIACRITICS, deleteImage, gridRow, placeGrid, transmitFile } from './kitty.mjs'
import { MAX_GRID } from './view.mjs'

// The commands wrap themselves for tmux by $TMUX at the time of the call.
const inTmux = (t, on) => {
  const was = process.env.TMUX
  if (on) process.env.TMUX = '/tmp/tmux-1000/default,1,0'
  else delete process.env.TMUX
  t.after(() => {
    if (was === undefined) delete process.env.TMUX
    else process.env.TMUX = was
  })
}

test('transmitting a file sends its path in base64, quietly', t => {
  inTmux(t, false)
  const path = '/home/me/.cache/claude-diagram-pane/a b.png'
  assert.equal(transmitFile(1, path), `\x1b_Ga=t,t=f,f=100,i=1,q=2;${Buffer.from(path).toString('base64')}\x1b\\`)
})

test('a path outside ASCII goes as its UTF-8 bytes', t => {
  inTmux(t, false)
  const payload = transmitFile(2, '/tmp/día.png').slice('\x1b_Ga=t,t=f,f=100,i=2,q=2;'.length, -2)
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), '/tmp/día.png')
})

test('commands without a payload have no ;', t => {
  inTmux(t, false)
  assert.equal(placeGrid(1, 2, 30, 40), '\x1b_Ga=p,U=1,i=1,p=2,c=30,r=40,q=2\x1b\\')
  assert.equal(deleteImage(2), '\x1b_Ga=d,d=I,i=2,q=2\x1b\\')
})

test('inside tmux a command is wrapped with every escape doubled', t => {
  inTmux(t, true)
  assert.equal(deleteImage(1), '\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=1,q=2\x1b\x1b\\\x1b\\')
  const wrapped = transmitFile(1, '/x.png')
  assert.ok(wrapped.startsWith('\x1bPtmux;\x1b\x1b_G'))
  assert.ok(wrapped.endsWith('\x1b\x1b\\\x1b\\'))
  // The only lone escapes are the wrapper's own.
  assert.equal(wrapped.slice(7, -2).replaceAll('\x1b\x1b', '').includes('\x1b'), false)
})

test('the diacritics are the spec table, as many as the grid allows', () => {
  assert.equal(DIACRITICS.length, 297)
  assert.equal(DIACRITICS.length, MAX_GRID)
  assert.equal(new Set(DIACRITICS).size, DIACRITICS.length)
  assert.equal(DIACRITICS[0], '̅')
  assert.equal(DIACRITICS[1], '̍')
  assert.equal(DIACRITICS[2], '̎')
  assert.equal(DIACRITICS.at(-1), '\u{1d244}')
  const points = DIACRITICS.map(d => d.codePointAt(0))
  assert.deepEqual(
    points,
    [...points].sort((a, b) => a - b),
  )
})

test('a grid row is placeholders numbered by row and column, colored by ids', () => {
  const s = gridRow(3, 2, 1, 4, 2)
  const P = '\u{10EEEE}'
  assert.equal(s, `\x1b[38;5;3;58;5;2m${P}${DIACRITICS[1]}${DIACRITICS[4]}${P}${DIACRITICS[1]}${DIACRITICS[5]}\x1b[39;59m`)
})

test('a row of no cells is just the colors', () => {
  assert.equal(gridRow(1, 1, 0, 0, 0), '\x1b[38;5;1;58;5;1m\x1b[39;59m')
})

test('the last grid cell still has a diacritic', () => {
  const s = gridRow(1, 1, MAX_GRID - 1, MAX_GRID - 1, 1)
  assert.equal(s.includes('undefined'), false)
  assert.ok(s.includes(DIACRITICS[MAX_GRID - 1]))
})
