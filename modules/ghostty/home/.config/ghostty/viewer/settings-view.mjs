#!/usr/bin/env node
// The rail's ⚙ settings panel, laid out like Alt+H's keys: the sections down
// the left, the selected one's settings on the right. Every change is saved
// to hub/settings.mjs's file as it's made; a setting changed from its default
// carries a peach dot, and r puts it back. It runs in a tmux popup
// (bin/ghostty-settings), where tmux's own bindings don't apply. What keys do
// is in settings-nav.mjs; it takes no clicks.
//   settings-view.mjs [section id]   the section it opens on

import { BOLD, P, bg, enter, fg, leave, paint, render, split, tokens, width } from '../hub/term.mjs'
import { SECTIONS, settingsFile, load, show } from '../hub/settings.mjs'
import { AGENTS, agent, defaultOf, instructions } from '../hub/prompts.mjs'
import { BOTTOM, NAV, TOP, VALUE, current, fullPrompt, onKey, onPaste, start, valueSpans, wrap } from './settings-nav.mjs'
import { layout } from './textarea.mjs'

const s = start(process.argv[2])

const cols = () => process.stdout.columns || 80
const rows = () => process.stdout.rows || 24
const bodyRows = () => Math.max(1, rows() - TOP - BOTTOM)
const BASE = bg(P.base)
const SEL = bg(P.surface0)
const tilde = p => p.replace(process.env.HOME ?? '\0', '~')

// The right side: each heading, then two lines a setting: its name and value,
// and what it does. An agent's prompt shows the start of what it's sent, and
// your instructions' first line under that. `at` and `end` are each row's
// first and last line, for scrolling.
function content(w, values) {
  const lines = []
  const at = []
  const end = []
  let i = 0
  for (const r of SECTIONS[s.sec].rows) {
    if (r.head) {
      if (lines.length) lines.push(render([], w, BASE))
      lines.push(render([[r.head.toUpperCase(), BOLD + fg(P.peach)]], w, BASE))
      continue
    }
    const on = i === s.sel
    const fill = on ? SEL : BASE
    if (r.prompt) {
      at.push(lines.length)
      const { lines: own, cursorLine } = promptLines(r, w, on, fill)
      // While typing, the field's cursor is what has to stay in view.
      end.push(cursorLine === undefined ? lines.length + own.length - 1 : lines.length + cursorLine)
      lines.push(...own)
      i++
      continue
    }
    const v = values[r.key]
    const changed = JSON.stringify(v) !== JSON.stringify(r.default)
    const vw = r.type === 'flags' ? Math.min(w - 20, r.choices.reduce((n, c) => n + width(c.label) + 3, 0)) : VALUE
    at.push(lines.length)
    lines.push(
      render([[changed ? '• ' : '  ', fg(P.peach)], [r.label, (on ? BOLD : '') + fg(P.text)]], w - vw, fill) +
        render(valueSpans(r, v, on, s.flag), vw, fill),
    )
    const sub = changed ? [r.sub, `default ${show(r, r.default)}`].filter(Boolean).join(' · ') : r.sub
    lines.push(render([[`  ${sub}`, fg(P.overlay1)]], w, fill))
    end.push(lines.length - 1)
    i++
  }
  return { lines, at, end }
}

// An agent's prompt: the start of what it's sent, then your instructions'
// first line, or while you type them, the field with every line.
function promptLines(r, w, on, fill) {
  const id = r.prompt
  const yours = instructions(id)
  const count = yours ? yours.split('\n').filter(l => l.trim()).length : 0
  // Changed from its default: none for most, the two rules for the worktree.
  const changed = yours !== defaultOf(id)
  const typing = s.typing?.id === id
  const lineCount = `${count} line${count === 1 ? '' : 's'}`
  const value = typing ? 'typing' : !count ? 'e to add instructions' : changed ? `your ${lineCount}` : `default, ${lineCount}`
  const sent = fullPrompt(id)[0].text.replace(/\s*\n\s*/g, ' ')
  const lines = [
    render([[changed ? '• ' : '  ', fg(P.peach)], [r.label, (on ? BOLD : '') + fg(P.text)]], w - VALUE, fill) +
      render([[value, count || typing ? (on ? BOLD : '') + fg(P.text) : fg(P.overlay1)]], VALUE, fill),
    render([[`  ${agent(id).partOf ? `added to the hand-off’s prompt when its agent gets its own worktree` : sent}`, fg(P.overlay1)]], w, fill),
  ]
  if (!typing) {
    if (yours) lines.push(render([[`  ${wrap(yours, w)[0]}`, fg(P.text)]], w, fill))
    return { lines }
  }
  const BAR = '  ▌ '
  const { rows: field, cursor } = layout(s.typing.field, w - BAR.length - 1)
  field.forEach((row, y) => {
    const spans = [[BAR, fg(P.blue)]]
    if (y !== cursor.y) spans.push([row, fg(P.text)])
    else {
      const cs = [...row]
      spans.push([cs.slice(0, cursor.i).join(''), fg(P.text)], [cs[cursor.i] ?? ' ', bg(P.text) + fg(P.base)], [cs.slice(cursor.i + 1).join(''), fg(P.text)])
    }
    lines.push(render(spans, w, fill))
  })
  return { lines, cursorLine: 2 + cursor.y }
}

