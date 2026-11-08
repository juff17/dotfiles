// node --test modules/ghostty/home/.config/ghostty/hub/board.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LANES, LANE_GAP, MIN_BOARD_COLS, MIN_LANE_ROWS, MONITOR_ROWS, activeWindow, boardRows, closeQuestion, keptFocus, laneColumns, listItems, listMode,
  listScroll, listSelection, markedPane, nextLane, selection, showsPermission, shq, step, stepList, tabFocus, trayWindow, visible, where,
} from './board.mjs'
import { lanes, monitorsOf } from './model.mjs'

const agent = (id, extra = {}) => ({ id, title: id, repo: 'dotfiles', cmd: 'Thinking…', state: 'working', since: 0, monitors: [], ...extra })
const monitor = (key, extra = {}) => ({ key, task: key, description: `watch ${key}`, state: 'watching', startedAt: 0, ...extra })
const byId = x => x.id
const filledOnly = (...lanes_) => i => lanes_.includes(i)

test('the filter matches title, repo, command and monitor descriptions, ignoring case', () => {
  const list = [
    agent('a', { title: 'Fix the rail' }),
    agent('b', { repo: 'jstack' }),
    agent('c', { cmd: 'Bash(npm test)' }),
    agent('d', { monitors: [monitor('m', { description: 'PR #12 pipeline' })] }),
  ]
  assert.equal(visible(list, ''), list)
  assert.deepEqual(visible(list, 'RAIL').map(byId), ['a'])
  assert.deepEqual(visible(list, 'jstack').map(byId), ['b'])
  assert.deepEqual(visible(list, 'npm').map(byId), ['c'])
  assert.deepEqual(visible(list, 'pr #12').map(byId), ['d'])
  assert.deepEqual(visible(list, 'nothing like it'), [])
})

test('where: a tab here, another window\'s tab, a hub tab, background or terminal', () => {
  assert.equal(where(agent('a', { pane: { tab: 2, win: 1 } }), 1), 'tab 2')
  assert.equal(where(agent('a', { pane: { tab: 2, win: 3 } }), 1), 'w3 · tab 2')
  assert.equal(where(agent('a', { pane: { tab: 2 } }), 1), 'tab 2')
  assert.equal(where(agent('a', { pane: { tab: 4, win: 1, hub: true } }), 1), 'hub tab 4')
  assert.equal(where(agent('a', { kind: 'bg' }), 1), 'bg')
  assert.equal(where(agent('a', { kind: 'interactive' }), 1), 'terminal')
})

test('the list shows beside an open session, and on a screen too narrow for lanes', () => {
  assert.equal(listMode(null, MIN_BOARD_COLS), false)
  assert.equal(listMode(null, MIN_BOARD_COLS - 1), true)
  assert.equal(listMode({ pane: '%1' }, 300), true)
})

test('selection stays on its card by id as cards move', () => {
  const sel = selection([agent('a'), agent('b'), agent('c')], byId, 'b')
  assert.equal(sel.i, 1)
  assert.equal(sel.item.id, 'b')
  assert.equal(sel.id, 'b')
  const moved = selection([agent('c'), agent('b')], byId, 'b')
  assert.equal(moved.i, 1)
})

test('selection falls to the first card when its agent disappears', () => {
  const sel = selection([agent('a'), agent('c')], byId, 'b')
  assert.equal(sel.i, 0)
  assert.equal(sel.item.id, 'a')
  assert.equal(sel.id, 'a')
  assert.equal(selection([agent('a')], byId, null).id, 'a')
})

test('an empty lane keeps the selected id, so the card is selected again when it comes back', () => {
  const sel = selection([], byId, 'b')
  assert.deepEqual([sel.i, sel.item, sel.id], [-1, null, 'b'])
  assert.equal(selection([agent('a'), agent('b')], byId, sel.id).item.id, 'b')
})

test('monitors are selected by key, not by their agent', () => {
  const list = [monitor('x'), monitor('y')]
  assert.equal(selection(list, m => m.key, 'y').i, 1)
})

test('j/k step within a lane and stop at the ends', () => {
  const list = ['a', 'b', 'c']
  assert.equal(step(list, 0, 1), 'b')
  assert.equal(step(list, 2, 1), 'c')
  assert.equal(step(list, 0, -1), 'a')
  assert.equal(step(list, 1, -1), 'a')
  assert.equal(step([], -1, 1), undefined)
})

