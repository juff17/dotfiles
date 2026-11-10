#!/usr/bin/env node
// The Alt+A popup: what babysitters proposed, one at a time, with what will
// run when you approve it. A reply shows the comment it answers and the
// exact text it posts; a push its commits, each opening to its diff and
// each one you can drop, its checks and the git command. Approving runs the
// proposal's own approval.py (pr-babysit), the same as the tray's buttons.
// It runs in a tmux popup (bin/ghostty-approvals); approvals.mjs has the
// keys.
//   approvals-view.mjs [id]   open on that proposal

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readState } from '../hub/client.mjs'
import { insertAt } from '../hub/line.mjs'
import { load as loadSettings, set as setSetting } from '../hub/settings.mjs'
import { BOLD, P, ago, bg, clean, enter, fg, leave, paint, render, split, tokens } from '../hub/term.mjs'
import { go, proposalLink, readApprovals, runApproval } from '../hub/tray.mjs'
import * as A from './approvals.mjs'
import { clampScroll, bodyRows as diffBodyRows, followCursor, parseDiff, parseNameStatus, parseNumstat } from './diff.mjs'
import { diffRow, fileRow, scaleOf } from './diff-rows.mjs'
import { caretShown, withCaret, wrap } from './todo-ui.mjs'

const s = A.start(readApprovals(), process.argv[2] ?? '')
const cols = () => process.stdout.columns || 100
const rows = () => process.stdout.rows || 30
const BASE = bg(P.base)
const BOX = bg(P.mantle)
const SEL = bg(P.surface0)
let busy = ''

// ------------------------------------------------------------ pieces

const blank = w => render([], w, BASE)
const label = (text, w, color = P.sub) => render([[` ${text}`, BOLD + fg(color)]], w, BASE)
const short = sha => String(sha ?? '').slice(0, 7)
const stat = c => `+${c.added ?? 0} −${c.removed ?? 0}`

// Text in a dark box, wrapped with its own line breaks kept, at most
// `most` lines.
function box(text, w, most = Infinity, { caret } = {}) {
  const inner = w - 6
  const kept = String(text ?? '')
    .split('\n')
    .map(clean)
    .join('\n')
  let lines = wrap(caret === undefined ? kept : withCaret(text, caret), inner)
  if (lines.length > most) lines = [...lines.slice(0, most - 1), `${lines[most - 1]} …`]
  return [
    render([], 2, BASE) + render([], w - 4, BOX) + render([], 2, BASE),
    ...lines.map(l => render([], 2, BASE) + render([[' '], [caret === undefined ? l : caretShown(l), fg(P.text)]], w - 4, BOX) + render([], 2, BASE)),
    render([], 2, BASE) + render([], w - 4, BOX) + render([], 2, BASE),
  ]
}

// ------------------------------------------------------------ the diff

