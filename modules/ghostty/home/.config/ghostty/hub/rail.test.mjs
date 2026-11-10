// node --test modules/ghostty/home/.config/ghostty/hub/rail.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frame, pressed } from './railview.mjs'
import { width } from './term.mjs'

const ACTS = { work: 'work', hub: 'hub', newAgent: 'new', help: 'help', settings: 'set' }
const none = { needs: 0, working: 0, done: 0, idle: 0 }
const text = line => line.replace(/\x1b\[[0-9;]*m/g, '')
const by = buttons => Object.fromEntries(buttons.map(b => [b.act, [b.y1, b.y2]]))

test('work and hub sit at the top, + new, ? help and ⚙ set at the bottom', () => {
  const { lines, buttons } = frame(6, 30, 'work', none, ACTS)
  assert.equal(lines.length, 30)
  assert.deepEqual(by(buttons), { work: [2, 3], hub: [5, 6], new: [22, 23], help: [25, 26], set: [28, 29] })
  assert.equal(text(lines[1]).trim(), '▣')
  assert.equal(text(lines[5]).trim(), 'hub')
  assert.equal(text(lines[2]).trim(), 'work')
  assert.equal(text(lines[21]).trim(), '+')
  assert.equal(text(lines[22]).trim(), 'new')
  assert.equal(text(lines[25]).trim(), 'help')
  assert.equal(text(lines[27]).trim(), '⚙')
  assert.equal(text(lines[28]).trim(), 'set')
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

test('the bottom buttons fit exactly at 24 rows', () => {
  const { lines, buttons } = frame(6, 24, 'work', none, ACTS)
  assert.deepEqual(by(buttons), { work: [2, 3], hub: [5, 6], new: [16, 17], help: [19, 20], set: [22, 23] })
  assert.equal(text(lines[22]).trim(), 'set')
})

test('a short rail drops ⚙ set, then ? help, then + new, rather than drawing past its edge', () => {
  for (const h of [6, 9, 13, 14, 15, 17, 18, 20, 21]) {
    const { lines, buttons } = frame(6, h, 'work', none, ACTS)
    assert.equal(lines.length, h)
    for (const b of buttons) assert.ok(b.y2 <= h, `${b.act} ends at ${b.y2} of ${h}`)
  }
  const top = { work: [2, 3], hub: [5, 6] }
  assert.deepEqual(by(frame(6, 20, 'work', none, ACTS).buttons), { ...top, new: [15, 16], help: [18, 19] })
  assert.deepEqual(by(frame(6, 18, 'work', none, ACTS).buttons), { ...top, new: [13, 14], help: [16, 17] })
  assert.deepEqual(by(frame(6, 17, 'work', none, ACTS).buttons), { ...top, new: [15, 16] })
  assert.deepEqual(by(frame(6, 15, 'work', none, ACTS).buttons), { ...top, new: [13, 14] })
  assert.deepEqual(by(frame(6, 14, 'work', none, ACTS).buttons), top)
  // Too short even for hub: only what's drawn whole is clickable.
  assert.deepEqual(by(frame(6, 5, 'work', none, ACTS).buttons), { work: [2, 3] })
  assert.equal(pressed(frame(6, 14, 'work', none, ACTS).buttons, { button: 0, x: 1, y: 13 }), null)
})

test('a left press on a button\'s rows presses it, wherever the column', () => {
  const { buttons } = frame(6, 30, 'work', none, ACTS)
  assert.equal(pressed(buttons, { button: 0, x: 1, y: 2 }).act, 'work')
  assert.equal(pressed(buttons, { button: 0, x: 6, y: 3 }).act, 'work')
  assert.equal(pressed(buttons, { button: 0, x: 3, y: 6 }).act, 'hub')
  assert.equal(pressed(buttons, { button: 0, x: 3, y: 23 }).act, 'new')
  assert.equal(pressed(buttons, { button: 0, x: 3, y: 25 }).act, 'help')
  assert.equal(pressed(buttons, { button: 0, x: 3, y: 29 }).act, 'set')
  // The gaps between buttons and the counts press nothing.
  for (const y of [1, 4, 7, 8, 10, 24, 27, 30]) assert.equal(pressed(buttons, { button: 0, x: 3, y }), null, `row ${y}`)
})

test('releases, other buttons, the wheel and drags press nothing', () => {
  const { buttons } = frame(6, 30, 'work', none, ACTS)
  for (const m of [{ button: 0, up: true }, { button: 1 }, { button: 2 }, { button: 64 }, { button: 65 }, { button: 32 }])
    assert.equal(pressed(buttons, { x: 1, y: 2, ...m }), null, JSON.stringify(m))
})
