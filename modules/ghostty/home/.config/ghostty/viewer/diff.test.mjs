import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { set } from '../hub/settings.mjs'

import {
  MAX_COUNT_BYTES,
  addShare,
  bodyRows,
  cardSize,
  changeCells,
  changeWords,
  clampScroll,
  countLines,
  fit,
  fitPath,
  followCursor,
  keepCursor,
  keyAction,
  modeAt,
  openAfter,
  parseDiff,
  parseInput,
  parseNameStatus,
  parseNumstat,
  parseStatus,
} from './diff.mjs'

// Its own settings file, so the defaults hold until a test changes one.
process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'diff-settings-')), 'settings.json')

const tmp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('status: an empty repo has no files', () => {
  assert.deepEqual(parseStatus(''), [])
})

test('status: each entry, sorted by path, with the status that shows', () => {
  const files = parseStatus(' M z.txt\0M  a.txt\0?? new/file.md\0D  gone.txt\0MM both.txt\0')
  assert.deepEqual(
    files.map(f => [f.path, f.status, f.untracked]),
    [
      ['a.txt', 'M', false],
      ['both.txt', 'M', false],
      ['gone.txt', 'D', false],
      ['new/file.md', '?', true],
      ['z.txt', 'M', false],
    ],
  )
  assert.deepEqual(files[0], { path: 'a.txt', old: undefined, status: 'M', untracked: false, add: 0, del: 0, binary: false })
})

test('status: a staged rename or copy takes the old path from the next entry', () => {
  const files = parseStatus('R  new.txt\0old.txt\0C  copy.txt\0orig.txt\0 M other.txt\0')
  assert.deepEqual(
    files.map(f => [f.path, f.old, f.status]),
    [
      ['copy.txt', 'orig.txt', 'C'],
      ['new.txt', 'old.txt', 'R'],
      ['other.txt', undefined, 'M'],
    ],
  )
})

test('status: an unstaged rename takes the old path too', () => {
  // `git add -N` on a moved file.
  const files = parseStatus(' R new.txt\0old.txt\0 M other.txt\0')
  assert.deepEqual(
    files.map(f => [f.path, f.old, f.status]),
    [
      ['new.txt', 'old.txt', 'R'],
      ['other.txt', undefined, 'M'],
    ],
  )
})

test('status: a conflict on either side shows U', () => {
  const files = parseStatus('UU both.txt\0AU ours.txt\0DU theirs.txt\0')
  assert.deepEqual(
    files.map(f => f.status),
    ['U', 'U', 'U'],
  )
})

test('status: paths with spaces stay whole', () => {
  assert.equal(parseStatus(' M my file.txt\0')[0].path, 'my file.txt')
})

test('numstat: counts per path, a binary file as -', () => {
  const counts = parseNumstat('3\t1\ta.txt\0-\t-\timg.png\0')
  assert.deepEqual(counts.get('a.txt'), { add: 3, del: 1, binary: false })
  assert.deepEqual(counts.get('img.png'), { add: 0, del: 0, binary: true })
  assert.equal(counts.size, 2)
})

test('numstat: a rename is keyed by its new path', () => {
  const counts = parseNumstat('2\t0\t\0old.txt\0new.txt\x005\t5\tnext.txt\0')
  assert.deepEqual(counts.get('new.txt'), { add: 2, del: 0, binary: false })
  assert.equal(counts.has('old.txt'), false)
  assert.deepEqual(counts.get('next.txt'), { add: 5, del: 5, binary: false })
})

test('numstat: nothing changed reads as no counts', () => {
  assert.equal(parseNumstat('').size, 0)
})

test('untracked lines: newlines counted, plus a last line without one', t => {
  const root = tmp(t)
  writeFileSync(join(root, 'three.txt'), 'a\nb\nc\n')
  writeFileSync(join(root, 'open.txt'), 'a\nb')
  writeFileSync(join(root, 'empty.txt'), '')
  const cache = new Map()
  assert.deepEqual(countLines(root, 'three.txt', cache), { add: 3, binary: false })
  assert.deepEqual(countLines(root, 'open.txt', cache), { add: 2, binary: false })
  assert.deepEqual(countLines(root, 'empty.txt', cache), { add: 0, binary: false })
})

