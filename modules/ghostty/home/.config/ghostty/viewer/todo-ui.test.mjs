import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { launch } from '../hub/model.mjs'
import { arrange, handoffPlace, handoffSpec } from './todo.mjs'
import * as ui from './todo-ui.mjs'

// No settings file, so every setting reads as its default.
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'
process.env.AGENT_HUB_PROMPTS = '/nonexistent/agent-hub/prompts'

const now = new Date(2026, 10, 7, 15, 0).getTime()
const hour = 60 * 60 * 1000
const item = (id, cat, root, created, done = null) => ({ id, cat, root, repo: root.split('/').pop(), title: id, created, done })
const ids = list => list.map(i => i.id)

// Two repos, a filing, and one done today: the order j walks them in.
const sample = () => [
  item('a1', 'bug', '/r/dot', now - 3 * hour),
  item('a2', 'bug', '/r/other', now - hour),
  item('b1', 'feature', '/r/dot', now - 2 * hour),
  item('d1', 'docs', '/r/dot', now - 5 * hour, now - hour),
  { ...item('f1', 'other', '/r/dot', now - 4 * hour), filing: { started: now - 60000 } },
]
const view = (items = sample(), opts = {}) => arrange(items, { here: '/r/dot', now, ...opts })

test('the cursor walks filings, then each group, then done today only when shown', () => {
  assert.deepEqual(ids(ui.selectable(view(), false)), ['f1', 'a1', 'a2', 'b1'], 'this repo first in a group')
  assert.deepEqual(ids(ui.selectable(view(), true)), ['f1', 'a1', 'a2', 'b1', 'd1'])
  assert.deepEqual(ids(ui.selectable(view(sample(), { only: true }), false)), ['f1', 'a1', 'b1'], 'f keeps this repo')
  assert.deepEqual(ui.selectable(view([]), true), [])
})

test('the cursor item is the one by id, else the first, else none', () => {
  const list = ui.selectable(view(), false)
  assert.equal(ui.cursorItem(list, 'b1').id, 'b1')
  assert.equal(ui.cursorItem(list, 'gone').id, 'f1', 'a deleted item hands the cursor to the top')
  assert.equal(ui.cursorItem(list, '').id, 'f1')
  assert.equal(ui.cursorItem([], 'a1'), undefined)
})

test('moving clamps at both ends and g / G jump there', () => {
  const list = ui.selectable(view(), false)
  assert.equal(ui.moveTo(list, 'a1', 1), 'a2')
  assert.equal(ui.moveTo(list, 'a1', -1), 'f1')
  assert.equal(ui.moveTo(list, 'f1', -1), 'f1', 'stays on the first')
  assert.equal(ui.moveTo(list, 'b1', 1), 'b1', 'stays on the last')
  assert.equal(ui.moveTo(list, 'a1', 10), 'b1', 'a page past the end stops on the last')
  assert.equal(ui.moveTo(list, 'a2', -10), 'f1')
  assert.equal(ui.moveTo(list, 'a2', Infinity), 'b1')
  assert.equal(ui.moveTo(list, 'a2', -Infinity), 'f1')
  assert.equal(ui.moveTo(list, 'gone', 1), 'a1', 'from the top when the cursor item went away')
  assert.equal(ui.moveTo([], 'a1', 1), undefined)
  const one = [{ id: 'x' }]
  assert.equal(ui.moveTo(one, 'x', 1), 'x')
  assert.equal(ui.moveTo(one, 'x', -Infinity), 'x')
})

test('marking an item done moves the cursor on, or back from the last', () => {
  const list = ui.selectable(view(), false)
  assert.equal(ui.neighbour(list, list[1]).id, 'a2')
  assert.equal(ui.neighbour(list, list.at(-1)).id, 'a2', 'the last one done: the one before it')
  assert.equal(ui.neighbour([list[0]], list[0]), undefined, 'the only one done: nowhere to go')
})

test('marks drop items that are done, filing or deleted, but not ones f hides', () => {
  const marked = new Set(['a1', 'd1', 'f1', 'gone', 'b1', 'a2'])
  assert.deepEqual([...ui.pruneMarks(marked, sample())], ['a1', 'b1', 'a2'])
  // f (this repo only) hides a2: its mark stays for when f is off again,
  // but w only hands off what shows.
  const only = ui.selectable(view(sample(), { only: true }), false)
  const kept = ui.pruneMarks(new Set(['a2', 'a1']), sample())
  assert.deepEqual([...kept], ['a2', 'a1'])
  assert.deepEqual(ui.markedIds(only, kept), ['a1'])
  assert.deepEqual(ui.markedIds(ui.selectable(view(), false), kept), ['a1', 'a2'], 'back with f off')
  assert.deepEqual(ui.markedIds(only, new Set(['a2'])), [], 'only hidden marks: w takes the selected item instead')
})

test('hand-off takes the marks in list order, not the order they were marked', () => {
  const list = ui.selectable(view(), false)
  assert.deepEqual(ui.markedIds(list, new Set(['b1', 'a1'])), ['a1', 'b1'])
  assert.deepEqual(ui.markedIds(list, new Set()), [])
})