test('h/l skip empty lanes and wrap through the monitors strip', () => {
  // Lanes 0 needs, 1 working, 2 done, 3 idle, 4 the monitors strip.
  assert.equal(nextLane(0, 1, filledOnly(0, 2)), 2)
  assert.equal(nextLane(2, 1, filledOnly(0, 2)), 0)
  assert.equal(nextLane(0, -1, filledOnly(0, 3)), 3)
  assert.equal(nextLane(3, 1, filledOnly(3, 4)), 4)
  assert.equal(nextLane(4, 1, filledOnly(1, 4)), 1)
  assert.equal(nextLane(0, -1, filledOnly(0, 4)), 4)
})

test('h/l stay put when no other lane has cards', () => {
  assert.equal(nextLane(1, 1, filledOnly(1)), 1)
  assert.equal(nextLane(1, -1, filledOnly()), 1)
})

test('focus leaves a lane once it empties, for the next one that has cards', () => {
  assert.equal(keptFocus(1, filledOnly(1, 3)), 1)
  assert.equal(keptFocus(1, filledOnly(3)), 3)
  assert.equal(keptFocus(3, filledOnly(0)), 0)
  assert.equal(keptFocus(4, filledOnly(2)), 2)
  assert.equal(keptFocus(2, filledOnly()), 2)
})

test('tab goes to the monitors strip and back to the first lane', () => {
  assert.equal(tabFocus(0), 4)
  assert.equal(tabFocus(2), 4)
  assert.equal(tabFocus(4), 0)
})

test('the list has a group per lane, then the monitors, with an empty line where there are none', () => {
  const working = agent('w')
  const watcher = agent('m', { state: 'idle', monitor: true, monitors: [monitor('k1')] })
  const items = listItems(lanes([working, watcher]), monitorsOf([working, watcher]))
  assert.deepEqual(
    items.map(x => (x.spacer ? '-' : x.group ? `#${x.group}:${x.count}` : x.empty ? `(${x.empty})` : x.id)),
    ['#needs:0', '(needs)', '-', '#working:1', 'w', '-', '#done:0', '(done)', '-', '#idle:0', '(idle)', '-', '#monitors:1', 'm:k1'],
  )
  const m = items.find(x => x.id === 'm:k1')
  assert.equal(m.agent, watcher)
  assert.equal(m.monitor.key, 'k1')
  assert.equal(items.find(x => x.id === 'w').lane, 'working')
})

test('j/k in the list skip headers and stop at the ends', () => {
  const items = listItems(lanes([agent('a', { state: 'needs' }), agent('b', { state: 'idle' })]), [])
  assert.equal(stepList(items, 'a', 1), 'b')
  assert.equal(stepList(items, 'b', 1), 'b')
  assert.equal(stepList(items, 'a', -1), 'a')
  // A selection that has gone starts again from the top.
  assert.equal(stepList(items, 'gone', 1), 'a')
  assert.equal(stepList(items, 'gone', -1), 'a')
  assert.equal(stepList(listItems(lanes([]), []), null, 1), null)
})

test('the list keeps its selection, else the open session\'s agent, else the first item', () => {
  const items = listItems(lanes([agent('a', { state: 'needs' }), agent('b', { state: 'done' }), agent('c', { state: 'idle' })]), [])
  assert.equal(listSelection(items, 'c', 'b'), 'c')
  assert.equal(listSelection(items, 'gone', 'b'), 'b')
  assert.equal(listSelection(items, 'gone', 'also gone'), 'a')
  assert.equal(listSelection(items, null, undefined), 'a')
  assert.equal(listSelection(listItems(lanes([]), []), 'a', 'a'), null)
})

test('the list scrolls by rows to keep the selected item in view', () => {
  // Item rows: a header, two agents of two rows, a spacer, a header, an agent.
  const heights = [1, 2, 2, 1, 1, 2]
  assert.equal(listScroll(heights, 1, 0, 4), 0)
  assert.equal(listScroll(heights, 2, 0, 4), 1)
  assert.equal(listScroll(heights, 5, 0, 4), 5)
  assert.equal(listScroll(heights, 1, 5, 4), 1)
  assert.equal(listScroll(heights, -1, 3, 4), 3)
})

test('the tray keeps its minimum rows, grows with monitors to a third of the screen', () => {
  assert.deepEqual(boardRows(40, 0), { stripH: 2 + MONITOR_ROWS, laneH: 40 - 4 - 2 - MONITOR_ROWS })
  assert.equal(boardRows(40, 3).stripH, 2 + MONITOR_ROWS)
  assert.equal(boardRows(60, 9).stripH, 2 + 9)
  // A third of 60 is 20, less its header and the row under it.
  assert.equal(boardRows(60, 40).stripH, 2 + 18)
})

