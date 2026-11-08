import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FILTER_ROW, NAV, TOP, fitScroll, footerHints, keyWidth, onKey, onMouse, onPaste, pick, scrollBy, shown, start } from './help-nav.mjs'
import { SECTIONS, filter, startAt } from './help.mjs'

const LAST = SECTIONS.length - 1
// A state with room to scroll, as drawing leaves it.
const at = (fields = {}) => ({ ...start(), maxScroll: 10, ...fields })
const press = (s, ...keys) => keys.map(k => onKey(s, k, 4))
const click = (s, x, y, button = 0, up = false) => onMouse(s, { button, x, y, up })

test('opens on the section for its window, with no filter', () => {
  assert.deepEqual(start('hub'), { sel: startAt('hub'), query: '', typing: false, scroll: 0, maxScroll: 0 })
  assert.equal(start(undefined).sel, startAt(undefined))
})

test('shows the selected section, or every match while filtering', () => {
  assert.deepEqual(shown(at({ sel: 2 })), [SECTIONS[2]])
  assert.deepEqual(shown(at({ query: 'close' })), filter('close'))
  // Only spaces is no filter.
  assert.deepEqual(shown(at({ sel: 1, query: '   ' })), [SECTIONS[1]])
})

test('the key column is 15 to 22 cells', () => {
  const g = (...keys) => [{ keys: keys.map(key => ({ key })) }]
  assert.equal(keyWidth(g('j')), 15)
  assert.equal(keyWidth(g('a'.repeat(15))), 18)
  assert.equal(keyWidth(g('a'.repeat(40))), 22)
  assert.equal(keyWidth([]), 15)
  // Measured in cells, so a wide character counts twice.
  assert.equal(keyWidth(g('界'.repeat(8))), 19)
})

test('drawing pulls the scroll back when the body got shorter', () => {
  const s = at({ scroll: 8 })
  fitScroll(s, 30, 25)
  assert.deepEqual([s.scroll, s.maxScroll], [5, 5])
  fitScroll(s, 10, 25)
  assert.deepEqual([s.scroll, s.maxScroll], [0, 0])
})

test('scrolling stays between the top and the furthest', () => {
  const s = at()
  scrollBy(s, -3)
  assert.equal(s.scroll, 0)
  scrollBy(s, 4)
  assert.equal(s.scroll, 4)
  scrollBy(s, 100)
  assert.equal(s.scroll, 10)
  scrollBy(s, -Infinity)
  assert.equal(s.scroll, 0)
})

test('picking a section clears the filter and scroll, and stays in the list', () => {
  const s = at({ query: 'x', typing: true, scroll: 3 })
  pick(s, 99)
  assert.deepEqual(s, at({ sel: LAST }))
  pick(s, -1)
  assert.equal(s.sel, 0)
})

test('j and k move between sections, stopping at the ends', () => {
  const s = at({ sel: 0 })
  press(s, 'k')
  assert.equal(s.sel, 0)
  press(s, 'j', '\x1b[B')
  assert.equal(s.sel, 2)
  press(s, '\x1b[A')
  assert.equal(s.sel, 1)
  press(s, 'G')
  assert.equal(s.sel, LAST)
  press(s, 'j')
  assert.equal(s.sel, LAST)
  press(s, 'g')
  assert.equal(s.sel, 0)
})

test('Tab and Shift+Tab go round the sections', () => {
  const s = at({ sel: LAST })
  press(s, '\t')
  assert.equal(s.sel, 0)
  press(s, '\x1b[Z')
  assert.equal(s.sel, LAST)
})

test('while filtering, j and k scroll the matches instead', () => {
  const s = at({ sel: 2, query: 'close' })
  press(s, 'j', 'j', '\x1b[B')
  assert.deepEqual([s.sel, s.scroll, s.query], [2, 3, 'close'])
  press(s, 'k')
  assert.equal(s.scroll, 2)
  press(s, 'G')
  assert.equal(s.scroll, 10)
  press(s, 'g')
  assert.equal(s.scroll, 0)
})

test('J, K and the page keys scroll either way', () => {
  const s = at()
  press(s, 'J', 'J')
  assert.equal(s.scroll, 2)
  press(s, '\x04')
  assert.equal(s.scroll, 6)
  press(s, '\x1b[5~')
  assert.equal(s.scroll, 2)
  press(s, 'K', '\x15')
  assert.equal(s.scroll, 0)
  press(s, '\x1b[6~', '\x1b[6~', '\x1b[6~')
  assert.equal(s.scroll, 10)
})

test('q, Ctrl+C and Alt+H close; Esc closes only without a filter', () => {
  assert.deepEqual(press(at(), 'q'), [true])
  assert.deepEqual(press(at(), '\x03'), [true])
  assert.deepEqual(press(at(), '\x1bh'), [true])
  assert.deepEqual(press(at(), '\x1b'), [true])
  const s = at({ sel: 3, query: 'tab', scroll: 2 })
  assert.deepEqual(press(s, '\x1b'), [false])
  assert.deepEqual(s, at({ sel: 3 }))
})