test('c cycles the categories in order and wraps; t runs through the types then none', () => {
  assert.equal(ui.nextCategory('bug'), 'feature')
  assert.equal(ui.nextCategory('other'), 'bug')
  assert.equal(ui.nextCategory('nonsense'), 'bug', 'an unknown category starts the ring')
  assert.equal(ui.nextType(null), 'research')
  assert.equal(ui.nextType(undefined), 'research')
  assert.equal(ui.nextType('research'), 'decide')
  assert.equal(ui.nextType('chore'), null)
  let type = null
  const seen = []
  for (let i = 0; i < 6; i++) seen.push((type = ui.nextType(type)))
  assert.deepEqual(seen, ['research', 'decide', 'action', 'review', 'chore', null])
})

test('every key with no prompt open does what the docs say', () => {
  const want = {
    q: 'quit', '\x03': 'quit', '\x1b': 'close', '\x1bt': 'close', '\t': 'next-mode',
    j: 'down', k: 'up', '\x1b[B': 'down', '\x1b[A': 'up',
    '\x04': 'page-down', '\x15': 'page-up', '\x1b[6~': 'page-down', '\x1b[5~': 'page-up',
    g: 'first', G: 'last', '\r': 'go', ' ': 'done', a: 'claude', A: 'manual', r: 'retry',
    e: 'edit', c: 'category', t: 'type', x: 'delete', m: 'mark', M: 'clear-marks', w: 'handoff',
    f: 'only', d: 'show-done',
  }
  assert.deepEqual(ui.KEYS, want)
  assert.equal(ui.KEYS.z, undefined)
  assert.equal(ui.KEYS.J, undefined, 'keys are case-sensitive')
})

test('in the popup Alt+T closes it even with a prompt open; other keys go to the prompt', () => {
  assert.equal(ui.promptTakes('\x1bt', true), false)
  assert.equal(ui.KEYS['\x1bt'], 'close')
  assert.equal(ui.promptTakes('\x1bt', false), true, 'in the pane it is the prompt’s to ignore')
  for (const key of ['\x1b', 'q', 't', '\r']) assert.equal(ui.promptTakes(key, true), true, `${key} stays with the prompt`)
})

test('input splits into mouse reports, escape sequences, Alt+letter and single keys', () => {
  assert.deepEqual(ui.parseInput('jk'), [{ key: 'j' }, { key: 'k' }])
  assert.deepEqual(ui.parseInput('\x1b[A\x1b[6~\x1bt\x1b'), [{ key: '\x1b[A' }, { key: '\x1b[6~' }, { key: '\x1bt' }, { key: '\x1b' }])
  assert.deepEqual(ui.parseInput('\x1b[<0;12;5M\x1b[<0;12;5m'), [
    { mouse: { button: 0, x: 12, y: 5, released: false } },
    { mouse: { button: 0, x: 12, y: 5, released: true } },
  ])
  assert.deepEqual(ui.parseInput('\x1b[Z'), [{ key: '\x1b[Z' }], 'shift+tab')
  // One key per code point, so an emoji or a CJK character arrives whole.
  assert.deepEqual(ui.parseInput('é漢😀'), [{ key: 'é' }, { key: '漢' }, { key: '😀' }])
  assert.deepEqual(ui.parseInput('a\rb'), [{ key: 'a' }, { key: '\r' }, { key: 'b' }])
  assert.deepEqual(ui.parseInput(''), [])
})

test('the mouse: the wheel moves, a left press picks a row or a mode, nothing else does', () => {
  const at = { prompt: null, top: 3, height: 10 }
  assert.deepEqual(ui.mouseAction({ button: 64, x: 1, y: 5 }, at), { move: -1 })
  assert.deepEqual(ui.mouseAction({ button: 65, x: 1, y: 5 }, at), { move: 1 })
  assert.deepEqual(ui.mouseAction({ button: 0, x: 4, y: 1 }, at), { header: 4 })
  assert.deepEqual(ui.mouseAction({ button: 0, x: 4, y: 3 }, at), { row: 0 })
  assert.deepEqual(ui.mouseAction({ button: 0, x: 4, y: 12 }, at), { row: 9 })
  assert.equal(ui.mouseAction({ button: 0, x: 4, y: 13 }, at), null, 'the status row')
  assert.equal(ui.mouseAction({ button: 0, x: 4, y: 2 }, at), null, 'the summary')
  assert.equal(ui.mouseAction({ button: 0, x: 4, y: 5, released: true }, at), null)
  assert.equal(ui.mouseAction({ button: 2, x: 4, y: 5 }, at), null, 'right button')
  assert.equal(ui.mouseAction({ button: 32, x: 4, y: 5 }, at), null, 'a drag')
  assert.equal(ui.mouseAction({ button: 0, x: 4, y: 5 }, { ...at, prompt: {} }), null, 'no clicks under a prompt')
  assert.deepEqual(ui.mouseAction({ button: 65, x: 4, y: 5 }, { ...at, prompt: {} }), { move: 1 }, 'the wheel still moves under a prompt')
})

test('the mode header maps columns to its tabs, the gap between to none', () => {
  const modes = [{ label: ' Diagrams ' }, { label: ' Files ' }, { label: ' Diff ' }, { label: ' Todo ' }]
  assert.equal(ui.modeAt(1, modes), modes[0])
  assert.equal(ui.modeAt(10, modes), modes[0])
  assert.equal(ui.modeAt(11, modes), undefined, 'the space between tabs')
  assert.equal(ui.modeAt(12, modes), modes[1])
  assert.equal(ui.modeAt(26, modes), undefined)
  assert.equal(ui.modeAt(27, modes), modes[3])
  assert.equal(ui.modeAt(32, modes), modes[3])
  assert.equal(ui.modeAt(99, modes), undefined)
})