test('untracked lines: a NUL byte makes it binary, with no lines', t => {
  const root = tmp(t)
  writeFileSync(join(root, 'bin'), Buffer.from([1, 10, 0, 10]))
  assert.deepEqual(countLines(root, 'bin', new Map()), { add: 0, binary: true })
})

test('untracked lines: too big to read counts as binary, and is not cached', t => {
  const root = tmp(t)
  writeFileSync(join(root, 'big'), Buffer.alloc(MAX_COUNT_BYTES + 1, 10))
  const cache = new Map()
  assert.deepEqual(countLines(root, 'big', cache), { add: 0, binary: true })
  assert.equal(cache.size, 0)
})

test('untracked lines: a missing file counts nothing', t => {
  assert.deepEqual(countLines(tmp(t), 'nope.txt', new Map()), { add: 0, binary: false })
})

test('untracked lines: cached until the size or time changes', t => {
  const root = tmp(t)
  const file = join(root, 'f.txt')
  writeFileSync(file, 'a\nb\n')
  utimesSync(file, 1000, 1000)
  const cache = new Map()
  assert.equal(countLines(root, 'f.txt', cache).add, 2)
  // Same size and time: the cached count stands even though the bytes differ.
  writeFileSync(file, 'abcd')
  utimesSync(file, 1000, 1000)
  assert.equal(countLines(root, 'f.txt', cache).add, 2)
  utimesSync(file, 2000, 2000)
  assert.equal(countLines(root, 'f.txt', cache).add, 1)
  writeFileSync(file, 'a\nb\nc\n')
  assert.equal(countLines(root, 'f.txt', cache).add, 3)
})

test('diff: an empty diff has no rows', () => {
  assert.deepEqual(parseDiff(''), [])
})

test('diff: headers are skipped, lines numbered new for added and context, old for removed', () => {
  const text = [
    'diff --git a/f.txt b/f.txt',
    'index 1111111..2222222 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -10,3 +10,3 @@ function top',
    ' keep',
    '-old',
    '+new',
    ' tail',
    '',
  ].join('\n')
  assert.deepEqual(parseDiff(text), [
    { kind: 'hunk', text: '@@ -10,3 +10,3 @@ function top' },
    { kind: 'ctx', num: 10, text: 'keep' },
    { kind: 'del', num: 11, text: 'old' },
    { kind: 'add', num: 11, text: 'new' },
    { kind: 'ctx', num: 12, text: 'tail' },
  ])
})

test('diff: each hunk restarts the numbers, and a hunk without counts parses', () => {
  const rows = parseDiff('@@ -1 +1 @@\n-a\n+b\n@@ -40,2 +41,2 @@\n x\n')
  assert.deepEqual(
    rows.map(r => [r.kind, r.num]),
    [
      ['hunk', undefined],
      ['del', 1],
      ['add', 1],
      ['hunk', undefined],
      ['ctx', 41],
    ],
  )
})

test('diff: a new file counts from 1', () => {
  const rows = parseDiff('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n')
  assert.deepEqual(
    rows.slice(1).map(r => [r.num, r.text]),
    [
      [1, 'one'],
      [2, 'two'],
    ],
  )
})

test('diff: no newline at end of file becomes a note', () => {
  const rows = parseDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n')
  assert.deepEqual(rows[2], { kind: 'note', text: 'No newline at end of file' })
  assert.deepEqual(rows[3], { kind: 'add', num: 1, text: 'a' })
})

test('diff: a binary file is one note', () => {
  const text = 'diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n'
  assert.deepEqual(parseDiff(text), [{ kind: 'note', text: 'Binary file changed' }])
})

test('diff: a pure rename has no rows', () => {
  const text = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'
  assert.deepEqual(parseDiff(text), [])
})

test('diff: a second file in the diff starts again at its headers', () => {
  const text = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+x',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-a',
    '',
  ].join('\n')
  assert.deepEqual(parseDiff(text), [
    { kind: 'hunk', text: '@@ -0,0 +1 @@' },
    { kind: 'add', num: 1, text: 'x' },
    { kind: 'hunk', text: '@@ -1 +0,0 @@' },
    { kind: 'del', num: 1, text: 'a' },
  ])
})

test('diff: changed lines that look like headers stay lines inside a hunk', () => {
  const rows = parseDiff('@@ -1,2 +1,2 @@\n--- a\n+++ b\n')
  assert.deepEqual(rows.slice(1), [
    { kind: 'del', num: 1, text: '-- a' },
    { kind: 'add', num: 1, text: '++ b' },
  ])
})