// git in the push's worktree; '' when it fails.
const gitOut = (p, args) => {
  try {
    return execFileSync('git', ['-C', p.worktree, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  } catch {
    return ''
  }
}

// The files from..to changed, with their counts, as the Diff mode lists them.
function diffFiles(p, from, to) {
  const counts = parseNumstat(gitOut(p, ['diff', '--numstat', '-M', '-z', from, to]))
  return parseNameStatus(gitOut(p, ['diff', '--name-status', '-M', '-z', from, to])).map(f => ({ ...f, ...(counts.get(f.path) ?? {}) }))
}

// The open file's diff rows.
function readOpen(p) {
  const d = s.diff
  const f = d?.files.find(x => x.path === d.open)
  if (!f) return
  d.rows = parseDiff(gitOut(p, ['diff', '-M', '--no-color', '--no-ext-diff', d.from, d.to, '--', f.path, ...(f.old ? [f.old] : [])]))
}

// The diff in place of the proposal: its title, then each file and the open
// one's lines, scrolled to keep the selected file in view.
function diffLines(w, height) {
  const d = s.diff
  const head = split(
    [
      [' DIFF ', BOLD + fg(P.crust) + bg(P.blue)],
      [`  ${clean(d.title)}`, BOLD + fg(P.text)],
    ],
    [[`${d.files.length} file${d.files.length === 1 ? '' : 's'} `, fg(P.sub)]],
    w,
    BASE,
  )
  if (!d.files.length) return [head, blank(w), render([['  No changes in these commits.', fg(P.sub)]], w, BASE)]
  const list = diffBodyRows(d.files, d.open, d.rows)
  const room = height - 2
  if (d.follow) d.scroll = followCursor(list, d.cursor, d.scroll, room)
  d.scroll = clampScroll(d.scroll, list.length, room)
  const most = scaleOf(d.files)
  const out = [head, blank(w)]
  for (const r of list.slice(d.scroll, d.scroll + room)) {
    if (r.kind === 'file') out.push(fileRow(d.files[r.i], { open: d.files[r.i].path === d.open, selected: r.i === d.cursor, width: w, most }))
    else if (r.kind === 'diff') out.push(diffRow(r.row, w))
    else out.push(blank(w))
  }
  return out
}

// ------------------------------------------------------------ the body

function body(p, w) {
  const out = [blank(w)]
  out.push(render([[` ${clean(p.title)}`, BOLD + fg(P.text)]], w, BASE))
  const where = `${p.pr?.repo ?? ''} ${p.pr?.ref ?? ''}`.trim()
  const meta = {
    reply: [where, p.thread?.where, p.thread?.id && `thread ${p.thread.id}`],
    push: [where, `${p.local} → ${p.remote}/${p.branch}`],
    move: [where, `${p.local} onto ${short(p.onto)}`],
  }[p.kind] ?? [where, p.job?.stage && `${p.job.stage} stage`, p.job?.id && `job ${p.job.id}`]
  out.push(render([[` ${meta.filter(Boolean).join(' · ')}`, fg(P.sub)]], w, BASE))
  out.push(render([[` proposed ${ago(p.at)} ago`, fg(P.overlay1)]], w, BASE))
  if (p.status === 'failed') {
    out.push(blank(w))
    for (const l of wrap(`✗ Failed: ${p.result?.message ?? ''}`, w - 2)) out.push(render([[` ${l}`, BOLD + fg(P.red)]], w, BASE))
  }
  out.push(blank(w))

  if (p.kind === 'reply') {
    out.push(label(p.thread?.author ? `THEIR COMMENT · @${p.thread.author}` : 'THEIR COMMENT', w))
    out.push(...box(p.thread?.body ?? '', w, 12))
    if (p.commit) {
      out.push(blank(w), label('WHAT I DID', w))
      out.push(
        render(
          [
            [`  ${short(p.commit.sha)}`, fg(P.green)],
            [`  ${clean(p.commit.subject)}  `, fg(P.text)],
            [stat(p.commit), fg(P.sub)],
          ],
          w,
          BASE,
        ),
      )
    }
    out.push(blank(w), label(s.editing ? 'REPLY THAT WILL BE POSTED · editing' : 'REPLY THAT WILL BE POSTED', w, P.peach))
    out.push(...box(s.editing ? s.draft : A.bodyOf(s, p), w, Infinity, s.editing ? { caret: s.at } : {}))
    const how = A.inline(process.env) ? 'Press e to edit it here.' : 'Press e to edit it in $EDITOR.'
    out.push(render([[` Posted as you, exactly as shown${s.edited ? ', with your edit' : ''}. ${how}`, fg(P.sub)]], w, BASE))
  } else if (p.kind === 'push') {
    out.push(label('COMMITS · space to keep or drop', w))
    ;(p.commits ?? []).forEach((c, i) => {
      const dropped = s.drop.has(c.sha)
      const on = i === s.commit
      const fill = on ? SEL : BOX
      const left = [
        [`  ${dropped ? '✗' : '✓'} `, fg(dropped ? P.red : P.green)],
        [short(c.sha), fg(dropped ? P.overlay1 : P.green)],
        [`  ${clean(c.subject)}`, dropped ? fg(P.overlay1) + '\x1b[9m' : fg(P.text)],
      ]
      const right = [
        [c.note ? `${clean(c.note)}  ` : '', fg(P.sub)],
        [`${stat(c)}  `, fg(P.sub)],
        ['▸ ', fg(P.blue)],
      ]
      out.push(render([], 1, BASE) + split(left, right, w - 2, fill) + render([], 1, BASE))
    })
    out.push(blank(w), label('CHECKS', w))
    const leaseOk = p.remote_head === p.lease
    const checks = [
      ...(p.checks ?? []).map(c => [c.ok, c.name]),
      [leaseOk, leaseOk ? `lease ${short(p.lease)} matches remote` : `remote moved to ${short(p.remote_head) || 'nothing'}`],
    ]
    out.push(render(checks.flatMap(([ok, name]) => [[' '], [` ${ok ? '✓' : '✗'} ${clean(name)} `, fg(ok ? P.green : P.red) + bg(ok ? '#1f2b26' : '#2b1f27')]]), w, BASE))
    if (p.removes?.length) {
      out.push(blank(w), label(`TAKES OFF THE BRANCH · ${p.removes.length} commit${p.removes.length === 1 ? '' : 's'} on ${p.branch} now`, w, P.red))
      for (const c of p.removes)
        out.push(
          render(
            [
              ['  − ', fg(P.red)],
              [short(c.sha), fg(P.red)],
              [`  ${clean(c.subject)}  `, fg(P.text)],
              [stat(c), fg(P.sub)],
            ],
            w,
            BASE,
          ),
        )
    }
    out.push(blank(w))
    const command = s.drop.size ? `${p.command}   (after dropping ${s.drop.size}: handed back to the session)` : p.command
    out.push(...box(command, w))
  } else {
    const what = {
      retry: `Retries ${p.job?.name} once.${p.job?.reason ? ` Why it looks flaky: ${p.job.reason}.` : ''}`,
      manual: `Starts the manual job ${p.job?.name}${p.job?.stage ? ` in the ${p.job.stage} stage` : ''}.`,
      deploy: `Approves ${p.job?.name} on GitHub, which lets its deployment or workflow run. This always asks.`,
      move: `The babysitter rebases its commits from ${short(p.lease)} onto ${short(p.onto)}, reruns lint and tests, then proposes the push.`,
    }[p.kind]
    out.push(label('WHAT APPROVING DOES', w))
    out.push(...box(what ?? '', w, 4))
  }
  return out
}

// The buttons: the approving one filled, with each one's key.
function buttons(p, w) {
  const n = (p.commits ?? []).length - s.drop.size
  const approve =
    p.status === 'failed'
      ? 'Try again'
      : {
          reply: 'Post reply',
          push: s.drop.size ? `Push ${n} of ${(p.commits ?? []).length}` : 'Push',
          retry: 'Retry',
          manual: 'Run',
          deploy: 'Approve',
          move: 'Move commits',
        }[p.kind]
  const list = [
    [approve, 'a', true],
    ...(p.kind === 'reply' && p.status === 'pending' ? [['Edit', 'e']] : []),
    ...(p.kind === 'push' ? [['Open diff', 'd']] : []),
    p.status === 'failed' ? ['Dismiss', 'x'] : [p.kind === 'push' || p.kind === 'move' ? 'Not yet' : 'Reject', 'r'],
    ['Go to session', 'g'],
    ...(proposalLink(p) ? [[`${proposalLink(p).label} ↗`, 'o']] : []),
  ]
  const spans = [[' ']]
  for (const [text, key, main] of list) {
    spans.push([` ${text} `, main ? BOLD + fg(P.crust) + bg(P.peach) : fg('edo'.includes(key) ? P.blue : P.sub) + bg(P.surface0)])
    spans.push([`${key} `, main ? fg(P.surface0) + bg(P.peach) : fg(P.overlay1) + bg(P.surface0)])
    spans.push(['  '])
  }
  const right = p.kind === 'push' ? [[`Refused if anyone pushed since ${short(p.lease)} `, fg(P.sub)]] : []
  return split(spans, right, w, BASE)
}

function footerKeys(p) {
  if (s.diff) return 'j k file · enter open/close · J K scroll · esc back'
  if (s.editing) return 'enter done · esc drop the edit · ←→ move · ctrl+u ctrl+w delete'
  if (!p) return 'esc close'
  if (p.kind === 'push') return '← → next · ↑ ↓ commits · enter its diff · d all · space keep/drop · A approve + always'
  if (p.kind === 'reply') return '← → next · e edit · A approve + always for replies'
  return p.kind === 'deploy' ? '← → next · r reject · g go to the session' : `← → next · A approve + always for ${p.kind === 'retry' ? 'retries' : 'this kind'}`
}

function draw() {
  const w = cols()
  const h = rows()
  const p = A.current(s)
  const count = s.list.length ? `${s.i + 1} of ${s.list.length}` : 'none'
  const lines = [
    split(
      [
        [' ▲ APPROVALS ', BOLD + fg(P.peach)],
        [` ${count}`, fg(P.sub)],
      ],
      [[`${loadSettings()['keys.approvals'] || 'esc'} close `, fg(P.sub)]],
      w,
      BASE,
    ),
    render([['─'.repeat(w)]], w, BASE + fg(P.surface0)),
  ]
  const room = h - lines.length - 4
  if (s.diff && p) {
    lines.push(...diffLines(w, h - lines.length - 1))
    while (lines.length < h - 1) lines.push(blank(w))
    lines.push(split([[` ${footerKeys(p)}`, fg(P.sub)]], [], w, BASE))
    return paint(lines.slice(0, h))
  }
  const main = p ? body(p, w) : [blank(w), render([['  Nothing is waiting for you.', fg(P.sub)]], w, BASE)]
  // What doesn't fit scrolls; a stays off until all of it has been shown.
  const fits = main.length <= room
  const view = fits ? room : room - 1
  s.scroll = Math.max(0, Math.min(s.scroll, main.length - view))
  lines.push(...main.slice(s.scroll, s.scroll + view))
  if (!fits) {
    const below = main.length - s.scroll - view
    lines.push(render([[below > 0 ? ` ▾ ${below} more lines: J or PgDn` : ' ▴ K or PgUp for the top', fg(P.overlay1)]], w, BASE))
  }
  s.seenTo = Math.max(s.seenTo, s.scroll + view)
  s.hidden = s.seenTo < main.length
  while (lines.length < h - 4) lines.push(blank(w))
  lines.push(p ? buttons(p, w) : blank(w))
  lines.push(blank(w))
  lines.push(render([['─'.repeat(w)]], w, BASE + fg(P.surface0)))
  const note = busy ? { text: busy, tone: 'sub' } : s.note
  const tone = { green: P.green, red: P.red, peach: P.peach, sub: P.sub }
  const dots = s.list.length > 1 ? s.list.slice(0, 12).map((_, i) => (i === s.i ? '●' : '○')).join(' ') : ''
  lines.push(
    split(
      [[` ${footerKeys(p)}`, fg(P.sub)]],
      [
        [note ? `${note.text}   ` : '', fg(tone[note?.tone] ?? P.sub)],
        [`${dots} `, fg(P.sub)],
      ],
      w,
      BASE,
    ),
  )
  paint(lines.slice(0, h))
}

// ------------------------------------------------------------ effects

function refresh(settledHere = false) {
  A.reload(s, readApprovals(), settledHere)
}

let closing = null
function closeSoonIfEmpty() {
  if (s.list.length || closing) return
  closing = setTimeout(quit, 1200)
}

async function settle(p, args, doing) {
  busy = doing
  draw()
  const r = await runApproval(p, args)
  busy = ''
  s.note = { text: r.message || (r.ok ? 'Done' : 'Failed'), tone: r.ok ? 'green' : 'red' }
  refresh(true)
  closeSoonIfEmpty()
  draw()
}

const sessionOf = p => {
  const agents = readState()?.agents ?? []
  return agents.find(a => p.claude_session && a.id === p.claude_session) ?? agents.find(a => p.pane && a.pane?.pane === p.pane)
}

// Runs a program on the whole terminal, then takes the popup back.
function outside(cmd, args) {
  leave()
  process.stdin.setRawMode(false)
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  process.stdin.setRawMode(true)
  enter()
  return r
}

async function run(e) {
  const p = e.p
  if (e.do === 'approve') {
    if (e.always) {
      try {
        setSetting(...A.alwaysSetting(p))
      } catch (err) {
        s.note = { text: `Couldn't save the setting: ${err.message}`, tone: 'red' }
      }
    }
    const args = ['approve', p.id]
    let dir = ''
    if (e.body !== undefined) {
      dir = mkdtempSync(join(tmpdir(), 'approval-'))
      writeFileSync(join(dir, 'body.txt'), e.body)
      args.push('--body-file', join(dir, 'body.txt'))
    }
    for (const sha of e.drop ?? []) args.push('--drop', sha)
    const doing = { reply: 'Posting…', push: e.drop ? 'Handing back…' : 'Pushing…', retry: 'Retrying…', manual: 'Starting…' }[p.kind] ?? 'Approving…'
    await settle(p, args, doing)
    if (dir) rmSync(dir, { recursive: true, force: true })
  } else if (e.do === 'reject') await settle(p, ['reject', p.id], 'Rejecting…')
  else if (e.do === 'dismiss') await settle(p, ['dismiss', p.id], 'Dismissing…')
  else if (e.do === 'go') {
    const a = sessionOf(p)
    if (!a) s.note = { text: 'The session that proposed this is gone', tone: 'red' }
    else {
      const r = await go(a)
      if (r.ok) return quit()
      s.note = { text: r.message, tone: 'red' }
    }
  } else if (e.do === 'editor') {
    const dir = mkdtempSync(join(tmpdir(), 'approval-'))
    const file = join(dir, 'reply.md')
    writeFileSync(file, `${e.text}\n`)
    const r = outside('sh', ['-c', `${process.env.EDITOR} "$1"`, 'sh', file])
    const text = r.status === 0 ? readFileSync(file, 'utf8').replace(/\n+$/, '') : null
    rmSync(dir, { recursive: true, force: true })
    if (r.status !== 0) s.note = { text: `$EDITOR exited with ${r.status}; reply unchanged`, tone: 'red' }
    const next = r.status === 0 ? A.edited(s, p, text) : undefined
    if (next) return run(next)
  } else if (e.do === 'open') {
    // In the browser, without waiting for it; the popup stays open.
    const child = spawn('xdg-open', [e.url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      s.note = { text: `Couldn't open ${e.url}: no xdg-open`, tone: 'red' }
      draw()
    })
    child.unref()
    s.note = { text: `Opened ${e.url}`, tone: 'green' }
  } else if (e.do === 'diff') {
    A.openDiff(s, { title: e.title, from: e.from, to: e.to, files: diffFiles(p, e.from, e.to) })
    readOpen(p)
  } else if (e.do === 'diffFile') readOpen(A.current(s))
  draw()
}

function quit() {
  leave()
  process.exit(0)
}

if (!process.stdin.isTTY) {
  console.error('approvals-view needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  if (busy) return
  for (const t of tokens(data.toString('utf8'))) {
    if (t.paste !== undefined && s.editing) {
      const { text, at } = insertAt(s.draft, s.at, t.paste)
      s.draft = text
      s.at = at < [...text].length ? at : undefined
      continue
    }
    if (!t.key) continue
    const e = A.onKey(s, t.key)
    if (e === 'quit') return quit()
    if (e) {
      run(e)
      return
    }
  }
  draw()
})
// New proposals come in while it's open; one approved elsewhere leaves.
setInterval(() => {
  if (busy || s.editing) return
  refresh()
  draw()
}, 2000)
process.stdout.on('resize', draw)
process.on('SIGTERM', quit)
process.on('SIGHUP', quit)
enter()
draw()