test('a line being typed: backspace, Ctrl+U, Ctrl+W, and printable keys only', () => {
  assert.equal(ui.editText('fix it', 'x'), 'fix itx')
  assert.equal(ui.editText('fix it', '\x7f'), 'fix i')
  assert.equal(ui.editText('fix it', '\b'), 'fix i')
  assert.equal(ui.editText('', '\x7f'), '', 'backspace on nothing')
  assert.equal(ui.editText('fix it', '\x15'), '')
  assert.equal(ui.editText('fix the bug ', '\x17'), 'fix the ', 'Ctrl+W takes the trailing space with the word')
  assert.equal(ui.editText('one', '\x17'), '')
  assert.equal(ui.editText('fix', '\x1b[C'), 'fix', 'arrows type nothing')
  assert.equal(ui.editText('fix', '\x1bt'), 'fix')
  assert.equal(ui.editText('fix', '\n'), 'fix', 'control characters type nothing')
  assert.equal(ui.editText('fix', '\t'), 'fix')
})

test('backspace takes a whole wide character, not half of one', () => {
  assert.equal(ui.editText('漢字', '\x7f'), '漢')
  assert.equal(ui.editText('ok 😀', '\x7f'), 'ok ')
  assert.equal(ui.editText('é', '\x7f'), '')
  let text = ''
  for (const { key } of ui.parseInput('日本😀')) text = ui.editText(text, key)
  assert.equal(text, '日本😀')
  // A grapheme built of several code points loses one code point at a time.
  assert.equal(ui.editText('👍🏽', '\x7f'), '👍')
})

test('the prompts keep the caret, and leave it off at the end', () => {
  const p = { kind: 'claude', text: 'fix' }
  ui.promptKey(p, '\x1b[D', undefined)
  ui.promptKey(p, 'o', undefined)
  assert.deepEqual(p, { kind: 'claude', text: 'fiox', at: 3 })
  ui.promptKey(p, '\x1b[F', undefined)
  assert.deepEqual(p, { kind: 'claude', text: 'fiox' })
  const edit = ui.editPrompt({ id: 'a1', title: 'ship', cat: 'bug', note: 'later' })
  ui.editKey(edit, '\x1b[D')
  ui.editKey(edit, 'x')
  assert.equal(edit.title, 'shixp')
  assert.equal(edit.at, 4)
  ui.editKey(edit, '\t')
  assert.equal(edit.at, undefined, 'a new field starts at its end')
})

test('adding by hand: title, then category, then note, then add', () => {
  const current = item('a1', 'docs', '/r/dot', now)
  let step = ui.promptKey({ kind: 'title', text: '' }, 'h', current)
  assert.deepEqual(step, { prompt: { kind: 'title', text: 'h' } })
  step = ui.promptKey({ kind: 'title', text: '  ship it  ' }, '\r', current)
  assert.deepEqual(step.prompt, { kind: 'cat', title: 'ship it', replaces: undefined, cat: 'docs' }, 'the picker starts on the selected item’s category')
  assert.equal(ui.promptKey({ kind: 'title', text: 'x' }, '\r', undefined).prompt.cat, 'follow-up', 'or the default on an empty list')
  assert.equal(ui.promptKey({ kind: 'title', text: 'x' }, '\r', { filing: {}, cat: 'bug' }).prompt.cat, 'follow-up', 'a filing has no real category')
  const cat = { kind: 'cat', title: 'ship it', cat: 'docs' }
  assert.deepEqual(ui.promptKey(cat, '1', current).prompt, { kind: 'note', title: 'ship it', cat: 'bug', text: '' })
  assert.equal(ui.promptKey(cat, '\r', current).prompt.cat, 'docs', '↵ keeps the one it started on')
  assert.equal(ui.promptKey(cat, '6', current).prompt.cat, 'other')
  for (const key of ['0', '7', 'x', ' ']) assert.deepEqual(ui.promptKey(cat, key, current), { prompt: cat, run: 'ignore' }, `${key} picks nothing`)
  const note = { kind: 'note', title: 'ship it', cat: 'bug', text: '  later  ', replaces: 'f9' }
  assert.deepEqual(ui.promptKey(note, '\r', current), { prompt: null, run: 'add', add: { title: 'ship it', cat: 'bug', note: 'later', replaces: 'f9' } })
  assert.equal(ui.promptKey({ ...note, text: '' }, '\r', current).add.note, '', '↵ on an empty note skips it')
})

test('an empty title or message closes the prompt; esc and Ctrl+C cancel any', () => {
  assert.deepEqual(ui.promptKey({ kind: 'title', text: '   ' }, '\r'), { prompt: null })
  assert.deepEqual(ui.promptKey({ kind: 'claude', text: '' }, '\r'), { prompt: null })
  for (const kind of ['claude', 'title', 'cat', 'note', 'edit', 'handoff']) {
    assert.deepEqual(ui.promptKey({ kind, text: 'x' }, '\x1b'), { prompt: null }, kind)
    assert.deepEqual(ui.promptKey({ kind, text: 'x' }, '\x03'), { prompt: null }, kind)
  }
})