test('other keys do nothing', () => {
  const s = at({ sel: 1 })
  assert.deepEqual(press(s, 'z', '\x1b[C', 'constructor'), [false, false, false])
  assert.deepEqual(s, at({ sel: 1 }))
})

test('/ starts typing, and typed keys go into the filter, even q and j', () => {
  const s = at()
  press(s, '/', 't', 'q', 'j', ' ', 'é')
  assert.deepEqual([s.typing, s.query], [true, 'tqj é'])
})

test('Alt+H and Ctrl+C still close while typing', () => {
  assert.deepEqual(press(at({ typing: true }), '\x1bh'), [true])
  assert.deepEqual(press(at({ typing: true }), '\x03'), [true])
})

test('Backspace drops one character, even a wide one', () => {
  const s = at({ typing: true, query: 'ab界🙂' })
  press(s, '\x7f')
  assert.equal(s.query, 'ab界')
  press(s, '\b', '\x7f', '\x7f', '\x7f')
  assert.equal(s.query, '')
})

test('Ctrl+W drops the last word, Ctrl+U the lot', () => {
  const s = at({ typing: true, query: 'close tab ' })
  press(s, '\x17')
  assert.equal(s.query, 'close ')
  press(s, '\x17')
  assert.equal(s.query, '')
  s.query = 'one two'
  press(s, '\x15')
  assert.equal(s.query, '')
})

test('Enter keeps the filter; Esc while typing clears it', () => {
  const s = at({ typing: true, query: 'tab' })
  press(s, '\r')
  assert.deepEqual([s.typing, s.query], [false, 'tab'])
  press(s, '/', '\x1b')
  assert.deepEqual([s.typing, s.query], [false, ''])
})

test('editing the filter scrolls back to the top; arrows scroll without editing', () => {
  const s = at({ typing: true, query: 'a', scroll: 5 })
  press(s, '\x1b[B', '\x1b[B')
  assert.deepEqual([s.scroll, s.query], [7, 'a'])
  press(s, '\x1b[A')
  assert.equal(s.scroll, 6)
  press(s, 'b')
  assert.deepEqual([s.scroll, s.query], [0, 'ab'])
})

test('while typing, other escape sequences and controls are ignored', () => {
  const s = at({ typing: true, query: 'a', scroll: 5 })
  press(s, '\x1b[C', '\x1b[6~', '\x01', '\t')
  assert.deepEqual([s.query, s.scroll, s.typing], ['a', 5, true])
})

test('the wheel scrolls three rows', () => {
  const s = at()
  click(s, 50, 10, 65)
  assert.equal(s.scroll, 3)
  click(s, 50, 10, 64)
  assert.equal(s.scroll, 0)
})

test('a click on the left picks that section', () => {
  const s = at({ query: 'x', typing: true })
  click(s, 1, TOP + 1)
  assert.equal(s.sel, 0)
  click(s, NAV - 1, TOP + 3)
  assert.deepEqual([s.sel, s.query, s.typing], [2, '', false])
  click(s, 5, TOP + 1 + LAST)
  assert.equal(s.sel, LAST)
})

test('clicks past the sections, on the right, released or not the left button do nothing', () => {
  const s = at({ sel: 1 })
  click(s, 5, TOP + 1 + SECTIONS.length)
  click(s, 5, TOP)
  click(s, NAV, TOP + 1)
  click(s, 5, TOP + 1, 0, true)
  click(s, 5, TOP + 1, 2)
  click(s, 5, TOP + 1, 32)
  assert.deepEqual(s, at({ sel: 1 }))
})

test('a click on the filter row starts typing', () => {
  const s = at()
  click(s, 60, FILTER_ROW)
  assert.equal(s.typing, true)
})

test('a paste goes into the filter only while typing, on one line', () => {
  const s = at()
  onPaste(s, 'tab')
  assert.equal(s.query, '')
  s.typing = true
  onPaste(s, 'new\n  tab\t')
  assert.equal(s.query, 'new tab ')
})

test('the footer says what j, k and esc do now', () => {
  assert.deepEqual(footerHints(at()), [
    ['j k', 'section'],
    ['/', 'filter'],
    ['esc', 'close'],
  ])
  assert.deepEqual(footerHints(at({ query: 'x' })), [
    ['j k', 'scroll'],
    ['/', 'filter'],
    ['esc', 'clear'],
  ])
  assert.deepEqual(footerHints(at({ typing: true })), [
    ['↵', 'keep'],
    ['esc', 'clear'],
    ['↑ ↓', 'scroll'],
  ])
})
