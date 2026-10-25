#!/usr/bin/env node
// gv: the viewer pane's Diff mode, as the D2 design draws it. Shows the
// uncommitted changes of the git repository around the active tmux tab's
// folder (staged, unstaged and untracked) against the last commit: a summary,
// a row per changed file with its size of change, and one file open in place
// under its row. It checks git every second, so the list empties once you
// commit.
//   diff-view.mjs [dir]
// DV_TABS names the window's tab session as `socket:session`
// (bin/ghostty-claude-start); without it, dir is the folder.
// GV_FILES_EXIT and GV_DIAGRAMS_EXIT are the exit codes that switch the pane
// to Files or Diagrams (bin/ghostty-viewer); Tab goes to Diagrams, q to Files.

import { execFile } from 'node:child_process'
import { readFileSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DIR = process.argv[2] || process.cwd()
const [TABS_SOCKET, TABS_SESSION] = (process.env.DV_TABS ?? '').split(':')
// The tab session touches this file when the active tab changes (tmux.conf).
const TAB_CHANGED = `${process.env.XDG_RUNTIME_DIR || '/tmp'}/ghostty-layout/tab-changed`
const FILES_EXIT = Number(process.env.GV_FILES_EXIT) || 0
const DIAGRAMS_EXIT = Number(process.env.GV_DIAGRAMS_EXIT) || 0
const MODES = [' Diagrams ', ' Files ', ' Diff ']
// The empty tree, to diff against in a repository with no commits yet.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const REFRESH_MS = 1000
// Untracked files past this size aren't read to count their lines.
const MAX_COUNT_BYTES = 2 * 1024 * 1024
// Rows besides the file list: the mode header, the path row and the summary
// card above, the status row below.
const TOP = 7
const CHROME_ROWS = 7
const BAR = 10

// Catppuccin Mocha, as in the design and yazi/theme.toml.
const fg = hex => `\x1b[38;2;${rgb(hex)}m`
const bg = hex => `\x1b[48;2;${rgb(hex)}m`
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
const C = {
  text: fg('#cdd6f4'),
  sub: fg('#a6adc8'),
  overlay: fg('#6c7086'),
  line: fg('#45475a'),
  track: fg('#313244'),
  blue: fg('#89b4fa'),
  green: fg('#a6e3a1'),
  red: fg('#f38ba8'),
  yellow: fg('#f9e2af'),
  mauve: fg('#cba6f7'),
  crust: fg('#11111b'),
  cursorBg: bg('#313244'),
  addBg: bg('#292e37'),
  delBg: bg('#2f2738'),
  pillBg: bg('#89b4fa'),
  tabBg: bg('#cdd6f4'),
  bold: '\x1b[1m',
  reset: '\x1b[0m',
}
const STATUS_COLORS = { M: C.yellow, T: C.yellow, A: C.green, '?': C.green, D: C.red, U: C.red, R: C.mauve, C: C.mauve }

const out = s => process.stdout.write(s)

let folder = ''
let root = ''
let branch = ''
let files = []
let cursor = 0
// The open file, by path so it stays open across refreshes; '' for none.
let openPath = ''
let openRows = []
let scroll = 0
let follow = true
let message = 'Reading git…'
let lastStatus = ''
let lastDiff = ''
const lineCounts = new Map()

const git = (args, cwd = root) =>
  new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '' })
    })
  })

// `git status -z` entries: `XY path`, and for a rename `XY new` then `old`.
function parseStatus(text) {
  const parts = text.split('\0')
  const list = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const old = x === 'R' || x === 'C' ? parts[++i] : undefined
    const untracked = x === '?'
    const status = untracked ? '?' : x === 'U' || y === 'U' ? 'U' : x !== ' ' ? x : y
    list.push({ path, old, status, untracked, add: 0, del: 0, binary: false })
  }
  return list.sort((a, b) => a.path.localeCompare(b.path))
}