test('the Claude prompt sends its message, and Shift+A on an empty line adds by hand', () => {
  assert.deepEqual(ui.promptKey({ kind: 'claude', text: '  look at the diff  ' }, '\r'), { prompt: null, run: 'file', text: 'look at the diff' })
  assert.equal(ui.promptKey({ kind: 'claude', text: '' }, 'A').run, 'manual')
  assert.deepEqual(ui.promptKey({ kind: 'claude', text: 'Fix ' }, 'A'), { prompt: { kind: 'claude', text: 'Fix A' } }, 'a capital A in a message')
  assert.deepEqual(ui.promptKey({ kind: 'title', text: '' }, 'A'), { prompt: { kind: 'title', text: 'A' } }, 'only the Claude prompt switches')
})

test('a confirm takes only its own key; any other keeps things as they were', () => {
  const del = { kind: 'confirm', key: 'x', yes: () => {} }
  assert.deepEqual(ui.promptKey(del, 'x'), { prompt: null, run: 'yes' })
  assert.deepEqual(ui.promptKey(del, 'X'), { prompt: null, run: '' })
  assert.deepEqual(ui.promptKey(del, '\x1b'), { prompt: null, run: '' })
  const reopen = { kind: 'confirm', key: '\r', yes: () => {} }
  assert.equal(ui.promptKey(reopen, '\r').run, 'yes')
  assert.equal(ui.promptKey(reopen, 'x').run, '')
})

test('the edit and hand-off prompts pass their keys on', () => {
  assert.deepEqual(ui.promptKey({ kind: 'edit' }, 'x'), { prompt: { kind: 'edit' }, run: 'edit' })
  assert.deepEqual(ui.promptKey({ kind: 'handoff' }, '\r'), { prompt: { kind: 'handoff' }, run: 'handoff' })
})

test('Shift+A on a failed filing starts from its message, else from nothing', () => {
  const failed = { id: 'f1', title: 'the message', filing: { started: now, error: 'no' } }
  assert.deepEqual(ui.manualPrompt(failed), { kind: 'title', text: 'the message', replaces: 'f1' })
  assert.deepEqual(ui.manualPrompt({ ...failed, filing: { started: Date.now() } }), { kind: 'title', text: '' }, 'not while it is still filing')
  assert.deepEqual(ui.manualPrompt(item('a1', 'bug', '/r/dot', now)), { kind: 'title', text: '' })
  assert.deepEqual(ui.manualPrompt(undefined), { kind: 'title', text: '' }, 'an empty list')
})

test('what a filing item says when you try to change it', () => {
  assert.match(ui.filingHint({ filing: { started: Date.now() } }), /still filing/)
  assert.match(ui.filingHint({ filing: { started: Date.now(), error: 'x' } }), /^r retries/)
})

const REPOS = [
  { repo: 'dot', root: '/r/dot' },
  { repo: 'other', root: '/r/other' },
  { repo: 'website', root: '/r/website' },
]
const edit = (fields = {}, repos = REPOS) => ({ ...ui.editPrompt({ id: 'a1', title: 'Fix it', cat: 'bug', repo: 'dot', root: '/r/dot', ...fields }, repos) })

test('the edit form starts on the title, with no type or note as null and empty', () => {
  const { repos, repo, from, ...rest } = edit()
  assert.deepEqual(rest, { kind: 'edit', id: 'a1', field: 'title', title: 'Fix it', cat: 'bug', type: null, find: '', note: '' })
  assert.equal(repo, REPOS[0])
  assert.equal(from, repo)
  assert.equal(edit({ type: 'review', note: 'n' }).type, 'review')
})

test('the edit form offers the known repos, then none, with the item’s own first when they lack it', () => {
  assert.deepEqual(edit().repos, [...REPOS, ui.NO_REPO])
  const gone = edit({ repo: 'old', root: '/x/old' })
  assert.deepEqual(gone.repos.map(r => r.repo), ['old', 'dot', 'other', 'website', 'none'])
  assert.equal(gone.repo, gone.repos[0])
  assert.equal(edit({ repo: 'none', root: '/home/me' }).repo, ui.NO_REPO)
})

test('tab and the arrows move round the edit form’s fields', () => {
  const p = edit()
  const walk = keys => keys.map(k => ui.editKey(p, k).field)
  assert.deepEqual(walk(['\t', '\t', '\t', '\t', '\t']), ['cat', 'type', 'repo', 'note', 'title'])
  assert.deepEqual(walk(['\x1b[Z', '\x1b[A', '\x1b[B']), ['note', 'repo', 'note'], 'shift+tab and ↑ go back, ↓ on')
})

test('the edit form’s category takes 1–6 or ←/→ and wraps', () => {
  const p = { ...edit(), field: 'cat' }
  assert.equal(ui.editKey(p, '\x1b[D').cat, 'other', '← from the first wraps to the last')
  assert.equal(ui.editKey(p, '\x1b[C').cat, 'bug')
  assert.equal(ui.editKey(p, ' ').cat, 'feature', 'space steps on too')
  assert.equal(ui.editKey(p, '4').cat, 'docs')
  assert.equal(ui.editKey(p, '0').cat, 'docs', '0 is not a category')
  assert.equal(ui.editKey(p, '9').cat, 'docs')
  assert.equal(ui.editKey(p, 'x').cat, 'docs', 'letters do not type into it')
})

