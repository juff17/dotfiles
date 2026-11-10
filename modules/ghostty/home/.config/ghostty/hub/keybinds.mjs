// Settings › Keybinds made real. layout.conf stays the one place each alt
// key's command is written: a rebind takes that `bind -n M-…` statement as it
// stands and binds it to the new key, in a file sourced into the layout's
// tmux (bin/ghostty-keys, also run as layout.conf loads). Ghostty's keys go
// in keys.local.ghostty beside config.ghostty, which includes it, and
// Ghostty reloads its config on SIGUSR2.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SECTIONS, load, settingsFile } from './settings.mjs'

export const KEY_ROWS = SECTIONS.find(s => s.id === 'keys').rows.filter(r => r.key)

// Keys a rebind may not take, and what has them already. Claude Code's own
// alt keys pass through when the layout doesn't bind them.
export const RESERVED = {
  'alt+b': 'the shell (word back)',
  'alt+f': 'the shell (word forward)',
  'alt+p': 'Claude Code (model picker)',
  'alt+w': 'the hub (list ↔ session)',
  'ctrl+shift+c': 'Ghostty (copy)',
  'ctrl+shift+v': 'Ghostty (paste)',
  'ctrl+shift+q': 'Ghostty (quit)',
  'ctrl+shift+o': 'Ghostty (split right)',
  'ctrl+shift+e': 'Ghostty (split down)',
  'ctrl+shift+i': 'Ghostty (inspector)',
  'ctrl+shift+j': 'Ghostty (scrollback to a file)',
  'ctrl+shift+p': 'Ghostty (command palette)',
}

// The key a keypress names for row r, or null. Alt rows take the letter
// with or without alt held; Ghostty rows take it with or without ctrl,
// since ctrl+shift+letter reaches a terminal program as ctrl+letter.
export function captured(r, key) {
  let c = null
  if (key.length === 2 && key[0] === '\x1b') c = key[1]
  else if (key.length === 1) {
    const code = key.charCodeAt(0)
    c = r.kind === 'ghostty' && code >= 1 && code <= 26 && !'\t\r'.includes(key) ? String.fromCharCode(code + 96) : key
  }
  c = c?.toLowerCase()
  if (!c || !/^[a-z0-9]$/.test(c)) return null
  return `${r.kind === 'alt' ? 'alt' : 'ctrl+shift'}+${c}`
}

// Why row r can't take spec, or null when it can.
export function clash(r, spec, values = load()) {
  if (!spec) return null
  if (RESERVED[spec]) return `${spec} is taken by ${RESERVED[spec]}`
  const other = KEY_ROWS.find(o => o.key !== r.key && values[o.key] === spec)
  return other ? `${spec} is taken by ${other.label}` : null
}

export const tmuxKey = spec => `M-${spec.slice('alt+'.length)}`

const here = dirname(fileURLToPath(import.meta.url))
export const layoutConf = () => join(here, '..', 'layout.conf')

// Each root-table alt binding in layout.conf, key → its whole statement,
// which runs over lines while its braces are open.
export function statements(text) {
  const out = new Map()
  let cur = null
  let depth = 0
  for (const line of text.split('\n')) {
    if (!cur) {
      const m = /^bind -n (M-\S+) /.exec(line)
      if (!m) continue
      cur = { key: m[1], lines: [] }
      depth = 0
    }
    cur.lines.push(line)
    for (const ch of line) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    if (depth <= 0) {
      out.set(cur.key, cur.lines.join('\n'))
      cur = null
    }
  }
  return out
}

// The tmux commands that bind each alt row at its key: every alt letter and
// digit layout.conf leaves to others is unbound first, so a key moved off
// again is free, then each row's statement is bound at its key.
export function tmuxConf(values, text) {
  const all = statements(text)
  const rows = KEY_ROWS.filter(r => r.kind === 'alt')
  const mine = new Set(rows.map(r => tmuxKey(r.default)))
  const others = new Set([...all.keys()].filter(k => !mine.has(k)))
  const lines = ['# Written by Settings › Keybinds (hub/keybinds.mjs); changes here are overwritten.']
  for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') if (!others.has(`M-${c}`)) lines.push(`unbind -q -n M-${c}`)
  for (const r of rows) {
    const v = values[r.key]
    const body = all.get(tmuxKey(r.default))
    if (v && body) lines.push(body.replace(/^bind -n M-\S+/, `bind -n ${tmuxKey(v)}`))
  }
  return `${lines.join('\n')}\n`
}

// Ghostty's lines: a moved key's default unbound, and the new one sending
// what config.ghostty had it send.
export function ghosttyConf(values) {
  const lines = ['# Written by Settings › Keybinds (hub/keybinds.mjs); changes here are overwritten.']
  for (const r of KEY_ROWS.filter(r => r.kind === 'ghostty')) {
    const v = values[r.key]
    if (v === r.default) continue
    lines.push(`keybind = ${r.default}=unbind`)
    if (v) lines.push(`keybind = ${v}=${r.run}`)
  }
  return `${lines.join('\n')}\n`
}

export const tmuxFile = () => join(dirname(settingsFile()), 'keys.tmux.conf')
// Beside the config.ghostty link, not the file it leads to: Ghostty reads
// an included path from the folder of the link it opened.
export const ghosttyFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ghostty', 'keys.local.ghostty')

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// Ghostty processes that catch SIGUSR2, so the signal reloads their config
// and never kills one built without that.
function ghosttys() {
  let pids = []
  try {
    pids = execFileSync('pgrep', ['-x', 'ghostty'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch {}
  return pids.filter(pid => {
    try {
      const caught = /^SigCgt:\s*([0-9a-f]+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      return caught && (BigInt(`0x${caught[1]}`) >> 11n) & 1n
    } catch {
      return false
    }
  })
}

// Writes both files and has the layout's tmux and Ghostty pick them up.
// `ghostty: false` skips Ghostty, for when only tmux has to catch up.
export function apply(values = load(), { ghostty = true } = {}) {
  write(tmuxFile(), tmuxConf(values, readFileSync(layoutConf(), 'utf8')))
  try {
    execFileSync('tmux', ['-L', process.env.GHOSTTY_LAYOUT_SOCKET || 'ghostty-layout', 'source-file', tmuxFile()], { stdio: 'ignore' })
  } catch {
    // No layout running yet: layout.conf applies the file when one starts.
  }
  if (!ghostty) return
  const file = ghosttyFile()
  let before = null
  try {
    before = readFileSync(file, 'utf8')
  } catch {}
  const text = ghosttyConf(values)
  if (text === before) return
  write(file, text)
  for (const pid of ghosttys()) process.kill(pid, 'SIGUSR2')
}