test('cursor stays on its file when the list changes', () => {
  const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }]
  assert.equal(keepCursor(files, 'c', 0), 2)
  // Its file went: same place, or the last row when the list got shorter.
  assert.equal(keepCursor(files, 'gone', 1), 1)
  assert.equal(keepCursor(files, 'gone', 9), 2)
  assert.equal(keepCursor([], 'a', 3), 0)
  assert.equal(keepCursor(files, undefined, 0), 0)
})

test('the first file opens when the list fills, and a closed one stays closed', () => {
  const a = [{ path: 'a' }, { path: 'b' }]
  assert.equal(openAfter('', [], a), 'a')
  assert.equal(openAfter('', a, [...a, { path: 'c' }]), '')
  assert.equal(openAfter('b', a, a), 'b')
  assert.equal(openAfter('', [], []), '')
})

test('body rows: the open file has its diff and a gap under it', () => {
  const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }]
  const diff = [{ kind: 'hunk', text: '@@' }, { kind: 'add', num: 1, text: 'x' }]
  assert.deepEqual(bodyRows(files, 'b', diff), [
    { kind: 'file', i: 0 },
    { kind: 'file', i: 1 },
    { kind: 'diff', row: diff[0] },
    { kind: 'diff', row: diff[1] },
    { kind: 'gap' },
    { kind: 'file', i: 2 },
  ])
  assert.equal(bodyRows(files, '', diff).length, 3)
  assert.deepEqual(bodyRows([], 'a', diff), [])
})

test('scroll stops at the top and at the last screenful', () => {
  assert.equal(clampScroll(-5, 100, 10), 0)
  assert.equal(clampScroll(50, 100, 10), 50)
  assert.equal(clampScroll(95, 100, 10), 90)
  assert.equal(clampScroll(Infinity, 100, 10), 90)
  assert.equal(clampScroll(-Infinity, 100, 10), 0)
  // Fewer rows than the screen: no scrolling at all.
  assert.equal(clampScroll(3, 4, 10), 0)
  assert.equal(clampScroll(3, 0, 10), 0)
})

test('following the cursor scrolls just enough to show its row', () => {
  const rows = bodyRows(
    Array.from({ length: 20 }, (_, i) => ({ path: `f${i}` })),
    '',
    [],
  )
  assert.equal(followCursor(rows, 5, 0, 10), 0)
  assert.equal(followCursor(rows, 12, 0, 10), 3)
  assert.equal(followCursor(rows, 2, 8, 10), 2)
  assert.equal(followCursor(rows, 99, 4, 10), 4)
})

test('change words list only the kinds there are, in a fixed order', () => {
  const f = status => ({ status })
  assert.equal(changeWords([]), '')
  assert.equal(changeWords([f('M'), f('?'), f('M'), f('A'), f('T')]), '3 modified, 2 new')
  assert.equal(changeWords([f('U'), f('R'), f('D'), f('C'), f('M')]), '1 modified, 1 deleted, 2 renamed, 1 conflicted')
})

test('change bars share one square-rooted scale', () => {
  const most = Math.sqrt(100)
  assert.deepEqual(changeCells({ add: 100, del: 0 }, most, 10), [10, 0, 0])
  assert.deepEqual(changeCells({ add: 13, del: 12 }, most, 10), [3, 2, 5])
  // Any change gets a cell; none gets an empty bar.
  assert.deepEqual(changeCells({ add: 0, del: 1 }, Math.sqrt(1e6), 10), [0, 1, 9])
  assert.deepEqual(changeCells({ add: 0, del: 0 }, most, 10), [0, 0, 10])
  assert.equal(addShare(0, 0, 40), 0)
  assert.equal(addShare(1, 3, 40), 10)
})

test('the card shrinks to nothing inside on a tiny pane, never below zero', () => {
  assert.deepEqual(cardSize(80), { w: 78, inner: 74 })
  for (const cols of [0, 1, 3, 5, 6]) {
    const { w, inner } = cardSize(cols)
    assert.ok(w - 2 >= 0 && inner >= 0, `${cols} cols`)
    assert.ok(addShare(5, 1, inner) <= inner)
  }
})