test('on a short screen the lanes keep their rows before the tray does', () => {
  const { stripH, laneH } = boardRows(20, 3)
  assert.equal(laneH, MIN_LANE_ROWS)
  assert.equal(stripH, 2 + 4)
  // However short, the tray keeps a row and the lanes six.
  assert.deepEqual(boardRows(10, 3), { stripH: 3, laneH: 6 })
})

test('the four lanes and their gaps fill the width, the last taking the rest', () => {
  for (const W of [96, 97, 120, 203]) {
    const cols = laneColumns(W)
    assert.equal(cols.length, LANES.length)
    assert.equal(cols.reduce((n, c) => n + c.w, 0) + 3 * LANE_GAP, W)
    cols.forEach((c, i) => i && assert.equal(c.x, cols[i - 1].x + cols[i - 1].w + LANE_GAP))
    assert.equal(cols[0].x, 1)
  }
  assert.deepEqual(laneColumns(97).map(c => c.w), [22, 22, 22, 25])
})

test('the tray shows the selected monitor, keeping a row to say how many it hides', () => {
  assert.deepEqual(trayWindow(3, 5, 0), { top: 0, room: 5 })
  assert.deepEqual(trayWindow(8, 5, 0), { top: 0, room: 4 })
  assert.deepEqual(trayWindow(8, 5, 6), { top: 3, room: 4 })
  assert.deepEqual(trayWindow(8, 5, 7), { top: 4, room: 4 })
  assert.deepEqual(trayWindow(0, 5, -1), { top: 0, room: 5 })
})

test('x refuses working and needs-you agents, and ones outside the layout', () => {
  assert.equal(closeQuestion(agent('a', { state: 'working', pane: {} }), 'tab 1').refuse, 'Only Done and Idle agents close from here')
  assert.equal(closeQuestion(agent('a', { state: 'needs', jobId: 'j' }), 'bg').refuse, 'Only Done and Idle agents close from here')
  assert.equal(closeQuestion(agent('a', { state: 'idle' }), 'terminal').refuse, 'a runs outside the layout; close it where it runs')
})

test('x asks to close a tab, stop a background agent, or both for a parked tab', () => {
  const q = (extra, place) => closeQuestion(agent('fix', { state: 'done', ...extra }), place)
  assert.deepEqual(q({ pane: { window: '@1' } }, 'tab 2'), { how: 'tab', text: 'Close tab 2 (fix)?' })
  assert.deepEqual(q({ jobId: 'j1' }, 'bg'), { how: 'job', text: 'Stop background agent fix? Its conversation is kept.' })
  assert.deepEqual(q({ pane: { window: '@1' }, jobId: 'j1' }, 'tab 2'), {
    how: 'tab+job',
    text: 'Close tab 2 and stop background agent fix? Its conversation is kept.',
  })
})

test('x says how many live monitors closing ends', () => {
  const q = monitors => closeQuestion(agent('fix', { state: 'idle', pane: {}, monitors }), 'tab 1').text
  assert.equal(q([monitor('a', { state: 'ended' })]), 'Close tab 1 (fix)?')
  assert.equal(q([monitor('a'), monitor('b', { state: 'ended' })]), 'Close tab 1 (fix) and its monitor?')
  assert.equal(q([monitor('a'), monitor('b', { state: 'stale' }), monitor('c', { state: 'action' })]), 'Close tab 1 (fix) and its 3 monitors?')
})

test('a and d only answer a permission dialog whose first choice is near the bottom', () => {
  const dialog = 'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n'
  assert.equal(showsPermission(dialog), true)
  assert.equal(showsPermission(dialog.replace('❯ 1. Yes', '  1. Yes')), false)
  assert.equal(showsPermission('> type here\n'), false)
  // Blank lines don't count against the 15, so padding below doesn't hide it.
  assert.equal(showsPermission(`${dialog}${'\n'.repeat(40)}`), true)
  assert.equal(showsPermission(`${dialog}${'output\n'.repeat(13)}`), true)
  assert.equal(showsPermission(`${dialog}${'output\n'.repeat(14)}`), false)
})

test('the hub takes back the pane marked @peek and the tab it shows', () => {
  assert.equal(markedPane('%1 \n%7 1\n%9 '), '%7')
  assert.equal(markedPane('%1 \n%2 0\n'), undefined)
  assert.equal(activeWindow('0 @3\n1 @5\n'), '@5')
  assert.equal(activeWindow('0 @3\n'), null)
  assert.equal(activeWindow(''), null)
})

test('shq quotes for a shell, single quotes included', () => {
  assert.equal(shq('/a b/newagent.mjs'), "'/a b/newagent.mjs'")
  assert.equal(shq(`{"folder":"it's"}`), `'{"folder":"it'\\''s"}'`)
})
