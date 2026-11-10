import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { launch } from '../hub/model.mjs'
import { FILING_TIMEOUT_MS, INSTALLED_CLI, KEEP_DONE_MS, add, age, arrange, category, change, fill, filerMessage, filingState, find, handoffPlace, handoffSpec, inGit, knownRepos, load, newId, prune, remove, repoOf, taskType } from './todo.mjs'

// No settings file, so every setting reads as its default.
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'
process.env.AGENT_HUB_PROMPTS = '/nonexistent/agent-hub/prompts'

const now = new Date(2026, 10, 7, 15, 0).getTime()
const item = (id, cat, root, created, done = null) => ({ id, cat, root, repo: root.split('/').pop(), title: id, created, done })

test('categories by name, alias or unique prefix', () => {
  assert.equal(category('bug'), 'bug')
  assert.equal(category('Feat'), 'feature')
  assert.equal(category('fix'), 'bug')
  assert.equal(category('fo'), 'follow-up')
  assert.equal(category('q'), 'question')
  assert.equal(category('misc'), 'other')
  assert.equal(category('o'), 'other')
  assert.equal(category('nope'), undefined)
  assert.equal(category(''), undefined)
})

test('types by name, alias or unique prefix, and none clears one', () => {
  assert.equal(taskType('research'), 'research')
  assert.equal(taskType('Res'), 'research')
  assert.equal(taskType('rev'), 'review')
  assert.equal(taskType('r'), undefined)
  assert.equal(taskType('de'), 'decide')
  assert.equal(taskType('do'), 'action')
  assert.equal(taskType('ch'), 'chore')
  assert.equal(taskType('none'), null)
  assert.equal(taskType('nope'), undefined)
  assert.equal(taskType(''), undefined)
})

test('a folder outside any repo is labelled none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'todo-norepo-'))
  assert.deepEqual(await repoOf(dir), { root: dir, repo: 'none', worktree: '', branch: '' })
})

test('ids are new and lengthen once short ones run out', () => {
  const items = [{ id: '000' }]
  let calls = 0
  // Every 3-character try comes out 000.
  const stuck = () => (calls++ < 60 ? 0 : 0.5)
  assert.equal(newId(items, stuck).length, 4)
  assert.match(newId([]), /^[0-9a-z]{3}$/)
})

test('find takes a unique start of an id', () => {
  const items = [{ id: 'abc' }, { id: 'abd' }, { id: 'xyz' }]
  assert.equal(find(items, 'x').id, 'xyz')
  assert.equal(find(items, 'ab'), undefined)
  assert.equal(find(items, 'abd').id, 'abd')
})

test('ages read in minutes, hours, then days', () => {
  assert.equal(age(59 * 60000), '59m')
  assert.equal(age(2 * 3600000), '2h')
  assert.equal(age(50 * 3600000), '2d')
  assert.equal(age(-5), '0m')
})

test('done items older than a week are dropped', () => {
  const items = [item('a', 'bug', '/r', 0, now - KEEP_DONE_MS - 1), item('b', 'bug', '/r', 0, now - 1000), item('c', 'bug', '/r', 0)]
  assert.deepEqual(prune(items, now, KEEP_DONE_MS).map(i => i.id), ['b', 'c'])
})

test('groups follow category order, this repo first, then newest', () => {
  const items = [
    item('q1', 'question', '/a', now - 10),
    item('b-old', 'bug', '/b', now - 300),
    item('b-new', 'bug', '/b', now - 100),
    item('b-here', 'bug', '/a', now - 900),
    item('f1', 'feature', '/b', now - 50),
    item('d-today', 'docs', '/a', now - 999, now - 60000),
    item('d-yday', 'docs', '/a', now - 999, now - 24 * 3600000),
  ]
  const { groups, doneToday, open } = arrange(items, { here: '/a', now })
  assert.deepEqual(groups.map(g => g.name), ['bug', 'feature', 'question'])
  assert.deepEqual(groups[0].items.map(i => i.id), ['b-here', 'b-new', 'b-old'])
  assert.deepEqual(doneToday.map(i => i.id), ['d-today'])
  assert.equal(open, 5)
  const mine = arrange(items, { here: '/a', only: true, now })
  assert.deepEqual(mine.groups.map(g => g.items.map(i => i.id)), [['b-here'], ['q1']])
})

