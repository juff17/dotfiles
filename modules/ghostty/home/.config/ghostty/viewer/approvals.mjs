// The Alt+A popup's state and what keys do to it, apart from the terminal so
// it can be tested; approvals-view.mjs draws it and carries out what a key
// asks for. The popup steps through what babysitters proposed (pr-babysit's
// approval.py, read through hub/tray.mjs), one at a time.
//
// The state is { list, i, commit, open, drop, editing, draft, at, edited,
// note }: the proposals, the one shown, the push commit selected, the
// commits whose diff is open and those dropped, the inline reply editor,
// whether the reply was edited, and the footer's note.
//
// onKey returns what the view has to do: nothing, 'quit', or an effect
// { do, p, ... }: approve (with the edited body, the dropped commits, and
// `always` for A), reject, dismiss, go, editor (edit the reply in $EDITOR),
// diff (all of a push's changes), or settings (A's "always" for this kind).

import { editField } from '../hub/line.mjs'
import { load as settings } from '../hub/settings.mjs'

export const start = (list, focus = '') => ({
  list,
  i: Math.max(0, list.findIndex(p => p.id === focus)),
  commit: 0,
  open: new Set(),
  drop: new Set(),
  editing: false,
  draft: '',
  at: undefined,
  edited: false,
  note: null,
})

export const current = s => s.list[Math.min(s.i, s.list.length - 1)] ?? null

// The proposals again, after one was settled or a new one came: the one
// shown stays shown while it's there.
export function reload(s, list) {
  const id = current(s)?.id
  const at = list.findIndex(p => p.id === id)
  s.list = list
  if (at >= 0) s.i = at
  else {
    s.i = Math.min(s.i, Math.max(0, list.length - 1))
    reset(s)
  }
}

function reset(s) {
  s.commit = 0
  s.open = new Set()
  s.drop = new Set()
  s.editing = false
  s.draft = ''
  s.at = undefined
  s.edited = false
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

export function onKey(s, key, env = process.env) {
  const p = current(s)
  if (s.editing && p) return editKey(s, p, key)
  if (key === 'q' || key === '\x1b' || key === '\x03' || key === '\x1ba') return 'quit'
  if (!p) return undefined
  const commits = p.commits ?? []
  const pending = p.status === 'pending'
  const keys = {
    j: () => move(s, 1),
    k: () => move(s, -1),
    '\x1b[B': () => (p.kind === 'push' ? (s.commit = Math.min(commits.length - 1, s.commit + 1)) : move(s, 1)),
    '\x1b[A': () => (p.kind === 'push' ? (s.commit = Math.max(0, s.commit - 1)) : move(s, -1)),
    '\r': () => {
      const sha = commits[s.commit]?.sha
      if (p.kind === 'push' && sha) s.open.has(sha) ? s.open.delete(sha) : s.open.add(sha)
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
    a: () => approval(s, p),
    A: () => {
      if (canAlways(p)) return approval(s, p, true)
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
    d: () => (p.kind === 'push' ? { do: 'diff', p } : undefined),
  }
  const effect = Object.hasOwn(keys, key) ? keys[key]() : undefined
  return effect && typeof effect === 'object' ? effect : undefined
}
