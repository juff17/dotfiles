// node --test modules/ghostty/home/.config/ghostty/hub/rail.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frame, pressed } from './railview.mjs'
import { width } from './term.mjs'

const ACTS = { work: 'work', hub: 'hub', newAgent: 'new', help: 'help' }
const none = { needs: 0, working: 0, done: 0, idle: 0 }
const text = line => line.replace(/\x1b\[[0-9;]*m/g, '')
const by = buttons => Object.fromEntries(buttons.map(b => [b.act, [b.y1, b.y2]]))

test('work and hub sit at the top, + new and ? help at the bottom', () => {
  const { lines, buttons } = frame(6, 30, 'work', none, ACTS)
  assert.equal(lines.length, 30)
  assert.deepEqual(by(buttons), { work: [2, 3], hub: [5, 6], new: [23, 25], help: [27, 29] })
  assert.equal(text(lines[1]).trim(), '▣')
  assert.equal(text(lines[2]).trim(), 'work')
  assert.equal(text(lines[23]).trim(), 'new')
  assert.equal(text(lines[24]).trim(), 'alt+n')
  assert.equal(text(lines[28]).trim(), 'alt+h')
  for (const l of lines) assert.equal(width(text(l)), 6)
})

test('the counts sit under the buttons, in lane order', () => {
  const { lines } = frame(6, 30, 'hub', { needs: 2, working: 3, done: 1, idle: 4 }, ACTS)
  assert.deepEqual(lines.slice(8, 12).map(l => text(l).trim()), ['▲ 2', '✻ 3', '✓ 1', '○ 4'])
})

test('the hub button carries a dot while anything needs you', () => {
  assert.equal(text(frame(6, 30, 'work', none, ACTS).lines[4]).trim(), '◫')
  assert.equal(text(frame(6, 30, 'work', { ...none, needs: 1 }, ACTS).lines[4]).trim(), '◫ ●')
})

test('the window the rail sits in is the highlighted button', () => {
  const work = frame(6, 30, 'work', none, ACTS).lines
  const hub = frame(6, 30, 'hub', none, ACTS).lines
  assert.notEqual(work[1], hub[1])
  assert.notEqual(work[4], hub[4])
  assert.equal(work[1], hub[4].replace('◫', '▣'))
})

test('the bottom buttons fit exactly at 20 rows', () => {
  const { lines, buttons } = frame(6, 20, 'work', none, ACTS)
  assert.deepEqual(by(buttons), { work: [2, 3], hub: [5, 6], new: [13, 15], help: [17, 19] })
  assert.equal(text(lines[18]).trim(), 'alt+h')
})

test('a short rail drops ? help, then + new, rather than drawing past its edge', () => {
  for (const h of [6, 10, 14, 15, 16, 19]) {
    const { lines, buttons } = frame(6, h, 'work', none, ACTS)
    assert.equal(lines.length, h)
    for (const b of buttons) assert.ok(b.y2 <= h, `${b.act} ends at ${b.y2} of ${h}`)
  }
  assert.deepEqual(by(frame(6, 19, 'work', none, ACTS).buttons), { work: [2, 3], hub: [5, 6], new: [16, 18] })
  assert.equal(text(frame(6, 19, 'work', none, ACTS).lines[17]).trim(), 'alt+n')
  assert.deepEqual(by(frame(6, 16, 'work', none, ACTS).buttons), { work: [2, 3], hub: [5, 6], new: [13, 15] })
  assert.deepEqual(by(frame(6, 15, 'work', none, ACTS).buttons), { work: [2, 3], hub: [5, 6] })
  // Too short even for hub: only what's drawn whole is clickable.
  assert.deepEqual(by(frame(6, 5, 'work', none, ACTS).buttons), { work: [2, 3] })
  assert.equal(pressed(frame(6, 14, 'work', none, ACTS).buttons, { button: 0, x: 1, y: 13 }), null)
})

test('a left press on a button\'s rows presses it, wherever the column', () => {
  const { buttons } = frame(6, 30, 'work', none, ACTS)
  assert.equal(pressed(buttons, { button: 0, x: 1, y: 2 }).act, 'work')
  assert.equal(pressed(buttons, { button: 0, x: 6, y: 3 }).act, 'work')
  assert.equal(pressed(buttons, { button: 0, x: 3, y: 6 }).act, 'hub')
  assert.equal(pressed(buttons, { button: 0, x: 3, y: 25 }).act, 'new')
  assert.equal(pressed(buttons, { button: 0, x: 3, y: 27 }).act, 'help')
  // The gaps between buttons and the counts press nothing.
  for (const y of [1, 4, 7, 9, 26, 30]) assert.equal(pressed(buttons, { button: 0, x: 3, y }), null, `row ${y}`)
})

test('releases, other buttons, the wheel and drags press nothing', () => {
  const { buttons } = frame(6, 30, 'work', none, ACTS)
  for (const m of [{ button: 0, up: true }, { button: 1 }, { button: 2 }, { button: 64 }, { button: 65 }, { button: 32 }])
    assert.equal(pressed(buttons, { x: 1, y: 2, ...m }), null, JSON.stringify(m))
})
