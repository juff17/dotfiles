// The Diff mode's logic, apart from the terminal so it can be tested: reading
// git's output, the rows of the file list, scrolling, and which key does what.
// diff-view.mjs draws it.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Untracked files past this size aren't read to count their lines.
export const MAX_COUNT_BYTES = 2 * 1024 * 1024

// `git status -z` entries: `XY path`, and for a rename `XY new` then `old`.
// A rename can be in either column: unstaged ones come from `git add -N`.
export function parseStatus(text) {
  const parts = text.split('\0')
  const list = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const old = 'RC'.includes(x) || 'RC'.includes(y) ? parts[++i] : undefined
    const untracked = x === '?'
    const status = untracked ? '?' : x === 'U' || y === 'U' ? 'U' : x !== ' ' ? x : y
    list.push({ path, old, status, untracked, add: 0, del: 0, binary: false })
  }
  return list.sort((a, b) => a.path.localeCompare(b.path))
}

// `git diff --numstat -z`: `add\tdel\tpath`, or for a rename `add\tdel\t`
// then `old` and `new`; a binary file counts `-`.
export function parseNumstat(text) {
  const counts = new Map()
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const [add, del, path] = parts[i].split('\t')
    if (del === undefined) continue
    const key = path || (i++, parts[++i])
    counts.set(key, { add: Number(add) || 0, del: Number(del) || 0, binary: add === '-' })
  }
  return counts
}

// An untracked file's lines, all added; kept in cache until the file changes.
export function countLines(root, path, cache) {
  try {
    const full = join(root, path)
    const { size, mtimeMs } = statSync(full)
    const key = `${path}\0${size}\0${mtimeMs}`
    if (!cache.has(key)) {
      if (size > MAX_COUNT_BYTES) return { add: 0, binary: true }
      const data = readFileSync(full)
      const binary = data.includes(0)
      let lines = 0
      if (!binary) for (const byte of data) if (byte === 10) lines++
      if (!binary && size > 0 && data[size - 1] !== 10) lines++
      cache.set(key, { add: lines, binary })
    }
    return cache.get(key)
  } catch {
    return { add: 0, binary: false }
  }
}

// A unified diff as rows to draw: hunk headers, and lines with the line
// number they sit at (the new one, or the old one for a removed line).
export function parseDiff(text) {
  const rows = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      rows.push({ kind: 'hunk', text: line })
    } else if (!inHunk) {
      if (line.startsWith('Binary files')) rows.push({ kind: 'note', text: 'Binary file changed' })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', num: newLine++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', num: oldLine++, text: line.slice(1) })
    } else if (line.startsWith(' ')) {
      oldLine++
      rows.push({ kind: 'ctx', num: newLine++, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.slice(2) })
    }
  }
  return rows
}

// After a new status, the cursor stays on the file it was on, or where it was
// when that file went.
export const keepCursor = (files, cursorPath, cursor) => {
  const keep = files.findIndex(f => f.path === cursorPath)
  return keep >= 0 ? keep : Math.min(cursor, Math.max(0, files.length - 1))
}

// The file list's rows: each file, and under the open one its diff.
export function bodyRows(files, openPath, openRows) {
  const rows = []
  files.forEach((file, i) => {
    rows.push({ kind: 'file', i })
    if (file.path === openPath) {
      for (const row of openRows) rows.push({ kind: 'diff', row })
      rows.push({ kind: 'gap' })
    }
  })
  return rows
}

// Scrolled no further than the last screenful.
export const clampScroll = (scroll, count, height) => Math.max(0, Math.min(scroll, Math.max(0, count - height)))

// The scroll that keeps the cursor's row on screen, moving as little as it can.
export function followCursor(rows, cursor, scroll, height) {
  const at = rows.findIndex(r => r.kind === 'file' && r.i === cursor)
  if (at >= 0 && at < scroll) scroll = at
  if (at >= scroll + height) scroll = at - height + 1
  return scroll
}

// What changed, in words: "5 modified, 1 new".
export function changeWords(files) {
  const kinds = { modified: 0, new: 0, deleted: 0, renamed: 0, conflicted: 0 }
  for (const f of files) {
    if (f.status === '?' || f.status === 'A') kinds.new++
    else if (f.status === 'D') kinds.deleted++
    else if (f.status === 'R' || f.status === 'C') kinds.renamed++
    else if (f.status === 'U') kinds.conflicted++
    else kinds.modified++
  }
  return Object.entries(kinds)
    .filter(([, n]) => n)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ')
}

// How many of `cells` go to added lines, the rest to removed ones.
export const addShare = (add, del, cells) => (add + del ? Math.round((cells * add) / (add + del)) : 0)

// A file's change bar as [added, removed, empty] cells out of `bar`. Bars
// share one scale, square-rooted so one big file doesn't flatten the rest:
// `most` is the square root of the biggest file's change.
export function changeCells(file, most, bar) {
  const total = file.add + file.del
  const cells = total ? Math.max(1, Math.round((bar * Math.sqrt(total)) / most)) : 0
  const green = addShare(file.add, file.del, cells)
  return [green, cells - green, bar - cells]
}

// A path cut to fit `room` cells as its folder and name: the name keeps its
// end, and the folder goes before the name does.
export function fitPath(path, room) {
  const cut = path.lastIndexOf('/') + 1
  let dir = path.slice(0, cut)
  let name = path.slice(cut)
  if (name.length > room) name = `…${name.slice(name.length - room + 1)}`
  if (dir.length + name.length > room) dir = dir.length ? `…${dir.slice(dir.length - Math.max(0, room - name.length - 1))}` : ''
  return { dir, name }
}

export const tidy = text => text.replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '')
export const fit = (text, w) => {
  const chars = [...tidy(text)]
  return chars.length > w ? chars.slice(0, w).join('') : chars.join('') + ' '.repeat(w - chars.length)
}

// The mode header's tab under a column counted from 1, or -1.
export function modeAt(modes, col) {
  let from = 1
  for (const [i, mode] of modes.entries()) {
    if (col >= from && col < from + mode.length) return i
    from += mode.length + 1
  }
  return -1
}

// What a key does, as [action, amount]: `quit` (to Files), `next` (Tab's
// mode), `move` the cursor, `toggle` the file under it, `scroll` by rows.
// `page` is half a screen.
export function keyAction(key, page) {
  const actions = {
    q: ['quit'],
    '\x03': ['quit'],
    '\t': ['next'],
    j: ['move', 1],
    k: ['move', -1],
    '\x1b[B': ['move', 1],
    '\x1b[A': ['move', -1],
    '\r': ['toggle'],
    o: ['toggle'],
    J: ['scroll', 3],
    K: ['scroll', -3],
    ' ': ['scroll', page],
    '\x04': ['scroll', page],
    '\x15': ['scroll', -page],
    '\x1b[6~': ['scroll', page],
    '\x1b[5~': ['scroll', -page],
    g: ['scroll', -Infinity],
    G: ['scroll', Infinity],
  }
  return Object.hasOwn(actions, key) ? actions[key] : undefined
}

const INPUT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[^a-zA-Z~]*[a-zA-Z~]|[\s\S]/g

// Terminal input as SGR mouse reports and keys, one at a time.
export function* parseInput(text) {
  for (const m of text.matchAll(INPUT)) {
    if (m[1] !== undefined) yield { mouse: { button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), released: m[4] === 'm' } }
    else yield { key: m[0] }
  }
}
