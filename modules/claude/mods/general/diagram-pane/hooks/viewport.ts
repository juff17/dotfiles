import type { View } from '../types'

export type Size = { width: number; height: number }
export type Cells = { columns: number; rows: number }
// The zoomed image's size in cells, and which of its cells sits at the
// viewport's top left.
export type Layout = Cells & { left: number; top: number }

// Ghostty draws an image stretched to its cell box, so rows come from the
// PNG's aspect ratio and the cell's width over height (about 1:2).
const CELL_ASPECT = 0.5
// An Image spans at most 255 cells each way, which caps the zoom.
const MAX_CELLS = 255
const MAX_ZOOM = 8
const ZOOM_STEP = 1.12
const PAN_STEP = 0.25

export const HOME: View = { zoom: 1, x: 0.5, y: 0.5 }

export const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))

export const fit = (image: Size, room: Cells, natural: number): Cells => {
  const tall = (cols: number) => Math.round(((cols * image.height) / image.width) * CELL_ASPECT)
  let cols = Math.min(room.columns, MAX_CELLS, natural)
  if (tall(cols) > room.rows) cols = Math.floor((room.rows * image.width) / (image.height * CELL_ASPECT))
  cols = clamp(cols, 1, MAX_CELLS)
  return { columns: cols, rows: clamp(tall(cols), 1, MAX_CELLS) }
}

const maxZoom = (base: Cells) => Math.min(MAX_ZOOM, MAX_CELLS / base.columns, MAX_CELLS / base.rows)

export const layout = (base: Cells, room: Cells, v: View): Layout => {
  const columns = Math.round(base.columns * v.zoom)
  const rows = Math.round(base.rows * v.zoom)
  return {
    columns,
    rows,
    left: Math.round(clamp(v.x * columns - room.columns / 2, 0, Math.max(0, columns - room.columns))),
    top: Math.round(clamp(v.y * rows - room.rows / 2, 0, Math.max(0, rows - room.rows))),
  }
}

// Keeps the image point under the given viewport cell in place, as map apps
// zoom.
export const zoomAt = (v: View, base: Cells, at: Layout, room: Cells, steps: number, column: number, row: number): View => {
  const zoom = clamp(v.zoom * ZOOM_STEP ** steps, 1, Math.max(1, maxZoom(base)))
  const px = (at.left + column) / at.columns
  const py = (at.top + row) / at.rows
  const columns = base.columns * zoom
  const rows = base.rows * zoom
  return {
    zoom,
    x: clamp((px * columns - column + room.columns / 2) / columns, 0, 1),
    y: clamp((py * rows - row + room.rows / 2) / rows, 0, 1),
  }
}

export const pan = (v: View, at: Layout, room: Cells, dx: number, dy: number): View => ({
  zoom: v.zoom,
  x: clamp((at.left + room.columns * (0.5 + dx * PAN_STEP)) / at.columns, 0, 1),
  y: clamp((at.top + room.rows * (0.5 + dy * PAN_STEP)) / at.rows, 0, 1),
})
