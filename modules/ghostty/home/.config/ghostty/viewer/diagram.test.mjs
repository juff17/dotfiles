import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { width } from '../hub/term.mjs'
import {
  TAB_MAX,
  cellAt,
  clampIndex,
  dropPicture,
  dropTab,
  fitHints,
  hints,
  keyAction,
  modeAt,
  newestPane,
  paneFile,
  parseInput,
  picture,
  placeIn,
  pointer,
  reread,
  showFile,
  tabTitle,
  truncate,
} from './diagram.mjs'
import { deleteImage, placeGrid, transmitFile } from './kitty.mjs'

const tmp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'diagram-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// The kitty commands compared here are the plain ones, outside tmux.
const noTmux = t => {
  const was = process.env.TMUX
  delete process.env.TMUX
  t.after(() => {
    if (was !== undefined) process.env.TMUX = was
  })
}

const list = (n, current = 0) => ({ diagrams: Array.from({ length: n }, (_, i) => ({ title: `d${i}` })), current })

test('the tab title names the folder, and the tab name when it differs', () => {
  assert.equal(tabTitle('dotfiles', '2', 'dotfiles'), 'dotfiles · tab 2')
  assert.equal(tabTitle('dotfiles', '2', 'claude'), 'dotfiles · 2:claude')
})

test('a pane file is named by socket and pane id', () => {
  assert.equal(paneFile('/c/panes', 'tabs-1', '%12'), '/c/panes/tabs-1-12.json')
})

test('with nothing to follow, the newest pane file shows', t => {
  const dir = tmp(t)
  assert.equal(newestPane(dir), '')
  for (const [name, at] of [
    ['a.json', 1000],
    ['b.json', 3000],
    ['c.json', 2000],
    ['z.json.tmp', 9000],
    ['notes.txt', 9000],
  ]) {
    writeFileSync(join(dir, name), '{}')
    utimesSync(join(dir, name), at, at)
  }
  assert.equal(newestPane(dir), `${dir}/b.json`)
})

test('a pane file gone before it could be read is skipped', t => {
  const dir = tmp(t)
  writeFileSync(join(dir, 'a.json'), '{}')
  // A dangling link lists like a file but has nothing to stat, as a file
  // removed between the listing and the stat does.
  symlinkSync(join(dir, 'missing'), join(dir, 'gone.json'))
  assert.equal(newestPane(dir), `${dir}/a.json`)
})

test('the index stays in the list, and at 0 when it is empty', () => {
  assert.equal(clampIndex(-1, 3), 0)
  assert.equal(clampIndex(1, 3), 1)
  assert.equal(clampIndex(5, 3), 2)
  assert.equal(clampIndex(2, 0), 0)
})

test('rereading the same list keeps the diagram the user picked', () => {
  assert.equal(reread(list(3, 2), list(3, 2), 0), undefined)
})

test("another tab's file selects its current diagram, even when the lists look alike", () => {
  assert.equal(reread(list(3, 2), list(3, 2), 0, true), 2)
  assert.equal(reread(list(3, 2), list(3, 2), 0, false), undefined)
})

test('the mod moving its current diagram jumps to it', () => {
  assert.equal(reread(list(3, 0), list(3, 1), 0), 1)
})

test('a new diagram jumps to the current one, even past the list', () => {
  assert.equal(reread(list(2, 1), list(3, 2), 0), 2)
  assert.equal(reread(list(2, 1), { diagrams: list(3).diagrams, current: 7 }, 0), 2)
})

test('a diagram going jumps to the current one', () => {
  assert.equal(reread(list(3, 1), list(2, 1), 2), 1)
})

test('the list emptying selects -1, which select clamps to 0', () => {
  assert.equal(reread(list(1, 0), list(0, 0), 0), -1)
  assert.equal(clampIndex(-1, 0), 0)
})

test('an unchanged list whose diagram at the index went still reselects', () => {
  assert.equal(reread(list(3, 0), list(3, 0), 5), 0)
})

test('a pane file without current selects NaN', () => {
  // How it behaves today: select() clamps NaN to NaN, so nothing shows.
  assert.ok(Number.isNaN(reread(list(1, 0), { diagrams: list(1).diagrams }, 0)))
  assert.ok(Number.isNaN(clampIndex(NaN, 1)))
})

