// The ⚙ settings panel's state and what keys do to it, apart from the
// terminal so it can be tested; settings-view.mjs draws it. The state is
// { sec, sel, flag, scroll, note, view, viewScroll, confirm, typing }: the
// section, the row in it, which flag ←/→ is on in a row of flags, the body's
// scroll, the footer's note (set when a save fails), the agent whose whole
// prompt is open over the panel and its scroll, the agent whose instructions
// a second r clears, and the instructions being typed ({ id, field }, the
// field a textarea.mjs one). Changes are saved to hub/settings.mjs's file as
// they're made. It's keys only: clicks do nothing.
//
// An agent's prompt is a row beside its settings ({ prompt: id }): e opens
// your instructions for it in a field under the row, where ctrl+s saves them
// and esc drops the change; v or ↵ opens the whole prompt, and r twice clears
// your instructions. Its skill, where it has one to pick, is the setting
// above it.

import { BOLD, P, fg, width } from '../hub/term.mjs'
import { SECTIONS, load, reset, set, show, step, toggleFlag } from '../hub/settings.mjs'
import { agent, clear, compose, instructions, save as savePrompt, stepSkill } from '../hub/prompts.mjs'
import { fromText, insert, textKey } from './textarea.mjs'
import { filerMessage, filerPrompt, filerSystem, handoffSpec } from './todo.mjs'

export const NAV = 22
// Title, gap, the section's note, gap above the body; footer below it.
export const TOP = 4
export const BOTTOM = 1
// The value column's width, at the right of the body.
export const VALUE = 30

export const start = id => ({
  sec: Math.max(0, SECTIONS.findIndex(s => s.id === id)),
  sel: 0,
  flag: 0,
  scroll: 0,
  note: null,
  view: null,
  viewScroll: 0,
  confirm: null,
  typing: null,
})

// The rows ↑/↓ moves between: the section's settings and agents' prompts.
export const items = s => SECTIONS[s.sec].rows.filter(r => r.key || r.prompt)
export const current = s => items(s)[s.sel]

// A setting's value as spans, `on` when it's the selected one.
export function valueSpans(r, v, on, flag) {
  if (r.type === 'bool') return [[v ? '● on' : '○ off', fg(v ? P.green : P.sub)]]
  if (r.type === 'flags')
    return r.choices.flatMap((c, i) => {
      const has = v.includes(c.value)
      const here = on && i === flag
      return [
        [`${has ? '■' : '□'} ${c.label}`, here ? BOLD + fg(P.blue) : fg(has ? P.text : P.sub)],
        [' ', ''],
      ]
    })
  const text = show(r, v)
  return on ? [['‹ ', fg(P.blue)], [text, BOLD + fg(P.text)], [' ›', fg(P.blue)]] : [[text, fg(P.text)]]
}

// Text cut into lines `cols` cells wide at spaces, a word too long for a
// line cut where it reaches the end. Newlines start a new line.
export function wrap(text, cols) {
  const out = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (width(next) <= cols) {
        line = next
        continue
      }
      if (line) out.push(line)
      line = ''
      let rest = word
      while (width(rest) > cols) {
        let cut = ''
        for (const ch of rest) {
          if (width(cut + ch) > cols) break
          cut += ch
        }
        out.push(cut)
        rest = rest.slice(cut.length)
      }
      line = rest
    }
    out.push(line)
  }
  return out
}

// The todo the hand-off and the filer are shown with: placeholders in braces.
const EXAMPLE = { id: '{id}', title: '{title}', note: '{note}', cat: '{cat}', repo: '{repo}', branch: '{branch}', root: '{repo path}', worktree: '', cwd: '{repo path}' }
const CLI = '~/.config/ghostty/bin/ghostty-todo'

// The part of an agent's prompt the code builds, which Settings can't change.
const FILER_ARGS = [EXAMPLE, [{ repo: '{repo}', root: '{repo path}' }], ['{folder}'], CLI]
export function fixedPart(id) {
  if (id === 'task') return '{the prompt you type in New agent}'
  if (id === 'pr-babysit') return '/pr-babysit {target}'
  if (id === 'logger') return '/logger watch {target}'
  if (id === 'todo-handoff') return handoffSpec(EXAMPLE, {}, () => true).prompt
  return filerPrompt(...FILER_ARGS)
}

// All an agent is sent, in parts with a heading each. The filer's fixed part
// and your instructions go in as its system prompt, the skill with its
// message; every other agent gets one prompt.
export function fullPrompt(id) {
  if (id === 'todo-filing')
    return [
      { tag: 'SYSTEM PROMPT, added to Claude Code’s', text: filerSystem(...FILER_ARGS) },
      { tag: 'MESSAGE', text: filerMessage('{what you typed}') },
    ]
  return [{ tag: 'AS SENT', text: compose(id, fixedPart(id)) }]
}

function save(s, fn) {
  try {
    fn()
    s.note = null
  } catch (err) {
    s.note = { text: `Couldn't save: ${err.code ?? err.message}`, color: P.red }
  }
}

