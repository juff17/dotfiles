// node --test modules/ghostty/home/.config/ghostty/hub/newagent.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { launch } from './model.mjs'

// The form reads home once, as it loads, for ~ and the default folder.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'hub-newagent-')))
process.env.HOME = HOME
process.env.AGENT_HUB_PROMPTS = join(HOME, 'prompts')
process.env.AGENT_HUB_SETTINGS = join(HOME, 'settings.json')
after(() => rmSync(HOME, { recursive: true, force: true }))
const P = join(HOME, 'projects')
for (const d of ['alpha', 'alphabet', 'Beta', '.hidden', 'alpha/.claude/worktrees/fix-x']) mkdirSync(join(P, d), { recursive: true })
symlinkSync(join(P, 'alpha'), join(P, 'linked'))
symlinkSync(join(P, 'missing'), join(P, 'broken'))
writeFileSync(join(P, 'notes.txt'), '')

const { POPUP, fields, form, key, matchesOf, suggestion } = await import('./newagent.mjs')

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const SHIFT_TAB = '\x1b[Z'
const CTRL_S = '\x13'
const type = s => [...s].forEach(c => key(c))
const keys = (...ks) => ks.map(k => key(k))
const at = (d, field) => ((d.field = field), d)

test('a new form is a task, in its own worktree, on the prompt, with opus, auto and medium', () => {
  const d = form({ folder: join(P, 'alpha'), recents: [join(P, 'beta'), join(P, 'alpha')] })
  assert.equal(d.field, 'prompt')
  assert.equal(d.folder.text, '~/projects/alpha')
  assert.equal(d.folder.at, d.folder.text.length)
  assert.equal(d.recent, 1)
  assert.deepEqual(fields(), ['prompt', 'kind', 'folder', 'recent', 'runAs', 'branch', 'model', 'mode', 'effort', 'start'])
  type('go')
  const { done } = key(CTRL_S)
  assert.deepEqual(done, {
    kind: 'task',
    cwd: join(P, 'alpha'),
    prompt: 'go',
    target: '',
    runAs: 'tab',
    worktree: true,
    model: 'opus',
    mode: 'auto',
    effort: 'medium',
  })
})

test('the folder is the repo when given a worktree, else the newest recent, else ~/projects', () => {
  assert.equal(form({ folder: join(P, 'alpha/.claude/worktrees/fix-x') }).folder.text, '~/projects/alpha')
  assert.equal(form({ recents: [join(P, 'Beta')] }).folder.text, '~/projects/Beta')
  assert.equal(form().folder.text, '~/projects')
  // Outside home the path stays as it is.
  assert.equal(form({ folder: '/srv/app' }).folder.text, '/srv/app')
  assert.equal(form({ folder: '/srv/app', recents: ['/x'] }).recent, -1)
})

test('with Default folder at ~/projects, the form starts there whatever is selected', async () => {
  const { set } = await import('./settings.mjs')
  set('newAgent.defaultFolder', 'projects')
  try {
    assert.equal(form({ folder: join(P, 'alpha'), recents: [join(P, 'Beta')] }).folder.text, '~/projects')
  } finally {
    set('newAgent.defaultFolder', 'tab')
  }
})

test('Esc and Ctrl+C cancel without a spec', () => {
  form()
  assert.deepEqual(key('\x1b'), { done: null })
  form()
  assert.deepEqual(key('\x03'), { done: null })
})

test('Start needs a prompt, and puts you on it', () => {
  const d = form({ folder: P })
  at(d, 'model')
  assert.equal(key(CTRL_S), undefined)
  assert.equal(d.field, 'prompt')
  assert.equal(d.error, 'Give the task a first prompt')
  type('   ')
  assert.equal(key(CTRL_S), undefined)
  // The error goes with the next key.
  type('x')
  assert.equal(d.error, null)
  assert.equal(key(CTRL_S).done.prompt, '   x')
})

test('Start needs a folder that exists, and puts you on it', () => {
  const d = form({ folder: join(P, 'nope') })
  type('go')
  assert.equal(key(CTRL_S), undefined)
  assert.equal(d.field, 'folder')
  assert.equal(d.error, 'No folder ~/projects/nope')
  form({ folder: join(P, 'notes.txt') })
  type('go')
  assert.equal(key(CTRL_S), undefined)
})

test('the folder may be ~, end in slashes, or be empty for home', () => {
  const d = form()
  type('go')
  d.folder = { text: ' ~/projects/alpha// ', at: 0 }
  assert.equal(key(CTRL_S).done.cwd, join(P, 'alpha'))
  d.folder = { text: '', at: 0 }
  assert.equal(key(CTRL_S).done.cwd, HOME)
})

test('Enter moves to the next field, and starts on Start', () => {
  const d = form({ folder: P })
  type('go')
  key('\r')
  assert.equal(d.field, 'kind')
  at(d, 'start')
  assert.equal(key('\r').done.prompt, 'go')
})