test('closing the diagram before the one showing keeps it showing', () => {
  const next = dropTab(list(4, 0), 1, 3)
  assert.deepEqual(
    next.diagrams.map(d => d.title),
    ['d0', 'd2', 'd3'],
  )
  assert.equal(next.current, 2)
})

test('closing the one showing moves to the next, or back from the end', () => {
  assert.equal(dropTab(list(4), 1, 1).current, 1)
  assert.equal(dropTab(list(4), 3, 3).current, 2)
})

test('closing one after the one showing leaves it be', () => {
  assert.equal(dropTab(list(4), 3, 0).current, 0)
})

test('closing the last diagram leaves an empty list at 0', () => {
  assert.deepEqual(dropTab({ ...list(1), extra: true }, 0, 0), { diagrams: [], current: 0, extra: true })
})

test('closing keeps the rest of the pane file', () => {
  assert.equal(dropTab({ ...list(2), session: 's' }, 0, 0).session, 's')
})

test('titles past the chip width end in …', () => {
  const max = 'x'.repeat(TAB_MAX)
  assert.equal(truncate(max), max)
  assert.equal(truncate(`${max}y`), `${'x'.repeat(TAB_MAX - 1)}…`)
  assert.equal(truncate(`${max}y`).length, TAB_MAX)
  assert.equal(truncate(''), '')
})

test('header columns map to modes', () => {
  const modes = [
    { label: ' Diagrams ', exit: 0 },
    { label: ' Files ', exit: 3 },
  ]
  assert.equal(modeAt(modes, 1), modes[0])
  assert.equal(modeAt(modes, 11), undefined)
  assert.equal(modeAt(modes, 12), modes[1])
  assert.equal(modeAt(modes, 18), modes[1])
  assert.equal(modeAt(modes, 19), undefined)
})

test('footer hints drop from the end until they fit, keeping the first', () => {
  const keys = [
    ['[ ]', 'diagrams'],
    ['scroll', 'zoom'],
    ['q', 'quit'],
  ]
  const w = shown => hints(shown).reduce((n, [t]) => n + width(t), 0)
  assert.equal(w(keys), '[ ] diagrams  scroll zoom  q quit'.length)
  assert.equal(fitHints(keys, 100), keys)
  assert.deepEqual(fitHints(keys, w(keys)), keys)
  assert.deepEqual(fitHints(keys, w(keys) - 1), keys.slice(0, 2))
  assert.deepEqual(fitHints(keys, 0), keys.slice(0, 1))
})

test('the first picture takes id 1 and placement 2', t => {
  noTmux(t)
  const pic = picture()
  assert.equal(showFile(pic, '/a.png'), transmitFile(1, '/a.png'))
  assert.equal(placeIn(pic, 30, 40), placeGrid(1, 2, 30, 40))
  assert.deepEqual(pic, { shownId: 1, shownFile: '/a.png', placedGrid: '1 30 40', placedId: 2 })
})

test('the same picture in the same grid sends nothing again', t => {
  noTmux(t)
  const pic = picture()
  showFile(pic, '/a.png')
  placeIn(pic, 30, 40)
  assert.equal(showFile(pic, '/a.png'), '')
  assert.equal(placeIn(pic, 30, 40), '')
})

test('a new grid goes to the other placement', t => {
  noTmux(t)
  const pic = picture()
  showFile(pic, '/a.png')
  placeIn(pic, 30, 40)
  assert.equal(placeIn(pic, 60, 80), placeGrid(1, 1, 60, 80))
  assert.equal(placeIn(pic, 30, 40), placeGrid(1, 2, 30, 40))
})

test('a new picture goes to the other id before the old one is deleted, and is placed again', t => {
  noTmux(t)
  const pic = picture()
  showFile(pic, '/a.png')
  placeIn(pic, 30, 40)
  assert.equal(showFile(pic, '/b.png'), transmitFile(2, '/b.png') + deleteImage(1))
  assert.equal(placeIn(pic, 30, 40), placeGrid(2, 1, 30, 40))
  assert.equal(showFile(pic, '/c.png'), transmitFile(1, '/c.png') + deleteImage(2))
})

test('dropping the picture deletes it once, and the next starts afresh', t => {
  noTmux(t)
  const pic = picture()
  assert.equal(dropPicture(pic), '')
  showFile(pic, '/a.png')
  placeIn(pic, 30, 40)
  assert.equal(dropPicture(pic), deleteImage(1))
  assert.equal(dropPicture(pic), '')
  assert.equal(showFile(pic, '/a.png'), transmitFile(1, '/a.png'))
  // The placement id carries on alternating.
  assert.equal(placeIn(pic, 30, 40), placeGrid(1, 1, 30, 40))
})

