// The hub's decisions, apart from its terminal and tmux: what's shown, what's
// selected and where it moves, how the board divides the screen, and what
// x asks before closing. hub.mjs keeps the state and draws; these only
// compute, so they can be tested (board.test.mjs).

export const LANES = ['needs', 'working', 'done', 'idle']
// Below this width the lanes get too narrow to read, so the hub draws the
// list it shows beside an open session.
export const MIN_BOARD_COLS = 96
// Rows the monitors tray keeps for monitors even when few or none run, so
// the board doesn't jump as monitors come and go; Settings' hub.monitorRows
// changes it. It grows past this, up to about a third of the screen, when
// more are running.
export const MONITOR_ROWS = 5
// The fewest rows the lanes keep on a short screen, before the tray gives up
// its minimum.
export const MIN_LANE_ROWS = 10
// Columns between two lanes.
export const LANE_GAP = 2

export function visible(agents, filter) {
  if (!filter) return agents
  const f = filter.toLowerCase()
  return agents.filter(a => `${a.title} ${a.repo} ${a.cmd} ${a.monitors.map(m => m.description).join(' ')}`.toLowerCase().includes(f))
}

// Where an agent runs, as its card says: its tab, with the Ghostty window
// when it's another window's (win is this hub's).
export function where(a, win) {
  if (a.pane) {
    const tab = `${a.pane.hub ? 'hub tab' : 'tab'} ${a.pane.tab}`
    return a.pane.win === win || !a.pane.win ? tab : `w${a.pane.win} · ${tab}`
  }
  return a.kind === 'bg' ? 'bg' : 'terminal'
}

export const listMode = (peek, cols) => Boolean(peek) || cols < MIN_BOARD_COLS

// The selected item of a lane, kept by id so it stays put as cards move.
// When the id is gone the first item takes over; an empty lane keeps the id,
// so the card is selected again if it comes back. `id` is the selection to
// keep.
export function selection(list, key, id) {
  let i = list.findIndex(x => key(x) === id)
  if (i < 0 && list.length) {
    i = 0
    id = key(list[0])
  }
  return { list, i, item: list[i] ?? null, id }
}

// The item n steps from i, held at the ends rather than wrapping.
export const step = (list, i, n) => list[Math.min(list.length - 1, Math.max(0, i + n))]

// h/l and the arrows step to the next lane with cards in it, skipping empty
// ones, where nothing would show as selected; lanes wrap, the monitors strip
// (4) counting as the fifth. Stays put when no other lane has anything.
export function nextLane(focus, n, filled) {
  for (let s = 1; s < 5; s++) {
    const next = (((focus + n * s) % 5) + 5) % 5
    if (filled(next)) return next
  }
  return focus
}

// When the focused lane is empty (at start, or its last card moved on),
// focus goes to the next lane that has cards.
export function keptFocus(focus, filled) {
  if (filled(focus)) return focus
  for (let s = 1; s < 5; s++) {
    const next = (focus + s) % 5
    if (filled(next)) return next
  }
  return focus
}

// Tab goes between the lanes and the monitors strip; with no monitors it
// stays put, since the empty strip would only hand focus to another lane.
export const tabFocus = (focus, filled) => (focus === 4 ? 0 : filled(4) ? 4 : focus)

// The board as one column, beside an open session: a group per lane, then
// the monitors, each with a header, a line saying so when it's empty, and a
// row of space before the next. `l` is the lanes, `monitors` the strip.
export function listItems(l, monitors) {
  const items = []
  const group = (name, list, toItem) => {
    if (items.length) items.push({ spacer: true })
    items.push({ group: name, count: list.length })
    if (!list.length) items.push({ empty: name })
    for (const x of list) items.push(toItem(x))
  }
  for (const name of LANES) group(name, l[name], a => ({ id: a.id, agent: a, lane: name }))
  group('monitors', monitors, m => ({ id: `m:${m.key}`, agent: m.agent, monitor: m }))
  return items
}