test('the store adds, changes and removes under its lock', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'todo-')), 'todos.json')
  const first = add({ title: 'One', root: '/r' }, file)
  const second = add({ title: 'Two', cat: 'bug', root: '/r' }, file)
  assert.equal(first.cat, 'follow-up')
  assert.notEqual(first.id, second.id)
  assert.equal(change(second.id, { done: 5 }, file).done, 5)
  assert.equal(change('missing', { done: 5 }, file), undefined)
  assert.equal(remove(first.id, file).title, 'One')
  assert.deepEqual(load(file).map(i => i.title), [])
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).v, 1)
  assert.deepEqual(load(join(file, '..', 'none.json')), [])
})

test('items Claude is filing go apart, oldest first, and are not open', () => {
  const items = [
    item('b1', 'bug', '/a', now - 10),
    { ...item('f-new', 'follow-up', '/a', now - 5), filing: { started: now - 5 } },
    { ...item('f-old', 'follow-up', '/b', now - 50), filing: { started: now - 50, error: 'no' } },
  ]
  const { groups, filing, open } = arrange(items, { here: '/a', now })
  assert.deepEqual(filing.map(i => i.id), ['f-old', 'f-new'])
  assert.deepEqual(groups.map(g => g.items.map(i => i.id)), [['b1']])
  assert.equal(open, 1)
  assert.deepEqual(arrange(items, { here: '/a', only: true, now }).filing.map(i => i.id), ['f-new'])
})

test('a filing fails on an error, or once it has run too long', () => {
  assert.equal(filingState({ id: 'a' }, now), '')
  assert.equal(filingState({ filing: { started: now - 1000 } }, now), 'filing')
  assert.equal(filingState({ filing: { started: now - 1000, error: 'claude exited' } }, now), 'failed')
  assert.equal(filingState({ filing: { started: now - FILING_TIMEOUT_MS - 1 } }, now, FILING_TIMEOUT_MS), 'failed')
})

test('fill turns a filing item into a real one, once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'todo-')), 'todos.json')
  const plain = add({ title: 'Plain', root: '/r' }, file)
  const placeholder = add({ title: 'ctrl shift b goes to peek', root: '/r', repo: 'r', filing: { started: now } }, file)
  const filled = fill(placeholder.id, { title: 'Ctrl+Shift+B should open the Board', cat: 'bug', note: 'n', by: 'claude' }, file)
  assert.equal(filled.id, placeholder.id)
  assert.equal(filled.repo, 'r')
  assert.equal('filing' in load(file).find(i => i.id === placeholder.id), false)
  assert.equal(fill(placeholder.id, { title: 'again' }, file), undefined)
  assert.equal(fill(plain.id, { title: 'not filing' }, file), undefined)
  assert.equal(fill('missing', { title: 'x' }, file), undefined)
})

test('the filer knows the listed repos and the git repos beside them', () => {
  const tree = { '/p': ['dot', 'jstack', 'notes'], '/w': ['solo'] }
  const gits = new Set(['/p/dot/.git', '/p/jstack/.git', '/w/solo/.git'])
  const opts = { exists: path => gits.has(path), list: dir => tree[dir] ?? [] }
  const items = [
    { repo: 'dot', root: '/p/dot' },
    { repo: 'dot', root: '/p/dot' },
    { repo: 'none', root: '/p/notes' },
    { repo: 'solo', root: '/w/solo' },
  ]
  assert.deepEqual(knownRepos(items, opts), [
    { repo: 'dot', root: '/p/dot' },
    { repo: 'jstack', root: '/p/jstack' },
    { repo: 'solo', root: '/w/solo' },
  ])
  assert.deepEqual(knownRepos([], opts), [])
})