test('the edit form’s type takes 1–5, 0 for none, or ←/→ round a ring with none in it', () => {
  const p = { ...edit(), field: 'type' }
  assert.equal(ui.editKey(p, '\x1b[C').type, 'research', 'from none')
  assert.equal(ui.editKey(p, '\x1b[D').type, null)
  assert.equal(ui.editKey(p, '\x1b[D').type, 'chore', '← from none to the last')
  assert.equal(ui.editKey(p, '\x1b[C').type, null)
  assert.equal(ui.editKey(p, '3').type, 'action')
  assert.equal(ui.editKey(p, '0').type, null)
  assert.equal(ui.editKey(p, '6').type, null, 'past the types picks nothing')
})

test('the edit form’s title and note take text, including wide characters', () => {
  const p = edit()
  for (const key of [' ', '漢', '😀']) ui.editKey(p, key)
  assert.equal(p.title, 'Fix it 漢😀')
  ui.editKey(p, '\x7f')
  assert.equal(p.title, 'Fix it 漢')
  ui.editKey(p, '\x17')
  assert.equal(p.title, 'Fix it ')
  for (const key of ['\t', '\t', '\t', '\t']) ui.editKey(p, key)
  ui.editKey(p, 'n')
  assert.deepEqual([p.field, p.note, p.title], ['note', 'n', 'Fix it '])
  ui.editKey(p, '\x15')
  assert.equal(p.note, '')
})

test('the edit form’s repo steps with ←/→ or space round the choices', () => {
  const p = { ...edit(), field: 'repo' }
  const names = keys => keys.map(k => ui.editKey(p, k).repo.repo)
  assert.deepEqual(names(['\x1b[C', ' ', '\x1b[C', '\x1b[C']), ['other', 'website', 'none', 'dot'])
  assert.deepEqual(names(['\x1b[D']), ['none'], '← from the first wraps to none')
})

test('typing in the repo field filters the choices and picks the first match', () => {
  const p = { ...edit(), field: 'repo' }
  assert.equal(ui.editKey(p, 'E').repo.repo, 'other', 'any case; matches inside the name too')
  assert.equal(p.find, 'E')
  assert.deepEqual(ui.repoMatches(p).map(r => r.repo), ['other', 'website', 'none'])
  ui.editKey(p, 'b')
  assert.equal(p.repo.repo, 'website')
  ui.editKey(p, '\x1b[C')
  assert.equal(p.repo.repo, 'website', 'the only match steps to itself')
  ui.editKey(p, 'q')
  assert.equal(p.repo.repo, 'website', 'no match keeps the pick')
  assert.deepEqual(ui.repoMatches(p), [])
  ui.editKey(p, '\x15')
  assert.equal(p.find, '')
  assert.equal(p.repo.repo, 'website', 'clearing the filter keeps the pick')
})

test('saving an edit to another repo moves the item there, without its branch, worktree or session', () => {
  const p = { ...edit(), field: 'repo' }
  assert.equal('repo' in ui.editChanges(p).fields, false, 'an unchanged repo writes none of it')
  ui.editKey(p, '\x1b[C')
  assert.deepEqual(ui.editChanges(p).fields, {
    title: 'Fix it', cat: 'bug', type: null, note: '',
    repo: 'other', root: '/r/other', cwd: '/r/other', worktree: '', branch: '', session: '',
  })
  ui.editKey(p, '\x1b[D')
  ui.editKey(p, '\x1b[D')
  assert.equal(p.repo, ui.NO_REPO)
  const none = ui.editChanges(p, '/home/me').fields
  assert.deepEqual([none.repo, none.root, none.cwd], ['none', '/home/me', '/home/me'], 'no repo goes under home')
})

test('saving an edit trims the title and note, and refuses an empty title', () => {
  assert.deepEqual(ui.editChanges({ ...edit({ type: 'chore' }), title: '  New  ', note: ' why \n' }), {
    id: 'a1',
    fields: { title: 'New', cat: 'bug', type: 'chore', note: 'why' },
  })
  assert.equal(ui.editChanges({ ...edit(), title: '   ' }), null)
  assert.deepEqual(ui.editChanges(edit()).fields.type, null, 'no type is saved as null, which clears it')
})

test('a saved edit says so; a failed one leaves the store’s error showing', () => {
  assert.deepEqual(ui.savedNote({ title: 'New' }, undefined), { ok: true, text: 'Saved: New' })
  assert.deepEqual(ui.savedNote(undefined, undefined), { ok: false, text: 'That todo is gone' }, 'deleted while it was being edited')
  assert.equal(ui.savedNote(undefined, new Error('todos.json.lock is held')), null)
})

const all = () => true
const repo = { id: 'k2x', title: 'Make todo edit show title', cat: 'feature', repo: 'dot', root: '/r/dot', worktree: '/r/dot/wt', cwd: '/r/dot/wt', branch: 'wt' }
const loose = { id: 'xp9', title: 'Show task type', cat: 'feature', repo: 'none', root: '/r/pix', worktree: '', cwd: '/r/pix', branch: '' }
const here = { folder: '/r/dot/wt', root: '/r/dot', repo: 'dot', worktree: '/r/dot/wt', branch: 'wt' }

test('the hand-off row opens on a tab, a worktree and opus, in a layout window', () => {
  const p = ui.handoffPrompt(['k2x'], [repo], here, 2, all)
  assert.deepEqual(
    { ...p, here: undefined },
    { kind: 'handoff', ids: ['k2x'], here: undefined, places: [{ cwd: '/r/dot/wt', git: true, moved: false }], inGit: 1, runAs: 'tab', worktree: true, model: 'opus' },
  )
  assert.notEqual(p.here, here, 'a copy, so a tab switch while it is open changes nothing')
  assert.deepEqual(p.here, here)
  assert.equal(ui.handoffPrompt(['k2x'], [repo], here, 0, all).runAs, 'bg', 'outside a layout window only the background')
})