test('up, down, tab and shift+tab move between fields, held at the ends', () => {
  const d = form({ folder: P })
  // The prompt is the top field.
  keys(UP)
  assert.equal(d.field, 'prompt')
  keys(DOWN, '\t', DOWN)
  assert.equal(d.field, 'recent')
  keys(SHIFT_TAB, SHIFT_TAB)
  assert.equal(d.field, 'kind')
  keys(DOWN)
  assert.equal(d.field, 'folder')
  // On Folder, tab completes rather than moving on.
  d.folder = { text: '~/projects/zz', at: 13 }
  keys('\t')
  assert.equal(d.field, 'folder')
  at(d, 'start')
  keys(DOWN, '\t')
  assert.equal(d.field, 'start')
})

test('PR and log monitors ask for a target instead of a prompt, and no run-as or branch', () => {
  const d = at(form({ folder: P }), 'kind')
  keys(RIGHT)
  assert.deepEqual(fields(), ['target', 'kind', 'folder', 'recent', 'model', 'mode', 'effort', 'start'])
  assert.equal(key(CTRL_S), undefined)
  assert.equal(d.field, 'target')
  assert.equal(d.error, 'Paste the PR or MR link')
  at(d, 'kind')
  keys(RIGHT)
  assert.equal(key(CTRL_S), undefined)
  assert.equal(d.error, 'Say what to watch')
  type('docker compose logs api')
  const { done } = key(CTRL_S)
  assert.equal(done.kind, 'logs')
  assert.equal(done.target, 'docker compose logs api')
})

test('changing kind resets model, mode and effort to what it starts with', () => {
  const d = at(form({ folder: P }), 'model')
  keys(RIGHT)
  assert.equal(d.model, 3)
  at(d, 'kind')
  keys(RIGHT)
  // A monitor mostly waits, so sonnet.
  assert.deepEqual([d.model, d.mode, d.effort], [3, 1, 2])
  keys(LEFT)
  assert.deepEqual([d.model, d.mode, d.effort], [2, 1, 2])
  assert.equal(d.field, 'kind')
})

test('choices step with → and space, back with ←, and wrap both ways', () => {
  const d = at(form({ folder: P }), 'model')
  const model = () => ['default', 'fable', 'opus', 'sonnet', 'haiku'][d.model]
  assert.equal(model(), 'opus')
  keys(RIGHT, ' ', ' ')
  assert.equal(model(), 'default')
  keys(LEFT)
  assert.equal(model(), 'haiku')
  at(d, 'kind')
  keys(LEFT)
  assert.equal(d.kind, 2)
  keys(RIGHT)
  assert.equal(d.kind, 0)
})

test('run as background and the current branch end up in the spec and launch', () => {
  const d = form({ folder: P })
  type("fix the rail's dot")
  at(d, 'runAs')
  keys(RIGHT)
  at(d, 'branch')
  keys(RIGHT)
  at(d, 'effort')
  keys(RIGHT)
  const { done } = key(CTRL_S)
  assert.equal(done.runAs, 'bg')
  assert.equal(done.worktree, false)
  assert.equal(done.effort, 'high')
  const plan = launch(done)
  assert.equal(plan.where, 'bg')
  assert.deepEqual(plan.argv, ['claude', '--bg', '--name', 'fix-the-rail-s-dot', '--model', 'opus', '--permission-mode', 'auto', '--effort', 'high', "fix the rail's dot"])
})

test('a tab task in a worktree launches as a quoted line', () => {
  form({ folder: P })
  type('go')
  assert.match(launch(key(CTRL_S).done).line, /^claude --model opus --permission-mode auto --effort medium 'Before anything else, make your own worktree .* go'$/)
})

test('Recent steps through the recents and fills Folder; with none it does nothing', () => {
  const d = at(form({ folder: join(P, 'alpha'), recents: [join(P, 'alpha'), join(P, 'Beta'), '/srv/app'] }), 'recent')
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/Beta')
  keys(RIGHT)
  assert.equal(d.folder.text, '/srv/app')
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/alpha')
  keys(LEFT)
  assert.equal(d.folder.text, '/srv/app')
  const e = at(form({ folder: P }), 'recent')
  keys(RIGHT)
  assert.equal(e.recent, -1)
  assert.equal(e.folder.text, '~/projects')
})

test('with Folder not among the recents, → takes the first recent and ← the last', () => {
  const recents = [join(P, 'Beta'), '/srv/app', join(P, 'alphabet')]
  const d = at(form({ folder: join(P, 'alpha'), recents }), 'recent')
  assert.equal(d.recent, -1)
  keys(RIGHT)
  assert.equal(d.recent, 0)
  assert.equal(d.folder.text, '~/projects/Beta')
  const e = at(form({ folder: join(P, 'alpha'), recents }), 'recent')
  keys(LEFT)
  assert.equal(e.recent, 2)
  assert.equal(e.folder.text, '~/projects/alphabet')
})

