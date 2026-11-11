// Path completion as a shell does it, for the fields that take a path: the
// New agent form's Folder and Settings' file and folder rows. Paths are
// typed and shown with ~ for your home folder.

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const HOME = homedir()

export const tilde = p => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)
export const expand = p => (p === '~' ? HOME : p.startsWith('~/') ? HOME + p.slice(1) : p)

// What the text's last part could be: the folders (and with files, the
// files) in its folder that start with it, or, when none does, those that
// do ignoring case. Hidden ones only when the part starts with a dot, as in
// a shell. `folders` says which names are folders, which complete with a /.
export function matchesOf(text, { files = false } = {}) {
  const full = expand(text)
  const dir = full.endsWith('/') ? full : dirname(full)
  const part = full.endsWith('/') ? '' : basename(full)
  const folders = new Set()
  let all = []
  try {
    all = readdirSync(dir, { withFileTypes: true })
      .filter(e => part.startsWith('.') || !e.name.startsWith('.'))
      .filter(e => {
        const folder = isDir(dir, e)
        if (folder) folders.add(e.name)
        return folder || files
      })
      .map(e => e.name)
      .sort()
  } catch {}
  let names = all.filter(n => n.startsWith(part))
  if (!names.length) names = all.filter(n => n.toLowerCase().startsWith(part.toLowerCase()))
  return { dir, part, names, folders }
}

function isDir(dir, e) {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return statSync(join(dir, e.name)).isDirectory()
  } catch {
    return false
  }
}

// A match as the field shows it: from ~, a folder with its slash.
export const pathTo = ({ dir, folders }, name) => `${tilde(join(dir, name))}${folders.has(name) ? '/' : ''}`

// Tab as in zsh: one match is filled in (a folder with its slash); several
// fill in what they share, and once nothing more is shared, Tab steps
// through them (Shift+Tab, `back`, the other way) until another key keeps
// the one shown. `menu` is that stepping, null before it starts; the new
// text and menu come back.
export function complete(text, menu, back = false, opts = {}) {
  if (menu) {
    const i = (menu.i + (back ? menu.names.length - 1 : 1)) % menu.names.length
    return { text: pathTo(menu, menu.names[i]), menu: { ...menu, i } }
  }
  const m = matchesOf(text, opts)
  const { part, names } = m
  if (!names.length) return { text, menu: null }
  if (names.length === 1) return { text: pathTo(m, names[0]), menu: null }
  let common = names[0]
  for (const n of names) while (!n.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1)
  if (common.length > part.length) return { text: tilde(join(m.dir, common)), menu: null }
  const i = back ? names.length - 1 : 0
  return { text: pathTo(m, names[i]), menu: { ...m, i } }
}

// What's left of the first match after a part it extends, drawn dim after
// the text as fish and zsh-autosuggestions do; '' when there's none.
export function suggestion(text, opts = {}) {
  const m = matchesOf(text, opts)
  const first = m.names[0]
  if (!m.part || !first?.startsWith(m.part)) return ''
  return `${first.slice(m.part.length)}${m.folders.has(first) ? '/' : ''}`
}