test('pointer positions are pixels from the picture region', () => {
  const cell = { cw: 10, ch: 20 }
  // Cell reports: the middle of the cell.
  assert.deepEqual(pointer(1, 3, { left: 0, top: 3, cell, pixelMouse: false }), { px: 5, py: 10 })
  assert.deepEqual(pointer(4, 5, { left: 1, top: 3, cell, pixelMouse: false }), { px: 25, py: 50 })
  // Pixel reports, from 1.
  assert.deepEqual(pointer(1, 41, { left: 0, top: 3, cell, pixelMouse: true }), { px: 0, py: 0 })
  assert.deepEqual(pointer(26, 61, { left: 1, top: 3, cell, pixelMouse: true }), { px: 15, py: 20 })
})

test('a click is in the cell under it', () => {
  const cell = { cw: 10, ch: 20 }
  assert.deepEqual(cellAt(7, 3, { cell, pixelMouse: false }), { col: 7, row: 3 })
  assert.deepEqual(cellAt(1, 1, { cell, pixelMouse: true }), { col: 1, row: 1 })
  assert.deepEqual(cellAt(10, 20, { cell, pixelMouse: true }), { col: 1, row: 1 })
  assert.deepEqual(cellAt(11, 21, { cell, pixelMouse: true }), { col: 2, row: 2 })
})

test('keys map to actions', () => {
  const pane = { frame: false, count: 3 }
  assert.deepEqual(keyAction('q', pane), ['quit'])
  assert.deepEqual(keyAction('\t', pane), ['tab'])
  assert.deepEqual(keyAction('h', pane), ['pan', 1, 0])
  assert.deepEqual(keyAction('\x1b[C', pane), ['pan', -1, 0])
  assert.deepEqual(keyAction('j', pane), ['pan', 0, -1])
  assert.deepEqual(keyAction('+', pane), ['zoom', 1])
  assert.deepEqual(keyAction('=', pane), ['zoom', 1])
  assert.deepEqual(keyAction('-', pane), ['zoom', -1])
  assert.deepEqual(keyAction('0', pane), ['home'])
  assert.deepEqual(keyAction('[', pane), ['step', -1])
  assert.deepEqual(keyAction(']', pane), ['step', 1])
  assert.deepEqual(keyAction('x', pane), ['close'])
  assert.equal(keyAction('z', pane), undefined)
  assert.equal(keyAction('toString', pane), undefined)
})

test('number keys jump only to diagrams there are', () => {
  assert.deepEqual(keyAction('1', { frame: false, count: 3 }), ['jump', 0])
  assert.deepEqual(keyAction('3', { frame: false, count: 3 }), ['jump', 2])
  assert.equal(keyAction('4', { frame: false, count: 3 }), undefined)
  assert.equal(keyAction('1', { frame: false, count: 0 }), undefined)
})

test('Esc and Alt+D close only the diagrams window', () => {
  assert.deepEqual(keyAction('\x1b', { frame: true, count: 0 }), ['quit'])
  assert.deepEqual(keyAction('\x1bd', { frame: true, count: 0 }), ['quit'])
  assert.equal(keyAction('\x1b', { frame: false, count: 0 }), undefined)
  assert.equal(keyAction('\x1bd', { frame: false, count: 0 }), undefined)
})

test('input splits into mouse reports, terminal answers and keys', () => {
  assert.deepEqual([...parseInput('\x1b[<32;40;9M\x1b[6;18;9t\x1b[?1016;1$y\x1b[Dq\x1bd]\x1b')], [
    { mouse: { button: 32, x: 40, y: 9, released: false } },
    { cell: { ch: 18, cw: 9 } },
    { pixels: true },
    { key: '\x1b[D' },
    { key: 'q' },
    { key: '\x1bd' },
    { key: ']' },
    { key: '\x1b' },
  ])
})

test('pixel mouse took when the terminal says set or permanently set', () => {
  const took = n => [...parseInput(`\x1b[?1016;${n}$y`)][0].pixels
  assert.deepEqual([0, 1, 2, 3, 4].map(took), [false, true, false, true, false])
})

test('a cell size answer of 0 is passed on as 0', () => {
  assert.deepEqual([...parseInput('\x1b[6;0;0t')], [{ cell: { ch: 0, cw: 0 } }])
})