test('a hand-off starts one task agent per item, in its repo', () => {
  const it = { id: 'k2x', title: 'Make todo edit show title and notes', cat: 'feature', repo: 'dot', root: '/r/dot', worktree: '/r/dot/.claude/worktrees/w', cwd: '/r/dot/.claude/worktrees/w', branch: 'wt', note: 'Show every\nfield.' }
  const all = () => true
  const spec = handoffSpec(it, {}, all)
  assert.equal(spec.cwd, '/r/dot', 'a worktree agent starts from the main checkout')
  assert.equal(spec.name, 'make-todo-edit-show-k2x')
  assert.equal(spec.prompt, "Work on this item from my todo list (todo k2x, a feature in dot, added on wt): Make todo edit show title and notes. Show every field. End the worktree's name with the todo's id, k2x. When the work is ready, commit it in the worktree and ask me whether to merge it; never merge unasked. After it's merged, ask me whether to remove the worktree; never remove it unasked. Once it's finished, mark it done: ~/.config/ghostty/bin/ghostty-todo done k2x")
  assert.match(spec.prompt, /ghostty-todo done k2x$/)
  assert.equal(launch(spec).line.split(' ').slice(0, 7).join(' '), 'claude --model opus --permission-mode auto --effort medium')
  assert.match(launch(spec).line, /EnterWorktree/, 'the agent makes and names its worktree')
  assert.equal(handoffSpec(it, { worktree: false }, all).cwd, '/r/dot/.claude/worktrees/w', 'on the current branch, where it was added')
  assert.doesNotMatch(handoffSpec(it, { worktree: false }, all).prompt, /remove the worktree/, 'no cleanup offer without a worktree of its own')
  assert.match(spec.prompt, /ask me whether to merge it; never merge unasked/, 'merging waits for the user')
  assert.equal(handoffSpec(it, { worktree: false }, d => d === '/r/dot').cwd, '/r/dot', 'falls back when its worktree is gone')
  assert.equal(handoffSpec(it, {}, () => false), undefined)
  const loose = handoffSpec({ ...it, repo: 'none', root: '/r/pix', worktree: '', cwd: '/r/pix' }, {}, all)
  assert.equal(loose.worktree, false, 'no worktree outside git')
  assert.equal(inGit({ repo: 'none', root: '/r/pix' }, all), false)
  assert.equal(inGit(it, all), true)
  assert.doesNotMatch(launch(loose).line, /EnterWorktree|worktree's name/)
  assert.equal(handoffSpec(it, {}, d => d !== '/r/dot/.git').worktree, false, 'nor in a folder git no longer tracks')
  const bg = launch(handoffSpec({ ...it, note: '' }, { runAs: 'bg', model: 'sonnet' }, all))
  assert.deepEqual(bg.argv.slice(0, 4), ['claude', '--bg', '--name', 'make-todo-edit-show-k2x'])
  assert.doesNotMatch(bg.argv.at(-1), /\. {2}|\n/, 'no gap for a missing note, no newline')
})

test('an item outside git is handed off in the folder the viewer has open', () => {
  const all = () => true
  const loose = { id: 'xp9', title: 'Show task type', cat: 'feature', repo: 'none', root: '/r/pix', worktree: '', cwd: '/r/pix', branch: '' }
  const dot = { folder: '/r/dot/.claude/worktrees/w', root: '/r/dot', repo: 'dot', worktree: '/r/dot/.claude/worktrees/w', branch: 'wt' }
  const placed = handoffPlace(loose, dot, all)
  assert.equal(handoffSpec(placed, {}, all).cwd, '/r/dot', 'a worktree from the open repo')
  assert.equal(handoffSpec(placed, { worktree: false }, all).cwd, '/r/dot/.claude/worktrees/w', 'or the open worktree itself')
  assert.match(handoffSpec(placed, {}, all).prompt, /\(todo xp9, a feature in dot\):/, 'no branch it was never added on')
  const plain = handoffPlace(loose, { folder: '/home/me/notes', root: '/home/me/notes', repo: 'none', worktree: '', branch: '' }, all)
  assert.deepEqual([plain.cwd, inGit(plain, all)], ['/home/me/notes', false], 'an open folder outside git, as it is')
  const own = { ...loose, repo: 'gad', root: '/r/gad', cwd: '/r/gad' }
  assert.equal(handoffPlace(own, dot, all), own, 'an item in git keeps its repo')
  assert.equal(handoffPlace(loose, { folder: '' }, all), loose, 'nothing open: its own folder')
})

test('the filer is sent the todo skill with the filing id, where it was typed and the message', () => {
  const item = { id: 'f7q', title: 'the rail is too wide in the hub', repo: 'dotfiles', root: '/home/u/p/dotfiles' }
  assert.equal(
    filerMessage(item),
    '/todo File this todo from the Todo pane as filing f7q. It was typed in the dotfiles repo (/home/u/p/dotfiles). The message: the rail is too wide in the hub',
  )
  assert.match(filerMessage({ ...item, repo: 'none', root: '/home/u' }), /typed in \/home\/u, outside any repo\./)
  assert.doesNotMatch(filerMessage(item, INSTALLED_CLI), /Run ghostty-todo as/)
  assert.match(filerMessage(item, '/wt/bin/ghostty-todo'), /\. Run ghostty-todo as \/wt\/bin\/ghostty-todo\. The message:/, 'a worktree’s copy is named')
})
