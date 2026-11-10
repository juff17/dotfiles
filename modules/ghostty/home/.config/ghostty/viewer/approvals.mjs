// The Alt+A popup's state and what keys do to it, apart from the terminal so
// it can be tested; approvals-view.mjs draws it and carries out what a key
// asks for. The popup steps through what babysitters proposed (pr-babysit's
// approval.py, read through hub/tray.mjs), one at a time.
//
// The state is { list, i, commit, diff, drop, editing, draft, at, edited,
// note, scroll, seenTo, hidden, changed }: the proposals, the one shown, the
// push commit selected, the diff shown in place of the proposal (openDiff),
// the commits dropped,
// the inline reply editor, whether the reply was edited, the footer's note,
// how far the body is scrolled and how much of it has been on screen
// (the view sets hidden while some never was), and whether the proposal
// shown just replaced the one you were looking at.
//
// Approving needs the whole proposal to have been on screen, and a look at
// one that replaced what you were reading, so a key never approves
// something you didn't see.
//
// onKey returns what the view has to do: nothing, 'quit', or an effect
// { do, p, ... }: approve (with the edited body, the dropped commits, and
// `always` for A), reject, dismiss, go, editor (edit the reply in $EDITOR),
// diff (read the files from..to changed, then openDiff: a commit's, or all
// of a push's), diffFile (read an open file's rows), open (its comment, job,
// run or PR on the
// host, from hub/tray.mjs's proposalLink), or settings (A's "always" for
// this kind).

import { editField } from '../hub/line.mjs'
import { load as settings } from '../hub/settings.mjs'
import { proposalLink } from '../hub/tray.mjs'

export const start = (list, focus = '') => ({
  list,
  i: Math.max(0, list.findIndex(p => p.id === focus)),
  commit: 0,
  diff: null,
  drop: new Set(),
  editing: false,
  draft: '',
  at: undefined,
  edited: false,
  note: null,
  scroll: 0,
  seenTo: 0,
  hidden: false,
  changed: false,
})

export const current = s => s.list[Math.min(s.i, s.list.length - 1)] ?? null

// The proposals again, after one was settled or a new one came: the one
// shown stays shown while it's there.
export function reload(s, list, settledHere = false) {
  const id = current(s)?.id
  const at = list.findIndex(p => p.id === id)
  s.list = list
  if (at >= 0) s.i = at
  else {
    s.i = Math.min(s.i, Math.max(0, list.length - 1))
    reset(s)
    if (id && list.length && !settledHere) {
      s.changed = true
      s.note = { text: 'What you were reading was settled or replaced; this is another one', tone: 'peach' }
    }
  }
}

function reset(s) {
  s.commit = 0
  s.diff = null
  s.drop = new Set()
  s.editing = false
  s.draft = ''
  s.at = undefined
  s.edited = false
  s.scroll = 0
  s.seenTo = 0
  s.hidden = false
  s.changed = false
}

// Whether a may approve now; if not, says why in the note.
function ready(s) {
  if (s.changed) {
    s.changed = false
    s.note = { text: 'This replaced what you were reading. Look it over, then press a again.', tone: 'peach' }
    return false
  }
  if (s.hidden) {
    s.note = { text: 'Not all of it has been on screen: J or PgDn to the end first', tone: 'peach' }
    return false
  }
  return true
}

function move(s, n) {
  if (!s.list.length) return
  s.i = (s.i + n + s.list.length) % s.list.length
  reset(s)
  s.note = null
}

// The text a reply would post now: the edit, or what was proposed.
export const bodyOf = (s, p) => (s.edited ? s.draft : p.body)

// What a's approval sends: the edited body, and the dropped commits.
export function approval(s, p, always = false) {
  const e = { do: 'approve', p, always }
  if (p.kind === 'reply' && s.edited && s.draft !== p.body) e.body = s.draft
  if (p.kind === 'push' && s.drop.size) e.drop = [...s.drop]
  return e
}

// Whether A may make this kind always run: never a deployment, and never
// from a failed one.
export const canAlways = p => p.status === 'pending' && p.kind !== 'deploy'

// The settings A turns on, "approve and always for <kind>".
export const alwaysSetting = p => (p.kind === 'reply' ? ['approvals.reply', 'post'] : [`approvals.${p.kind}`, 'auto'])

// An edit is done: with Settings' "post it", it's approved at once;
// with "show it once more", it waits for a.
export function edited(s, p, text) {
  s.editing = false
  s.at = undefined
  if (text == null || text === bodyOf(s, p)) {
    s.note = { text: 'Reply unchanged', tone: 'sub' }
    return undefined
  }
  s.draft = text
  s.edited = true
  if (settings()['approvals.edited'] === 'post') return approval(s, p)
  s.note = { text: 'Edited. Press a to post it as shown.', tone: 'peach' }
  return undefined
}

// The inline editor, when Settings pick it or there's no $EDITOR.
export const inline = env => settings()['approvals.editor'] === 'inline' || !env.EDITOR

function editKey(s, p, key) {
  if (key === '\r') return edited(s, p, s.draft) ?? undefined
  if (key === '\x1b') {
    s.editing = false
    s.draft = s.edited ? s.draft : p.body
    s.note = { text: 'Edit dropped', tone: 'sub' }
    return undefined
  }
  editField(s, 'draft', key)
  return undefined
}