export function pickSection(s, i) {
  s.sec = (i + SECTIONS.length) % SECTIONS.length
  s.sel = 0
  s.flag = 0
  s.scroll = 0
}

export function pickRow(s, i) {
  s.sel = Math.max(0, Math.min(items(s).length - 1, i))
  s.flag = 0
}

// ←/→: the next value, the next skill on disk, or in a row of flags the
// next flag. A prompt has nothing to step.
export function change(s, dir) {
  const r = current(s)
  if (r.prompt) return
  if (r.type === 'flags') s.flag = (s.flag + dir + r.choices.length) % r.choices.length
  else if (r.type === 'skill') save(s, () => set(r.key, stepSkill(load()[r.key], dir)))
  else save(s, () => set(r.key, step(r, load()[r.key], dir)))
}

// Space or ↵: a switch or flag turned over, a prompt opened, else the next
// value.
export function toggle(s) {
  const r = current(s)
  if (r.prompt) return openView(s)
  if (r.type === 'skill') return change(s, 1)
  const v = load()[r.key]
  if (r.type === 'flags') save(s, () => set(r.key, toggleFlag(r, v, r.choices[s.flag].value)))
  else save(s, () => set(r.key, step(r, v, 1)))
}

export function openView(s) {
  s.view = current(s).prompt
  s.viewScroll = 0
}

// r: a setting back to its default. On a prompt it clears your
// instructions, on the second r in a row, as there's no default to go back to.
function resetKey(s, confirming) {
  const r = current(s)
  if (!r.prompt) return save(s, () => reset(r.key))
  if (!instructions(r.prompt)) return
  if (confirming !== r.prompt) {
    s.confirm = r.prompt
    s.note = { text: `r again clears your ${agent(r.prompt).name} instructions`, color: P.peach }
    return
  }
  save(s, () => clear(r.prompt))
}

// e: your instructions for an agent, in a field to type them in.
export function startTyping(s, id) {
  s.view = null
  s.typing = { id, field: fromText(instructions(id)) }
}

// A key while typing: ctrl+s saves and closes the field, esc drops it.
function onTypingKey(s, key) {
  const done = textKey(s.typing.field, key)
  if (done === 'cancel') s.typing = null
  if (done === 'save') {
    const { id, field } = s.typing
    save(s, () => savePrompt(id, field.lines.join('\n')))
    if (!s.note) s.typing = null
  }
}

// Pasted text goes into the field while typing; elsewhere it's dropped.
export const onPaste = (s, text) => {
  if (s.typing) insert(s.typing.field, text)
}

// A key while an agent's whole prompt is open.
function onViewKey(s, key) {
  const actions = {
    '\x1b': () => (s.view = null),
    q: () => (s.view = null),
    v: () => (s.view = null),
    '\x7f': () => (s.view = null),
    j: () => (s.viewScroll += 1),
    k: () => (s.viewScroll = Math.max(0, s.viewScroll - 1)),
    '\x1b[B': () => (s.viewScroll += 1),
    '\x1b[A': () => (s.viewScroll = Math.max(0, s.viewScroll - 1)),
    g: () => (s.viewScroll = 0),
    e: () => startTyping(s, s.view),
  }
  if (Object.hasOwn(actions, key)) actions[key]()
}

// A key: 'quit' when it closes the panel, else nothing.
export function onKey(s, key) {
  // ctrl+c, and the Alt+S that opened it, close it from anywhere.
  if (key === '\x03' || key === '\x1bs') return 'quit'
  if (s.typing) return void onTypingKey(s, key)
  const confirming = s.confirm
  s.confirm = null
  if (confirming && s.note?.color === P.peach) s.note = null
  if (s.view) return void onViewKey(s, key)
  const onPrompt = Boolean(current(s).prompt)
  const actions = {
    q: () => 'quit',
    '\x1b': () => 'quit',
    j: () => pickRow(s, s.sel + 1),
    k: () => pickRow(s, s.sel - 1),
    '\x1b[B': () => pickRow(s, s.sel + 1),
    '\x1b[A': () => pickRow(s, s.sel - 1),
    g: () => pickRow(s, 0),
    G: () => pickRow(s, Infinity),
    '\t': () => pickSection(s, s.sec + 1),
    '\x1b[Z': () => pickSection(s, s.sec - 1),
    J: () => pickSection(s, s.sec + 1),
    K: () => pickSection(s, s.sec - 1),
    h: () => change(s, -1),
    l: () => change(s, 1),
    '\x1b[D': () => change(s, -1),
    '\x1b[C': () => change(s, 1),
    ' ': () => toggle(s),
    '\r': () => toggle(s),
    r: () => resetKey(s, confirming),
    ...(onPrompt && { e: () => startTyping(s, current(s).prompt), v: () => openView(s) }),
  }
  if (!Object.hasOwn(actions, key)) return undefined
  return actions[key]() === 'quit' ? 'quit' : undefined
}