test('text fields: arrows, home and end, backspace, ctrl+u and ctrl+w', () => {
  const d = form({ folder: P })
  type('fix bug')
  keys(LEFT, LEFT, LEFT)
  type('the ')
  assert.deepEqual(d.prompt, { text: 'fix the bug', at: 8 })
  keys('\x7f')
  assert.deepEqual(d.prompt, { text: 'fix thebug', at: 7 })
  keys('\x01', '\x7f')
  assert.deepEqual(d.prompt, { text: 'fix thebug', at: 0 })
  keys('\x05', '\x17')
  assert.deepEqual(d.prompt, { text: 'fix ', at: 4 })
  keys('\x1b[H', RIGHT, RIGHT)
  keys('\x15')
  assert.deepEqual(d.prompt, { text: 'x ', at: 0 })
  keys('\x1b[F', RIGHT)
  assert.equal(d.prompt.at, 2)
  keys('\b', '\b', '\b')
  assert.deepEqual(d.prompt, { text: '', at: 0 })
})

test('text fields: an emoji or a wide character is one step, and never cut in half', () => {
  const d = form({ folder: P })
  type('ok 😀 漢字')
  keys(LEFT, LEFT, LEFT, LEFT)
  assert.equal(d.prompt.at, 3, 'four steps back from the end is before the emoji')
  keys(RIGHT, '\x7f')
  assert.deepEqual(d.prompt, { text: 'ok  漢字', at: 3 })
})

test('a paste joins its lines and drops control characters; outside a text field it does nothing', () => {
  const d = form({ folder: P })
  key('', 'first line\n   second\tline\r\n')
  assert.equal(d.prompt.text, 'first line second line ')
  at(d, 'model')
  key('', 'ignored')
  assert.equal(d.prompt.text, 'first line second line ')
  assert.equal(d.model, 2)
})

test('folder matches: those that start with it, then any case; dirs and their links only', () => {
  const names = text => matchesOf(text).names
  assert.deepEqual(names('~/projects/al'), ['alpha', 'alphabet'])
  assert.deepEqual(names('~/projects/b'), ['Beta'])
  assert.deepEqual(names('~/projects/'), ['Beta', 'alpha', 'alphabet', 'linked'])
  assert.deepEqual(names('~/projects/.h'), ['.hidden'])
  assert.deepEqual(names('~/projects/zzz'), [])
  assert.deepEqual(names('/no/such/place/'), [])
  assert.deepEqual(matchesOf('~/projects/al').dir, P)
  assert.equal(matchesOf('~/projects/al').part, 'al')
})

test('tab fills in one match with its slash, and what several share', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/B', at: 12 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/Beta/')
  d.folder = { text: '~/projects/al', at: 13 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alpha')
  assert.equal(d.folder.at, d.folder.text.length)
  d.folder = { text: '~/projects/zz', at: 13 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/zz')
  assert.equal(d.field, 'folder')
})

test('once nothing more is shared, tab steps through the matches, shift+tab back', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/alpha', at: 16 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alpha/')
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alphabet/')
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alpha/')
  keys(SHIFT_TAB)
  assert.equal(d.folder.text, '~/projects/alphabet/')
  // Another key keeps the one shown and ends the menu.
  type('x')
  assert.equal(d.folder.text, '~/projects/alphabet/x')
  assert.equal(d.field, 'folder')
})

test('shift+tab starts the menu at the last match, once it is open; before, it moves up', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/', at: 11 }
  keys(SHIFT_TAB)
  assert.equal(d.field, 'kind')
  at(d, 'folder')
  keys('\t')
  assert.equal(d.folder.text, '~/projects/Beta/')
  keys(SHIFT_TAB)
  assert.equal(d.folder.text, '~/projects/linked/')
})

test('the folder suggests the rest of its first match, and → or end takes it', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/alphab', at: 17 }
  assert.equal(suggestion(), 'et/')
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/alphabet/')
  assert.equal(suggestion(), '')
  d.folder = { text: '~/projects/alph', at: 15 }
  keys('\x05')
  assert.equal(d.folder.text, '~/projects/alpha/')
})

test('no suggestion mid-line, off the folder, for a different case or a trailing slash', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/alph', at: 3 }
  assert.equal(suggestion(), '')
  // → then only moves the cursor.
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/alph')
  assert.equal(d.folder.at, 4)
  d.folder = { text: '~/projects/be', at: 13 }
  assert.equal(suggestion(), '')
  d.folder = { text: '~/projects/', at: 11 }
  assert.equal(suggestion(), '')
  at(d, 'prompt')
  d.folder = { text: '~/projects/alph', at: 15 }
  assert.equal(suggestion(), '')
})

test('the popup is the form\'s size, border included', () => {
  assert.deepEqual(POPUP, { w: 80, h: 23 })
})