// j/k in the list: the next item that can be selected, held at the ends.
export function stepList(items, sel, n) {
  const pickable = items.filter(x => x.id)
  const i = pickable.findIndex(x => x.id === sel)
  return step(pickable, i, n)?.id ?? null
}

// The list's selection once it has redrawn: kept while its item is there,
// otherwise the open session's agent, otherwise the first item.
export function listSelection(items, sel, peekId) {
  const pickable = items.filter(x => x.id)
  if (pickable.some(x => x.id === sel)) return sel
  return (pickable.find(x => x.agent.id === peekId) ?? pickable[0])?.id ?? null
}

// The list's first row so the selected item is in view: the rows of each
// item are `heights`, `room` the rows there are.
export function listScroll(heights, sel, top, room) {
  if (sel < 0) return top
  const first = heights.slice(0, sel).reduce((n, h) => n + h, 0)
  const last = first + heights[sel]
  if (first < top) top = first
  if (last > top + room) top = last - room
  return top
}

// The rows the lanes and the monitors tray get on a screen H rows high,
// with `mons` monitors. The tray is its header and the row under it, then
// its rows: at least `kept`, more with more monitors, up to about a third
// of the screen; on a short screen the lanes keep MIN_LANE_ROWS first.
export function boardRows(H, mons, kept = MONITOR_ROWS) {
  const most = Math.max(kept, Math.floor(H / 3) - 2)
  const fit = Math.max(1, H - 4 - MIN_LANE_ROWS - 2)
  const stripH = 2 + Math.min(Math.min(Math.max(mons, kept), most), fit)
  const laneH = Math.max(6, H - 2 - stripH - 2)
  return { stripH, laneH }
}

// Each lane's width and first column on a screen W wide: four equal lanes,
// the last taking what's left over.
export function laneColumns(W) {
  const w = Math.floor((W - 3 * LANE_GAP) / 4)
  return LANES.map((_, i) => ({ w: i === 3 ? W - 3 * (w + LANE_GAP) : w, x: 1 + i * (w + LANE_GAP) }))
}

// The tray's first monitor and how many it shows in `space` rows: a full
// tray keeps a row to say how many it hides.
export function trayWindow(n, space, sel) {
  const room = n > space ? space - 1 : space
  const top = Math.max(0, Math.min(sel - room + 1, n - room))
  return { top, room }
}

// What x asks before closing a done or idle agent, or why it won't: a tab
// agent's tab, or a background agent, stopped with its conversation kept. A
// tab parked on a background job is one agent with it, so both go. Closing a
// session ends every monitor it armed, so the question says how many. `how`
// says which of the three closes it; `place` is where(a).
export function closeQuestion(a, place) {
  if (a.state === 'working' || a.state === 'needs') return { refuse: 'Only Done and Idle agents close from here' }
  const live = a.monitors.filter(m => m.state !== 'ended').length
  const also = live ? ` and its ${live === 1 ? 'monitor' : `${live} monitors`}` : ''
  if (a.pane && a.jobId) return { how: 'tab+job', text: `Close ${place} and stop background agent ${a.title}${also}? Its conversation is kept.` }
  if (a.pane) return { how: 'tab', text: `Close ${place} (${a.title})${also}?` }
  if (a.jobId) return { how: 'job', text: `Stop background agent ${a.title}${also}? Its conversation is kept.` }
  return { refuse: `${a.title} runs outside the layout; close it where it runs` }
}

// Whether a pane's screen shows a permission dialog with its first choice
// at the bottom, so pressing 1 or Esc answers it rather than landing in
// Claude's input box.
export function showsPermission(screen) {
  const bottom = screen.split('\n').filter(l => l.trim()).slice(-15).join('\n')
  return /❯\s*1\.\s*Yes/.test(bottom)
}

// The pane marked @peek in `list-panes -F '#{pane_id} #{@peek}'` output.
export const markedPane = list => list.split('\n').map(l => l.split(' ')).find(([, mark]) => mark === '1')?.[0]

// The active window in `list-windows -F '#{window_active} #{window_id}'` output.
export const activeWindow = out => out.split('\n').find(l => l.startsWith('1 '))?.slice(2) ?? null

export const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`