test('the hand-off row says which items go to the open folder because they are outside git', () => {
  const p = ui.handoffPrompt(['k2x', 'xp9'], [repo, loose], here, 2, all)
  assert.deepEqual(p.places, [
    { cwd: '/r/dot/wt', git: true, moved: false },
    { cwd: '/r/dot/wt', git: true, moved: true },
  ])
  const none = ui.handoffPrompt(['xp9'], [loose], { folder: '/home/me/notes', root: '/home/me/notes', repo: 'none', worktree: '', branch: '' }, 2, all)
  assert.deepEqual([none.inGit, none.worktree, none.places[0].cwd], [0, false, '/home/me/notes'])
  const gone = ui.handoffPrompt(['zz'], [repo], here, 2, all)
  // An item deleted while the row opens reads as one without a repo, so
  // it counts toward "without a repo → dot"; handOff skips it later.
  assert.deepEqual(gone.places, [{ cwd: '/r/dot/wt', git: true, moved: true }], 'an item deleted meanwhile')
})

test('hand-off keys: t tab or background, b worktree or branch, m the model, ↵ starts', () => {
  const p = ui.handoffPrompt(['k2x'], [repo], here, 2, all)
  assert.equal(ui.handoffKey(p, 't', 2), '')
  assert.equal(p.runAs, 'bg')
  ui.handoffKey(p, 't', 2)
  assert.equal(p.runAs, 'tab')
  ui.handoffKey(p, 'b', 2)
  assert.equal(p.worktree, false)
  const models = [1, 2, 3, 4].map(() => (ui.handoffKey(p, 'm', 2), p.model))
  assert.deepEqual(models, ['sonnet', 'haiku', 'fable', 'opus'])
  assert.equal(ui.handoffKey(p, '\r', 2), 'start')
  assert.equal(ui.handoffKey(p, 'z', 2), '')
  const bg = ui.handoffPrompt(['k2x'], [repo], here, 0, all)
  assert.equal(ui.handoffKey(bg, 't', 0), 'no-tab')
  assert.equal(bg.runAs, 'bg')
  const none = ui.handoffPrompt(['xp9'], [loose], { folder: '/n', root: '/n', repo: 'none' }, 2, all)
  assert.equal(ui.handoffKey(none, 'b', 2), 'no-git')
  assert.equal(none.worktree, false)
})

test('what the hand-off row chose becomes the agent’s command', () => {
  const p = ui.handoffPrompt(['k2x'], [repo], here, 2, all)
  ui.handoffKey(p, 'm', 2)
  const { runAs, worktree, model } = p
  const plan = launch(handoffSpec(handoffPlace(repo, p.here, all), { runAs, worktree, model }, all))
  assert.equal(plan.where, 'tab')
  assert.match(ui.tabLine('/opt/my claude/bin/claude', plan), /^\/opt\/my\\ claude\/bin\/claude --model sonnet /)
  assert.equal(ui.tabLine('claude', plan), plan.line, 'a plain claude leaves the line as launch built it')
})

test('what the status row says once the agents start, or fail to', () => {
  const a = { title: 'One' }
  const b = { title: 'Two' }
  assert.deepEqual(ui.handoffResult([a], [], 'tab'), { ok: true, text: 'Handed to an agent in a new tab: One' })
  assert.deepEqual(ui.handoffResult([a], [], 'bg'), { ok: true, text: 'Handed to an agent in the background: One' })
  assert.deepEqual(ui.handoffResult([a, b], [], 'tab'), { ok: true, text: 'Handed 2 todos to agents in new tabs' })
  assert.deepEqual(ui.handoffResult([a], ['Two: dot is gone from disk'], 'tab'), { ok: false, text: "Started 1; couldn't start Two: dot is gone from disk" })
  assert.deepEqual(ui.handoffResult([], ['One: x', 'Two: y'], 'bg'), { ok: false, text: "couldn't start One: x; Two: y" })
  // Every item deleted before ↵: nothing started and nothing failed.
  assert.deepEqual(ui.handoffResult([], [], 'tab'), { ok: true, text: 'Handed 0 todos to agents in new tabs' })
})

const panes = new Map([
  ['%1', { session: 'ghostty-2', window: '@1', index: '1', win: 2, hub: false }],
  ['%2', { session: 'ghostty-3', window: '@5', index: '4', win: 3, hub: false }],
  ['%3', { session: 'hubtabs-2', window: '@9', index: '2', win: 2, hub: true }],
])

test('where an item’s tab is, in words, from this window', () => {
  assert.equal(ui.tabOf('', panes, 2), '')
  assert.equal(ui.tabOf('%1', panes, 2), 'tab 1')
  assert.equal(ui.tabOf('%2', panes, 2), 'w3 · tab 4')
  assert.equal(ui.tabOf('%2', panes, 0), 'tab 4', 'outside a layout window no window is named')
  assert.equal(ui.tabOf('%3', panes, 2), 'a hub tab')
  assert.equal(ui.tabOf('%9', panes, 2), 'a tab now closed')
})