function navRow(i) {
  const on = i === s.sec
  return render([[` ${on ? '▸' : ' '} `, fg(P.blue)], [SECTIONS[i].name, on ? BOLD + fg(P.text) : fg(P.sub)]], NAV - 1, on ? SEL : BASE)
}

const hintSpans = hints => [
  [' '],
  ...hints.flatMap(([k, what]) => [
    [k, fg(P.text)],
    [` ${what}  `, fg(P.sub)],
  ]),
]

function footerRight() {
  if (s.note) return [[`${s.note.text} `, fg(s.note.color)]]
  // The prompts folder's full path is too long beside the keys; it's in the
  // dotfiles repo, beside hub/.
  const id = s.view ?? current(s).prompt
  return [[`${id ? `prompts/${id}.md` : `saved to ${tilde(settingsFile())}`} `, fg(P.overlay1)]]
}

// An agent's whole prompt over the panel, as Claude gets it.
function drawView(w) {
  const a = AGENTS.find(x => x.id === s.view)
  const tw = w - 4
  const body = []
  for (const part of fullPrompt(a.id)) {
    if (body.length) body.push(render([], w, BASE))
    body.push(render([[`  ${part.tag}`, BOLD + fg(P.peach)]], w, BASE))
    for (const l of wrap(part.text, tw)) body.push(render([[`  ${l}`, fg(P.text)]], w, BASE))
  }
  const room = bodyRows()
  s.viewScroll = Math.max(0, Math.min(s.viewScroll, body.length - room))
  const lines = [
    split([[` Settings · ${SECTIONS[s.sec].name} › ${a.name} prompt`, BOLD + fg(P.blue)]], [['esc', fg(P.text)], [' back ', fg(P.sub)]], w, BASE),
    render([], w, BASE),
    render([[` what ${a.about} is sent; {braces} are filled in when it starts`, fg(P.sub)]], w, BASE),
    render([], w, BASE),
  ]
  for (let y = 0; y < room; y++) {
    const more = y === room - 1 && s.viewScroll + room < body.length
    lines.push(more ? render([['  ▾ more', fg(P.overlay1)]], w, BASE) : (body[s.viewScroll + y] ?? render([], w, BASE)))
  }
  lines.push(split(hintSpans([['↑↓', 'scroll'], ['e', 'edit yours'], ['esc', 'back']]), footerRight(), w, BASE))
  paint(lines.slice(0, rows()))
}

function draw() {
  const w = cols()
  if (s.view) return drawView(w)
  const right = w - NAV - 2
  const { lines: body, at, end } = content(right, load())
  // Keep the selected setting in view, with the line above it, which is its
  // heading for the first under one; the first setting scrolls to the top.
  const first = at[s.sel] ?? 0
  const last = end[s.sel] ?? first
  if (s.sel === 0 || first - 1 < s.scroll) s.scroll = s.sel === 0 ? 0 : first - 1
  if (last >= s.scroll + bodyRows()) s.scroll = last + 1 - bodyRows()
  s.scroll = Math.max(0, Math.min(s.scroll, Math.max(0, body.length - bodyRows())))

  const lines = [
    split([[` Settings · ${SECTIONS[s.sec].name}`, BOLD + fg(P.blue)]], [['esc', fg(P.text)], [' close ', fg(P.sub)]], w, BASE),
    render([], w, BASE),
    render([[` ${SECTIONS[s.sec].where}`, fg(P.sub)]], w, BASE),
    render([], w, BASE),
  ]
  for (let y = 0; y < bodyRows(); y++) {
    const nav = y < SECTIONS.length ? navRow(y) : render([], NAV - 1, BASE)
    const more = y === bodyRows() - 1 && s.scroll + bodyRows() < body.length
    const line = more ? render([['▾ more', fg(P.overlay1)]], right, BASE) : (body[s.scroll + y] ?? render([], right, BASE))
    lines.push(`${nav}${render([['│', fg(P.surface0)]], 1, BASE)}${BASE} ${line}`)
  }
  const r = current(s)
  if (s.typing) {
    const hints = [['ctrl+s', 'save'], ['esc', 'cancel'], ['↵', 'new line'], ['↑↓←→', 'move']]
    lines.push(split(hintSpans(hints), footerRight(), w, BASE))
    return paint(lines.slice(0, rows()))
  }
  const keys = r.prompt
    ? [['e', 'edit yours'], ['v', 'full prompt'], ['r', 'clear yours']]
    : r.type === 'flags'
      ? [['←→', 'pick'], ['space', 'turn on/off'], ['r', 'default']]
      : r.type === 'bool'
        ? [['space', 'turn on/off'], ['r', 'default']]
        : [['←→', 'change'], ['r', 'default']]
  lines.push(split(hintSpans([['↑↓', 'setting'], ['tab', 'section'], ...keys]), footerRight(), w, BASE))
  paint(lines.slice(0, rows()))
}

const quit = () => {
  leave()
  process.exit(0)
}

if (!process.stdin.isTTY) {
  console.error('settings-view needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data.toString('utf8'))) {
    if (t.paste !== undefined) onPaste(s, t.paste)
    else if (t.key && onKey(s, t.key) === 'quit') quit()
  }
  draw()
})
process.stdout.on('resize', draw)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
enter()
draw()
