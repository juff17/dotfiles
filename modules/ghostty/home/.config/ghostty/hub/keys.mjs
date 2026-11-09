// What the hub's keys and clicks do, apart from doing it: the action each
// key names, how a y/n question and the filter take keys, and which clicks
// count. hub.mjs runs the actions; keys.test.mjs pins the bindings.

import { editField } from './line.mjs'

// What Alt+N (layout.conf) and the rail's + new send the hub to open New
// agent, whatever it's in the middle of.
export const NEW_AGENT_KEY = '\x1b[9100~'
// What Ctrl+Shift+B and Ctrl+] send just before they close the open session,
// so the hub draws the board, not the list, once its pane widens.
export const PEEK_CLOSING_KEY = '\x1b[9101~'
// What the tray sends to have the hub open an agent's session, after writing
// the agent's id to HUB_OPEN (tray.mjs): a background agent has no tab to go to.
export const OPEN_AGENT_KEY = '\x1b[9102~'
// What Alt+D (layout.conf) sends the hub to show the diagrams of the tab
// you're looking at here: the open session's, or the selected card's.
export const DIAGRAMS_KEY = '\x1b[9103~'

// The board's and the list's keys, by the action they name.
export const KEYS = {
  h: 'laneLeft',
  l: 'laneRight',
  '\x1b[D': 'laneLeft',
  '\x1b[C': 'laneRight',
  j: 'down',
  k: 'up',
  '\x1b[B': 'down',
  '\x1b[A': 'up',
  '\t': 'tab',
  '\r': 'open',
  a: 'allow',
  d: 'deny',
  e: 'reviewed',
  E: 'reviewAll',
  o: 'goToTab',
  x: 'close',
  n: 'new',
  '/': 'filter',
  '\x1b': 'back',
  q: 'workspace',
}

// Own keys only, so a key named like an Object method is no action.
export const keyAction = key => (Object.hasOwn(KEYS, key) ? KEYS[key] : null)

// A question waiting in the footer takes the next key, whatever it is: y
// answers yes, a yes and don't ask again when the question can be skipped,
// anything else no. `remember` names the question to stop asking.
export function answerConfirm(confirm, key) {
  if (key === 'y') return { yes: true, remember: null }
  if (key === 'a' && confirm.skip) return { yes: true, remember: confirm.skip }
  return { yes: false, remember: null }
}

// A key while typing a filter, with its caret `at` in (hub/line.mjs; none
// is the end): Enter keeps it, Esc clears it, and the rest edit it as any
// line does. The caret comes back as `at` only when it's off the end.
export function filterKey(filter, key, at) {
  if (key === '\r') return { filter, filtering: false }
  if (key === '\x1b') return { filter: '', filtering: false }
  const state = { filter, filtering: true, ...(at === undefined ? {} : { at }) }
  editField(state, 'filter', key)
  return state
}

// An SGR mouse report: the wheel moves the selection (down +1, up -1); a
// left press clicks; releases, other buttons and drags do nothing.
export function mouseAction({ button, up }) {
  if (button & 64) return { wheel: button & 1 ? 1 : -1 }
  if (up || (button & 3) !== 0 || button & 32) return null
  return { click: true }
}

// The clickable region of the last frame under x, y; with `wheel`, only
// regions that take the wheel (a lane).
export const hitAt = (hits, x, y, wheel = false) =>
  hits.find(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2 && (!wheel || r.wheel !== undefined))