test('↵ goes to the agent while the hub lists it, else the tab, else reopens', () => {
  const agents = [
    { kind: 'tab', title: 'x', pane: { pane: '%7' } },
    { kind: 'bg', title: 'fix-it-k2x' },
  ]
  const bgItem = { pane: '%1', handoff: { name: 'fix-it-k2x', where: 'bg', pane: '' } }
  assert.equal(ui.hubAgent(bgItem, agents), agents[1])
  assert.equal(ui.goLabel(bgItem, panes, agents), 'go to agent')
  const tabItem = { pane: '%1', handoff: { name: 'n', where: 'tab', pane: '%7' } }
  assert.equal(ui.hubAgent(tabItem, agents), agents[0], 'a tab agent by its pane, not its name')
  assert.equal(ui.hubAgent({ handoff: { name: 'x', pane: '%8' } }, agents), null, 'a tab agent the hub lost, even with a matching title')
  assert.equal(ui.hubAgent({ handoff: { name: 'x', pane: '' } }, agents), null, 'a background name only matches a background agent')
  assert.equal(ui.hubAgent({}, agents), null)
  const openTab = { pane: '%9', handoff: { name: 'n', where: 'tab', pane: '%1' } }
  assert.equal(ui.agentPane(openTab, panes), '%1')
  assert.equal(ui.goLabel(openTab, panes, []), 'go to agent', 'its agent’s tab is still open')
  assert.equal(ui.agentPane({ handoff: { pane: '%9' } }, panes), '')
  assert.equal(ui.goLabel({ pane: '%1' }, panes, []), 'go to tab')
  assert.equal(ui.goLabel({ pane: '%9' }, panes, []), 'reopen')
  assert.equal(ui.goLabel({ pane: '' }, panes, []), '', 'added here: nowhere to go')
})

test('why ↵ has nowhere to go', () => {
  assert.equal(ui.noTabText({ handoff: { where: 'bg', name: 'fix-k2x' } }), 'fix-k2x ran in the background and the hub no longer lists it')
  assert.equal(ui.noTabText({ by: 'you' }), 'You added this one here, so it has no tab to go to')
  assert.equal(ui.noTabText({ by: 'claude' }), 'This one was added outside the layout’s tabs')
})

test('a closed tab reopens in its worktree, folder or repo, whichever is on disk', () => {
  const base = mkdtempSync(join(tmpdir(), 'todo-ui-reopen-'))
  const root = join(base, 'repo')
  const wt = join(root, 'wt')
  mkdirSync(root)
  const it = { worktree: wt, cwd: join(base, 'cwd'), root }
  assert.equal(ui.reopenDir(it), root, 'worktree and folder gone')
  mkdirSync(wt)
  assert.equal(ui.reopenDir(it), wt)
  assert.equal(ui.reopenDir({ worktree: '', cwd: '', root: join(base, 'nope') }), undefined)
  assert.equal(ui.reopenLine('claude', 'a1b2-c3'), 'claude --resume a1b2-c3')
  assert.equal(ui.reopenLine('/my bin/claude', ''), '/my\\ bin/claude', 'no session: a new Claude')
  assert.equal(ui.reopenLine('claude', "x'; rm"), "claude --resume x\\'\\;\\ rm", 'the session can’t break out of the line')
})

test('scrolling keeps the selected item’s card in view, its row first', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const rows = [{ text: 'h', header: true }, { item: a }, { item: a }, { text: '' }, { text: 'h', header: true }, { item: b }, { item: b }, { item: b }, { text: '' }]
  assert.equal(ui.scrollTo(rows, a, 0, 4), 0)
  assert.equal(ui.scrollTo(rows, b, 0, 4), 4, 'down far enough to show its whole card')
  assert.equal(ui.scrollTo(rows, a, 4, 4), 0, 'up to its group’s header')
  assert.equal(ui.scrollTo(rows, a, 4, 2), 1, 'up to its row when the header and card don’t both fit')
  assert.equal(ui.scrollTo(rows, b, 7, 4), 4, 'up to the second group’s header')
  const group = [{ text: 'h', header: true }, { item: a }, { item: c }, { item: c }, { text: '' }, { text: '' }, { text: '' }]
  assert.equal(ui.scrollTo(group, c, 3, 4), 2, 'not the first in its group: only up to its row')
  assert.equal(ui.scrollTo(rows, b, 0, 2), 5, 'a card taller than the pane shows its row first')
  assert.equal(ui.scrollTo(rows, a, 3, 20), 0, 'everything fits')
  assert.equal(ui.scrollTo(rows, { id: 'gone' }, 7, 4), 5, 'an item not drawn: only clamped')
  assert.equal(ui.scrollTo([], { id: 'gone' }, 3, 4), 0)
  assert.equal(ui.scrollTo(rows, undefined, 7, 4), 5, 'nothing selected: only clamped')
  assert.equal(ui.scrollTo([], undefined, 3, 4), 0)
})

test('the empty list says why it is empty', () => {
  assert.deepEqual(ui.emptyLines({ loadError: 'bad json', only: true, repo: 'dot' }), ['bad json'])
  assert.deepEqual(ui.emptyLines({ loadError: '', only: true, repo: 'dot' }), ['No open todos in dot.', 'f shows every repo.'])
  assert.deepEqual(ui.emptyLines({ loadError: '', only: true, repo: '' }), ['No open todos in this repo.', 'f shows every repo.'])
  assert.equal(ui.emptyLines({ loadError: '', only: false })[0], 'No todos yet.')
})

