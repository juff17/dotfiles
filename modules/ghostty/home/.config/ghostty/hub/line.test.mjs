// node --test modules/ghostty/home/.config/ghostty/hub/line.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as line from './line.mjs'
import { width } from './term.mjs'

test('the arrows move the caret, and keys type and delete where it is', () => {
  const run = (text, at, ...keys) => keys.reduce((s, k) => line.editLine(s.text, s.at, k), { text, at })
  assert.deepEqual(run('fix', undefined, '\x1b[D'), { text: 'fix', at: 2 })
  assert.deepEqual(run('fix', undefined, '\x1b[D', '\x1b[D', 'o'), { text: 'foix', at: 2 })
  assert.deepEqual(run('fix', 0, '\x1b[D'), { text: 'fix', at: 0 }, 'left stops at the start')
  assert.deepEqual(run('fix', undefined, '\x1b[C'), { text: 'fix', at: 3 }, 'right stops at the end')
  assert.deepEqual(run('fix', 1, '\x7f'), { text: 'ix', at: 0 })
  assert.deepEqual(run('fix', 0, '\x7f'), { text: 'fix', at: 0 })
  assert.deepEqual(run('fix', 1, '\x1b[3~'), { text: 'fx', at: 1 }, 'Delete takes the one under the caret')
  assert.deepEqual(run('fix', 1, '\x1b[H'), { text: 'fix', at: 0 })
  assert.deepEqual(run('fix', 1, '\x01'), { text: 'fix', at: 0 })
  assert.deepEqual(run('fix', 1, '\x1b[F'), { text: 'fix', at: 3 })
  assert.deepEqual(run('fix', 1, '\x05'), { text: 'fix', at: 3 })
  assert.deepEqual(run('fix the bug', 8, '\x15'), { text: 'bug', at: 0 }, 'Ctrl+U clears what is before the caret')
  assert.deepEqual(run('fix the bug', 3, '\x0b'), { text: 'fix', at: 3 }, 'Ctrl+K clears what is after it')
  assert.deepEqual(run('fix the bug', 8, '\x17'), { text: 'fix bug', at: 4 })
  assert.deepEqual(run('fix the bug', undefined, '\x1b[1;5D'), { text: 'fix the bug', at: 8 })
  assert.deepEqual(run('fix the bug', 8, '\x1bb'), { text: 'fix the bug', at: 4 })
  assert.deepEqual(run('fix the bug', 0, '\x1b[1;5C', '\x1bf'), { text: 'fix the bug', at: 7 })
})

test('the caret steps over a wide character whole, and never onto a zero-width mark', () => {
  const run = (text, at, ...keys) => keys.reduce((s, k) => line.editLine(s.text, s.at, k), { text, at })
  assert.deepEqual(run('漢字', undefined, '\x1b[D'), { text: '漢字', at: 1 })
  assert.deepEqual(run('漢字', undefined, '\x1b[D', 'x'), { text: '漢x字', at: 2 })
  assert.deepEqual(run('ok 😀!', undefined, '\x1b[D', '\x7f'), { text: 'ok !', at: 3 })
  assert.deepEqual(run('éx', 0, '\x1b[C'), { text: 'éx', at: 2 }, 'over the accent with its letter')
  assert.deepEqual(run('éx', 2, '\x1b[D'), { text: 'éx', at: 0 })
})

test('the caret is drawn over the character it is on, or after the end', () => {
  const draw = (text, at, w = 40) => {
    const { before, under, after } = line.caretParts(text, at, w)
    return `${before}\x1b[7m${under}\x1b[27m${after}`
  }
  const cells = p => width(p.before + p.under + p.after)
  assert.equal(draw('fix', 1), 'f\x1b[7mi\x1b[27mx')
  assert.equal(draw('fix', undefined), 'fix\x1b[7m \x1b[27m')
  assert.equal(draw('漢字', 1), '漢\x1b[7m字\x1b[27m', 'a wide character whole')
  assert.equal(draw('éx', 0), '\x1b[7mé\x1b[27mx', 'with its accent')
  // Too long: the caret stays in sight wherever it is.
  const long = 'abcdefghijklmnopqrstuvwxyz'
  assert.equal(draw(long, undefined, 6), 'vwxyz\x1b[7m \x1b[27m')
  assert.equal(draw(long, 0, 6), '\x1b[7ma\x1b[27mbcdef')
  assert.equal(draw(long, 13, 6), 'jklm\x1b[7mn\x1b[27mo')
  assert.equal(draw('ab漢字cd', 3, 5), '漢\x1b[7m字\x1b[27mc', 'wide characters by their cells')
  for (const text of [long, '漢字かなカナ漢字かな'])
    for (const at of [0, 3, 5, 9, undefined]) assert.ok(cells(line.caretParts(text, at, 6)) <= 6, `${text} at ${at}`)
  assert.equal(line.caretShown(line.withCaret('fix', 1)), 'f\x1b[7mi\x1b[27mx')
  assert.equal(line.caretShown(line.withCaret('fix', 3)), 'fix\x1b[7m \x1b[27m')
})

test('pasted text goes in at the caret, an emoji as one step', () => {
  assert.deepEqual(line.insertAt('fix', 1, 'oo'), { text: 'fooix', at: 3 })
  assert.deepEqual(line.insertAt('ab', undefined, '😀'), { text: 'ab😀', at: 3 })
  assert.deepEqual(line.splitAt('a😀b', 2), ['a😀', 'b'])
  assert.deepEqual(line.splitAt('ab', undefined), ['ab', ''])
})
