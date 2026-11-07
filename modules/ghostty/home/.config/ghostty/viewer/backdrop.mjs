// The diagrams window's frame takes most of the screen, not all of it, and
// round it dv draws the window Alt+D was pressed in, dimmed, like the scrim
// behind the hub's popups. tmux can't show dv in a popup over that window
// (the pictures need passthrough, which popups drop), so this is a snapshot of
// its panes' text, taken as dv starts.

import { charWidth } from '../hub/term.mjs'

// A picture in the viewer pane is kitty placeholder cells: U+10EEEE and the
// marks that number its rows and columns. Drawn again here they would name an
// image, so they become blanks.
const PLACEHOLDER = /\u{10EEEE}\p{Mn}*/gu

// The frame: `share` percent of the screen each way, centered. A small screen
// gets all of it.
export function frameBox(cols, rows, share) {
  if (share >= 100 || cols < 70 || rows < 20) return { left: 0, top: 0, w: cols, h: rows }
  const w = Math.round((cols * share) / 100)
  const h = Math.round((rows * share) / 100)
  return { left: Math.floor((cols - w) / 2), top: Math.floor((rows - h) / 2), w, h }
}

// The panes ({ left, top, width, height, lines } as tmux lists them) laid out
// on a cols × rows grid of cells, with the dividers tmux draws between them.
// A wide character's second cell is ''.
export function compose(panes, cols, rows) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '))
  const put = (r, c, ch) => {
    if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch
  }
  for (const p of panes) {
    if (p.left > 0) for (let r = 0; r < p.height; r++) put(p.top + r, p.left - 1, '│')
    // From the column of the pane's left divider, so the dividers meet.
    if (p.top > 0) for (let c = p.left > 0 ? -1 : 0; c < p.width; c++) put(p.top - 1, p.left + c, '─')
  }
  for (const p of panes) {
    p.lines.slice(0, p.height).forEach((line, r) => {
      let c = 0
      for (const ch of line.replace(PLACEHOLDER, ' ')) {
        const w = charWidth(ch)
        if (w === 0) continue
        if (c + w > p.width) break
        put(p.top + r, p.left + c, ch)
        if (w === 2) put(p.top + r, p.left + c + 1, '')
        c += w
      }
    })
  }
  return grid
}

// Cells from to to (not included) of a grid row as text exactly that wide: a
// wide character cut in half by either end becomes a blank.
export function slice(row = [], from, to) {
  let s = ''
  for (let c = from; c < to; c++) {
    const ch = row[c] ?? ' '
    if (ch === '') s += c === from ? ' ' : ''
    else if (row[c + 1] === '' && c + 1 >= to) s += ' '
    else s += ch
  }
  return s
}