test('the status row’s keys follow the marks and the filter, and it says where the cursor is', () => {
  assert.deepEqual(ui.statusPairs(0, false).map(p => p[0]), ['space', 'a', 'shift+a', 'm', 'w', 'f'])
  assert.deepEqual(ui.statusPairs(0, false).at(-1), ['f', 'this repo'])
  assert.deepEqual(ui.statusPairs(0, true).at(-1), ['f', 'all repos'])
  assert.deepEqual(ui.statusPairs(2, false).map(p => p[0]), ['w', 'm', 'shift+m', 'space'])
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(ui.position(list, list[1], 0), '2/3 ')
  assert.equal(ui.position(list, list[2], 2), '2 marked · 3/3 ')
  assert.equal(ui.position([], undefined, 0), '')
})

test('fit pads or cuts to a width in cells, with an ellipsis', () => {
  assert.equal(ui.fit('abc', 5), 'abc  ')
  assert.equal(ui.fit('abcdef', 4), 'abc…')
  assert.equal(ui.fit('abc', 3), 'abc')
  assert.equal(ui.fit('abc', 0), '…')
  assert.equal(ui.fit('a\tb\x1b[31m', 6), 'a  b[…', 'tabs widen, control characters go (not the rest of a sequence)')
  assert.equal(ui.fit('漢字かな', 3), '漢…', 'each of these takes two cells')
  assert.equal(ui.fit('漢字かな', 4), '漢… ', 'a wide character can’t straddle the ellipsis: a space fills in')
  assert.equal(ui.fit('漢字かな', 8), '漢字かな')
  assert.equal(ui.fit('漢字', 6), '漢字  ')
  assert.equal(ui.fit('😀😀', 2), '… ')
  assert.equal(ui.fit('fix 😀 now', 12), 'fix 😀 now  ')
  for (const text of ['漢字かな漢字', 'ok 😀😀 done', 'plain words here', 'é and ü']) {
    for (const w of [1, 3, 5, 8, 20]) assert.equal(ui.cells(ui.fit(text, w)), w, `${text} at ${w}`)
  }
})

test('the start or end of a line that fits in a width, in cells', () => {
  assert.equal(ui.head('漢字abc', 3), '漢')
  assert.equal(ui.head('漢字abc', 5), '漢字a')
  assert.equal(ui.tail('abc漢字', 3), '字', 'a long prompt shows its end')
  assert.equal(ui.tail('abc漢字', 5), 'c漢字')
  assert.equal(ui.tail('short', 10), 'short')
  assert.equal(ui.cells('Press a to add 漢字'), 19, 'what the empty list centres by')
})

test('wrap breaks on spaces, splits words too long, and keeps line breaks', () => {
  assert.deepEqual(ui.wrap('one two three', 7), ['one two', 'three'])
  assert.deepEqual(ui.wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(ui.wrap('a\n\nb', 10), ['a', '', 'b'])
  assert.deepEqual(ui.wrap('', 10), [''])
  assert.deepEqual(ui.wrap('漢字漢字漢', 4), ['漢字', '漢字', '漢'], 'two cells a character')
  assert.deepEqual(ui.wrap('漢字 漢字', 5), ['漢字', '漢字'])
  assert.deepEqual(ui.wrap('x 😀😀😀', 4), ['x', '😀😀', '😀'], 'never splits an emoji')
  assert.deepEqual(ui.wrap('漢字', 1), ['漢', '字'], 'one wide character a line when even one doesn’t fit')
  assert.deepEqual(ui.wrap('abc', 0), ['a', 'b', 'c'], 'a zero width still ends')
  for (const line of ui.wrap('日本語のテキストを折り返す 😀 and some ascii words too', 10)) assert.ok(ui.cells(line) <= 10, line)
})

test('visible counts what shows, not the color codes', () => {
  assert.equal(ui.visible('\x1b[38;2;1;2;3mab\x1b[0m'), 2)
  assert.equal(ui.visible('\x1b[?2026h漢'), 2, 'a wide character is two cells')
})

test('shellQuote escapes everything but word characters, dots, slashes and dashes', () => {
  assert.equal(ui.shellQuote('/usr/bin/claude-2.1'), '/usr/bin/claude-2.1')
  assert.equal(ui.shellQuote('a b$c'), 'a\\ b\\$c')
  assert.equal(ui.shellQuote('/x/😀'), '/x/\\😀', 'an emoji keeps both its halves together')
  assert.ok(ui.shellQuote('😀').isWellFormed())
})

test('todo-view refuses to run without a terminal, and touches no store', () => {
  const base = mkdtempSync(join(tmpdir(), 'todo-ui-view-'))
  const file = join(base, 'state/todos.json')
  const view = join(dirname(fileURLToPath(import.meta.url)), 'todo-view.mjs')
  const env = { ...process.env, TODO_FILE: file, XDG_STATE_HOME: join(base, 'state'), DV_TABS: '' }
  const run = spawnSync(process.execPath, [view, base], { env, input: '', encoding: 'utf8', timeout: 10000 })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /todo-view needs a terminal/)
  assert.equal(existsSync(join(base, 'state')), false)
})

test('the edit form wraps with the caret where the wrap puts it', () => {
  assert.deepEqual(ui.wrap(ui.withCaret('fix the bug', 3), 4).map(ui.caretShown), ['fix\x1b[7m \x1b[27m', 'the', 'bug'])
})