// A push's diff, shown in the popup as the Diff mode shows uncommitted
// changes: { title, from, to, files, cursor, open, rows, scroll, follow },
// with the files git gave between `from` and `to` (diff.mjs's
// parseNameStatus and parseNumstat). The first file opens with it; the view
// reads each open file's rows.
export function openDiff(s, { title, from, to, files }) {
  s.diff = { title, from, to, files, cursor: 0, open: files[0]?.path ?? '', rows: [], scroll: 0, follow: true }
}

// Keys while the diff shows: j k pick a file, ↵ or space opens or closes
// it, J K and PgDn PgUp scroll, esc, q or d go back to the proposal.
function diffKey(s, key) {
  const d = s.diff
  const own = settings()['keys.approvals']
  if (key === '\x1ba' || key === '\x03' || (own && key === `\x1b${own.slice(-1)}`)) return 'quit'
  const pick = i => {
    d.cursor = Math.max(0, Math.min(d.files.length - 1, i))
    d.follow = true
  }
  const back = () => {
    s.diff = null
  }
  const toggle = () => {
    const f = d.files[d.cursor]
    if (!f) return undefined
    d.open = d.open === f.path ? '' : f.path
    d.rows = []
    d.follow = true
    return d.open ? { do: 'diffFile', file: f } : undefined
  }
  const scroll = by => {
    d.scroll = Math.max(0, d.scroll + by)
    d.follow = false
  }
  const keys = {
    '\x1b': back,
    q: back,
    d: back,
    j: () => pick(d.cursor + 1),
    k: () => pick(d.cursor - 1),
    '\x1b[B': () => pick(d.cursor + 1),
    '\x1b[A': () => pick(d.cursor - 1),
    g: () => pick(0),
    G: () => pick(d.files.length - 1),
    '\r': toggle,
    ' ': toggle,
    J: () => scroll(5),
    K: () => scroll(-5),
    '\x1b[6~': () => scroll(10),
    '\x1b[5~': () => scroll(-10),
  }
  return Object.hasOwn(keys, key) ? keys[key]() : undefined
}

export function onKey(s, key, env = process.env) {
  const p = current(s)
  if (s.editing && p) return editKey(s, p, key)
  if (s.diff && p) return diffKey(s, key)
  // Alt+A opened it, or the key Settings › Keybinds moved it to.
  const own = settings()['keys.approvals']
  if (key === 'q' || key === '\x1b' || key === '\x03' || key === '\x1ba' || (own && key === `\x1b${own.slice(-1)}`)) return 'quit'
  if (!p) return undefined
  const commits = p.commits ?? []
  const pending = p.status === 'pending'
  const keys = {
    // The proposals side by side, like the dots under them: ← and → step
    // between them; j and k too.
    '\x1b[D': () => move(s, -1),
    '\x1b[C': () => move(s, 1),
    j: () => move(s, 1),
    k: () => move(s, -1),
    '\x1b[B': () => (p.kind === 'push' ? (s.commit = Math.min(commits.length - 1, s.commit + 1)) : move(s, 1)),
    '\x1b[A': () => (p.kind === 'push' ? (s.commit = Math.max(0, s.commit - 1)) : move(s, -1)),
    '\r': () => {
      const c = commits[s.commit]
      if (p.kind !== 'push' || !c?.sha) return undefined
      return { do: 'diff', p, from: `${c.sha}^`, to: c.sha, title: `${c.sha.slice(0, 7)} ${c.subject ?? ''}`.trim() }
    },
    ' ': () => {
      const sha = commits[s.commit]?.sha
      if (p.kind !== 'push' || !sha || !pending) return
      s.drop.has(sha) ? s.drop.delete(sha) : s.drop.add(sha)
      if (s.drop.size === commits.length) {
        s.drop.delete(sha)
        s.note = { text: 'Keep at least one commit, or press r for not yet', tone: 'peach' }
      }
    },
    J: () => (s.scroll += 5),
    '\x1b[6~': () => (s.scroll += 10),
    K: () => (s.scroll = Math.max(0, s.scroll - 5)),
    '\x1b[5~': () => (s.scroll = Math.max(0, s.scroll - 10)),
    a: () => (ready(s) ? approval(s, p) : undefined),
    A: () => {
      if (canAlways(p)) return ready(s) ? approval(s, p, true) : undefined
      s.note = { text: p.kind === 'deploy' ? 'A deployment always asks' : 'Press a to try it again', tone: 'peach' }
      return undefined
    },
    e: () => {
      if (p.kind !== 'reply' || !pending) return undefined
      if (!inline(env)) return { do: 'editor', p, text: bodyOf(s, p) }
      s.editing = true
      s.draft = bodyOf(s, p)
      s.at = undefined
      s.note = null
      return undefined
    },
    r: () => (pending ? { do: 'reject', p } : { do: 'dismiss', p }),
    x: () => (pending ? undefined : { do: 'dismiss', p }),
    g: () => ({ do: 'go', p }),
    d: () => (p.kind === 'push' ? { do: 'diff', p, from: p.lease, to: p.head, title: `all ${commits.length} commit${commits.length === 1 ? '' : 's'}` } : undefined),
    o: () => {
      const link = proposalLink(p)
      return link ? { do: 'open', p, url: link.url } : undefined
    },
  }
  if (key !== 'a' && key !== 'A') s.changed = false
  const effect = Object.hasOwn(keys, key) ? keys[key]() : undefined
  return effect && typeof effect === 'object' ? effect : undefined
}