// `git diff --numstat -z`: `add\tdel\tpath`, or for a rename `add\tdel\t`
// then `old` and `new`; a binary file counts `-`.
function parseNumstat(text) {
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

// An untracked file's lines, all added; kept until the file changes.
function countLines(path) {
  try {
    const full = join(root, path)
    const { size, mtimeMs } = statSync(full)
    const key = `${path}\0${size}\0${mtimeMs}`
    if (!lineCounts.has(key)) {
      if (size > MAX_COUNT_BYTES) return { add: 0, binary: true }
      const data = readFileSync(full)
      const binary = data.includes(0)
      let lines = 0
      if (!binary) for (const byte of data) if (byte === 10) lines++
      if (!binary && size > 0 && data[size - 1] !== 10) lines++
      lineCounts.set(key, { add: lines, binary })
    }
    return lineCounts.get(key)
  } catch {
    return { add: 0, binary: false }
  }
}

// A unified diff as rows to draw: hunk headers, and lines with the line
// number they sit at (the new one, or the old one for a removed line).
function parseDiff(text) {
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

async function readDiff(file, base) {
  if (file.untracked) {
    // Exits 1 when the files differ, which they always do here.
    return (await git(['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', file.path])).stdout
  }
  const paths = file.old ? [file.path, file.old] : [file.path]
  return (await git(['diff', base, '-M', '--no-color', '--no-ext-diff', '--', ...paths])).stdout
}

// The active tab's folder, or dir when DV_TABS isn't set or tmux can't say.
function activeFolder() {
  if (!TABS_SESSION) return Promise.resolve(DIR)
  return new Promise(resolve => {
    const args = ['-L', TABS_SOCKET, 'display', '-p', '-t', `${TABS_SESSION}:`, '#{pane_current_path}']
    execFile('tmux', args, { encoding: 'utf8' }, (error, stdout) => resolve((!error && stdout.trim()) || DIR))
  })
}

// One refresh at a time; one asked for meanwhile runs after it.
let refreshing = false
let again = false
async function refresh() {
  if (refreshing) {
    again = true
    return
  }
  refreshing = true
  try {
    const now = await activeFolder()
    if (now !== folder) {
      // Another tab: start over on its repository.
      folder = now
      files = []
      cursor = 0
      openPath = ''
      openRows = []
      scroll = 0
      lastStatus = ''
      lastDiff = ''
    }
    const top = await git(['rev-parse', '--show-toplevel'], folder)
    if (top.code !== 0) {
      root = ''
      files = []
      openRows = []
      message = 'Not a git repository'
      return draw()
    }
    root = top.stdout.trim()
    const head = await git(['branch', '--show-current'])
    branch = head.stdout.trim() || (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim()
    const base = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0 ? 'HEAD' : EMPTY_TREE
    const status = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout
    const numstat = parseNumstat((await git(['diff', base, '--numstat', '-M', '-z'])).stdout)
    const cursorPath = files[cursor]?.path
    if (status !== lastStatus) {
      lastStatus = status
      files = parseStatus(status)
      const keep = files.findIndex(f => f.path === cursorPath)
      cursor = keep >= 0 ? keep : Math.min(cursor, Math.max(0, files.length - 1))
      if (!openPath && files.length) openPath = files[0].path
    }
    for (const file of files) {
      Object.assign(file, file.untracked ? { del: 0, ...countLines(file.path) } : (numstat.get(file.path) ?? {}))
    }
    message = files.length === 0 ? 'No uncommitted changes' : ''
    const open = files.find(f => f.path === openPath)
    const text = open ? await readDiff(open, base) : ''
    if (text !== lastDiff) {
      lastDiff = text
      openRows = parseDiff(text)
    }
    draw()
  } finally {
    refreshing = false
    if (again) {
      again = false
      void refresh()
    }
  }
}

function moveCursor(i) {
  if (files.length === 0) return
  cursor = Math.max(0, Math.min(i, files.length - 1))
  follow = true
  draw()
}

// Opens the file under the cursor, closing the one open before; closes it
// when it was already open.
function toggleOpen(i = cursor) {
  const file = files[i]
  if (!file) return
  cursor = i
  openPath = openPath === file.path ? '' : file.path
  openRows = []
  lastDiff = ''
  follow = true
  draw()
  void refresh()
}

function scrollBy(by) {
  const max = Math.max(0, bodyRows().length - bodyHeight())
  scroll = Math.max(0, Math.min(scroll + by, max))
  follow = false
  draw()
}

const bodyHeight = () => Math.max(1, process.stdout.rows - CHROME_ROWS)
const width = () => process.stdout.columns

// The file list's rows: each file, and under the open one its diff.
function bodyRows() {
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

const tidy = text => text.replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '')
const fit = (text, w) => {
  const chars = [...tidy(text)]
  return chars.length > w ? chars.slice(0, w).join('') : chars.join('') + ' '.repeat(w - chars.length)
}
const home = path => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)

// Keys in blue, what they do in the dimmer text color.
const hint = pairs => pairs.map(([key, what]) => `${C.blue}${key}${C.sub} ${what}${C.reset}`).join('  ')

function header() {
  const tabs = MODES.map((mode, i) =>
    i === 2 ? `${C.tabBg}${C.crust}${C.bold}${mode}${C.reset}` : `${C.sub}${C.bold}${mode}${C.reset}`,
  ).join(' ')
  return `${tabs}\x1b[${width() - 'tab switch'.length + 1}G${hint([['tab', 'switch']])}`
}

// What changed, in words: "5 modified, 1 new".
function changeWords() {
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

// The summary card: totals, and a bar split by the share of added lines.
function card() {
  const w = width() - 2
  const inner = w - 4
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`
  const left = `${C.text}${C.bold}${count}${C.reset}${C.sub} changed  ·  ${changeWords()}${C.reset}`
  const leftWidth = `${count} changed  ·  ${changeWords()}`.length
  const right = `${C.green}${C.bold}+${add}${C.reset}  ${C.red}${C.bold}−${del}${C.reset}`
  const rightWidth = `+${add}  −${del}`.length
  const green = add + del ? Math.round((inner * add) / (add + del)) : 0
  const bar = `${C.green}${'━'.repeat(green)}${C.red}${'━'.repeat(inner - green)}${C.reset}`
  const side = `${C.line}│${C.reset}`
  return [
    ` ${C.line}╭${'─'.repeat(w - 2)}╮${C.reset}`,
    ` ${side} ${left}${' '.repeat(Math.max(1, inner - leftWidth - rightWidth))}${right} ${side}`,
    ` ${side} ${bar} ${side}`,
    ` ${C.line}╰${'─'.repeat(w - 2)}╯${C.reset}`,
  ]
}

// Bars share one scale, square-rooted so one big file doesn't flatten the rest.
function changeBar(file, most) {
  const total = file.add + file.del
  const cells = total ? Math.max(1, Math.round((BAR * Math.sqrt(total)) / most)) : 0
  const green = total ? Math.round((cells * file.add) / total) : 0
  return `${C.green}${'━'.repeat(green)}${C.red}${'━'.repeat(cells - green)}${C.track}${'━'.repeat(BAR - cells)}${C.reset}`
}

function fileRow(file, i, most) {
  const open = file.path === openPath
  const back = i === cursor ? C.cursorBg : ''
  const counts = file.binary ? 'binary' : `+${file.add} −${file.del}`
  const countsText = file.binary ? `${C.sub}binary` : `${C.green}+${file.add} ${file.del ? C.red : C.line}−${file.del}`
  const right = ` ${' '.repeat(Math.max(0, 11 - counts.length))}${countsText}${C.reset}${back} ${changeBar(file, most)}${back} `
  const room = Math.max(4, width() - 5 - 11 - BAR - 3)
  const cut = file.path.lastIndexOf('/') + 1
  let dir = file.path.slice(0, cut)
  let name = file.path.slice(cut)
  if (name.length > room) name = `…${name.slice(name.length - room + 1)}`
  if (dir.length + name.length > room) dir = dir.length ? `…${dir.slice(dir.length - Math.max(0, room - name.length - 1))}` : ''
  const nameColor = open ? C.blue : C.text
  const pad = ' '.repeat(Math.max(0, room - dir.length - name.length))
  const status = `${STATUS_COLORS[file.status] ?? C.text}${C.bold}${file.status}${C.reset}${back}`
  return `${back} ${C.overlay}${open ? '▾' : '▸'}${C.reset}${back} ${status} ${C.overlay}${dir}${C.reset}${back}${nameColor}${C.bold}${name}${C.reset}${back}${pad}${right}${C.reset}`
}

function diffRow(row) {
  const edge = `   ${C.blue}▎${C.reset}`
  const room = Math.max(1, width() - 4 - 5 - 2)
  switch (row.kind) {
    case 'hunk':
      return `${edge}     ${C.mauve}${fit(row.text, room + 2)}${C.reset}`
    case 'note':
      return `${edge}       ${C.overlay}${fit(row.text, room)}${C.reset}`
    case 'add':
      return `${edge}${C.addBg}${C.overlay}${String(row.num).padStart(4)} ${C.green}+ ${fit(row.text, room)}${C.reset}`
    case 'del':
      return `${edge}${C.delBg}${C.overlay}${String(row.num).padStart(4)} ${C.red}- ${fit(row.text, room)}${C.reset}`
    default:
      return `${edge}${C.overlay}${String(row.num).padStart(4)} ${C.text}  ${fit(row.text, room)}${C.reset}`
  }
}

function statusRow() {
  const left = `${C.pillBg}${C.crust}${C.bold} DIFF ${C.reset}  ${hint([['enter', 'open'], ['j k', 'move']])}`
  if (!files.length) return left
  const position = `${cursor + 1}/${files.length} `
  return `${left}\x1b[${width() - position.length + 1}G${C.text}${position}${C.reset}`
}

// Each frame goes out in one write, inside synchronized output, every row
// overwriting itself, so a refresh never flickers.
function draw() {
  const height = bodyHeight()
  const rows = bodyRows()
  if (follow) {
    const at = rows.findIndex(r => r.kind === 'file' && r.i === cursor)
    if (at >= 0 && at < scroll) scroll = at
    if (at >= scroll + height) scroll = at - height + 1
  }
  scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)))
  const path = root ? `${C.blue}${C.bold}${home(root)}${C.reset}${branch ? `${C.sub}  ${branch}${C.reset}` : ''}` : ''
  const lines = [header(), path]
  if (message) {
    const total = height + 4
    for (let row = 0; row < total; row++) {
      const middle = row === Math.floor(total / 2) - 1
      const pad = Math.max(0, Math.floor((width() - message.length) / 2))
      lines.push(middle ? `${' '.repeat(pad)}${C.sub}${message}${C.reset}` : '')
    }
  } else {
    lines.push(...card())
    const most = Math.sqrt(Math.max(1, ...files.map(f => f.add + f.del)))
    for (let row = 0; row < height; row++) {
      const r = rows[scroll + row]
      if (!r || r.kind === 'gap') lines.push('')
      else if (r.kind === 'file') lines.push(fileRow(files[r.i], r.i, most))
      else lines.push(diffRow(r.row))
    }
  }
  lines.push(statusRow())
  let frame = '\x1b[?2026h'
  lines.forEach((line, i) => {
    frame += `\x1b[${i + 1};1H\x1b[2K${line}`
  })
  out(`${frame}\x1b[?2026l`)
}

function quit(code = 0) {
  out('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  process.exit(code)
}

// The mode header's tabs, as column ranges from 1.
function modeAt(col) {
  let from = 1
  for (const [i, mode] of MODES.entries()) {
    if (col >= from && col < from + mode.length) return i
    from += mode.length + 1
  }
  return -1
}

function onMouse(button, x, y, released) {
  if (button & 64) return scrollBy((button & 1) === 0 ? -3 : 3)
  if (released || (button & 3) !== 0 || button & 32) return
  if (y === 1) {
    const mode = modeAt(x)
    if (mode === 0 && DIAGRAMS_EXIT) return quit(DIAGRAMS_EXIT)
    if (mode === 1 && FILES_EXIT) return quit(FILES_EXIT)
    return
  }
  if (message || y < TOP || y >= TOP + bodyHeight()) return
  const r = bodyRows()[scroll + y - TOP]
  if (r?.kind === 'file') toggleOpen(r.i)
}

function onKey(key) {
  const page = Math.max(1, Math.floor(bodyHeight() / 2))
  const actions = {
    q: () => quit(FILES_EXIT),
    '\x03': () => quit(FILES_EXIT),
    '\t': () => DIAGRAMS_EXIT && quit(DIAGRAMS_EXIT),
    j: () => moveCursor(cursor + 1),
    k: () => moveCursor(cursor - 1),
    '\x1b[B': () => moveCursor(cursor + 1),
    '\x1b[A': () => moveCursor(cursor - 1),
    '\r': () => toggleOpen(),
    o: () => toggleOpen(),
    J: () => scrollBy(3),
    K: () => scrollBy(-3),
    ' ': () => scrollBy(page),
    '\x04': () => scrollBy(page),
    '\x15': () => scrollBy(-page),
    '\x1b[6~': () => scrollBy(page),
    '\x1b[5~': () => scrollBy(-page),
    g: () => scrollBy(-Infinity),
    G: () => scrollBy(Infinity),
  }
  actions[key]?.()
}

const INPUT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[^a-zA-Z~]*[a-zA-Z~]|[\s\S]/g

function onInput(data) {
  for (const m of data.toString('utf8').matchAll(INPUT)) {
    if (m[1] !== undefined) onMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'm')
    else onKey(m[0])
  }
}

if (!process.stdin.isTTY) {
  console.error('diff-view needs a terminal.')
  process.exit(1)
}

process.stdin.setRawMode(true)
process.stdin.on('data', onInput)
process.on('SIGWINCH', draw)
process.on('SIGTERM', () => quit())
// Alternate screen, no cursor, button and drag reports in SGR form.
out('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h')
draw()
void refresh()
setInterval(() => void refresh(), REFRESH_MS)
try {
  watch(dirname(TAB_CHANGED), (_, name) => {
    if (name === 'tab-changed') void refresh()
  })
} catch {
  // No layout state folder: outside the layout, the tab never changes.
}