test('long paths keep the end of the name, the folder going first', () => {
  assert.deepEqual(fitPath('src/a.js', 20), { dir: 'src/', name: 'a.js' })
  assert.deepEqual(fitPath('a.js', 20), { dir: '', name: 'a.js' })
  assert.deepEqual(fitPath('some/deep/folder/file.js', 12), { dir: '…der/', name: 'file.js' })
  // A name that fills the room still leaves a … for its folder, one cell over.
  assert.deepEqual(fitPath('dir/averyverylongname.js', 8), { dir: '…', name: '…name.js' })
  assert.deepEqual(fitPath('averyverylongname.js', 8), { dir: '', name: '…name.js' })
  // Exactly fitting: nothing cut.
  assert.deepEqual(fitPath('ab/cd', 5), { dir: 'ab/', name: 'cd' })
})

test('fit pads or cuts to the width, tabs as two spaces and controls dropped', () => {
  assert.equal(fit('ab', 4), 'ab  ')
  assert.equal(fit('abcdef', 4), 'abcd')
  assert.equal(fit('\tx\x1b[31m', 6), '  x[31')
  assert.equal(fit('héllo', 3), 'hél')
})

test('mode header columns map to tabs, the gaps between to none', () => {
  const modes = [' Diagrams ', ' Files ', ' Diff ']
  assert.equal(modeAt(modes, 1), 0)
  assert.equal(modeAt(modes, 10), 0)
  assert.equal(modeAt(modes, 11), -1)
  assert.equal(modeAt(modes, 12), 1)
  assert.equal(modeAt(modes, 20), 2)
  assert.equal(modeAt(modes, 25), 2)
  assert.equal(modeAt(modes, 26), -1)
})

test('keys map to actions', () => {
  assert.deepEqual(keyAction('q', 5), ['quit'])
  assert.deepEqual(keyAction('\x03', 5), ['quit'])
  assert.deepEqual(keyAction('\t', 5), ['next'])
  assert.deepEqual(keyAction('j', 5), ['move', 1])
  assert.deepEqual(keyAction('\x1b[A', 5), ['move', -1])
  assert.deepEqual(keyAction('\r', 5), ['toggle'])
  assert.deepEqual(keyAction('o', 5), ['toggle'])
  assert.deepEqual(keyAction('J', 5), ['scroll', 3])
  assert.deepEqual(keyAction(' ', 5), ['scroll', 5])
  assert.deepEqual(keyAction('\x15', 5), ['scroll', -5])
  assert.deepEqual(keyAction('\x1b[5~', 5), ['scroll', -5])
  assert.deepEqual(keyAction('g', 5), ['scroll', -Infinity])
  assert.deepEqual(keyAction('G', 5), ['scroll', Infinity])
  assert.equal(keyAction('x', 5), undefined)
  assert.equal(keyAction('constructor', 5), undefined)
})

test('input splits into mouse reports and keys', () => {
  assert.deepEqual([...parseInput('j\x1b[<0;12;7M\x1b[<0;12;7m\x1b[Bq\x1b[6~')], [
    { key: 'j' },
    { mouse: { button: 0, x: 12, y: 7, released: false } },
    { mouse: { button: 0, x: 12, y: 7, released: true } },
    { key: '\x1b[B' },
    { key: 'q' },
    { key: '\x1b[6~' },
  ])
  assert.deepEqual([...parseInput('\x1b[<65;3;4M')], [{ mouse: { button: 65, x: 3, y: 4, released: false } }])
  assert.deepEqual([...parseInput('')], [])
})

test('J and K scroll Settings’ lines per scroll', () => {
  set('viewer.scrollLines', 7)
  assert.deepEqual(keyAction('J', 5), ['scroll', 7])
  assert.deepEqual(keyAction('K', 5), ['scroll', -7])
  set('viewer.scrollLines', 3)
})

test('the files a range of commits changed, a rename with its old path', () => {
  assert.deepEqual(parseNameStatus('M\0calc/b.py\0R087\0old.py\0new.py\0A\0a.py\0'), [
    { path: 'a.py', old: undefined, status: 'A', untracked: false, add: 0, del: 0, binary: false },
    { path: 'calc/b.py', old: undefined, status: 'M', untracked: false, add: 0, del: 0, binary: false },
    { path: 'new.py', old: 'old.py', status: 'R', untracked: false, add: 0, del: 0, binary: false },
  ])
})
