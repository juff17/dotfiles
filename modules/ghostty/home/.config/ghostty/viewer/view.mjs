// Zoom and pan in image pixels. The region is the cell box the picture may
// fill, with each cell's size in pixels (cw, ch).

import { load as settings } from '../hub/settings.mjs'

// Settings' viewer.maxZoom: the most a diagram zooms in.
export const maxZoomSetting = () => settings()['viewer.maxZoom']
// The picture is a grid of placeholder cells (kitty.mjs), which can't have
// more rows or columns than there are diacritics to number them.
export const MAX_GRID = 297

const clamp = (n, low, high) => Math.max(low, Math.min(high, n))

const fitScale = (image, region) =>
  Math.min((region.cols * region.cw) / image.width, (region.rows * region.ch) / image.height)

export const home = image => ({ zoom: 1, cx: image.width / 2, cy: image.height / 2 })

const maxZoom = (image, region) => {
  const fit = fitScale(image, region)
  const grid = Math.min((MAX_GRID * region.cw) / (image.width * fit), (MAX_GRID * region.ch) / (image.height * fit))
  return Math.max(1, Math.min(maxZoomSetting(), grid))
}

// Keeps the view's edges inside the image; an axis that fits whole is centered.
export function clampView(image, region, view) {
  const zoom = clamp(view.zoom, 1, maxZoom(image, region))
  const scale = fitScale(image, region) * zoom
  const halfW = (region.cols * region.cw) / scale / 2
  const halfH = (region.rows * region.ch) / scale / 2
  return {
    zoom,
    cx: halfW * 2 >= image.width ? image.width / 2 : clamp(view.cx, halfW, image.width - halfW),
    cy: halfH * 2 >= image.height ? image.height / 2 : clamp(view.cy, halfH, image.height - halfH),
  }
}

// The whole image scaled into a grid of gridCols × gridRows cells, and the
// cols × rows of them the region shows from (gridCol, gridRow) on, centered
// in the region when they don't fill it. x, y, w, h is the image rectangle
// those cells show. Panning moves by whole cells.
export function placement(image, region, view) {
  const scale = fitScale(image, region) * view.zoom
  const gridCols = clamp(Math.round((image.width * scale) / region.cw), 1, MAX_GRID)
  const gridRows = clamp(Math.round((image.height * scale) / region.ch), 1, MAX_GRID)
  const cols = Math.min(gridCols, region.cols)
  const rows = Math.min(gridRows, region.rows)
  const gridCol = clamp(Math.round((view.cx * scale) / region.cw - cols / 2), 0, gridCols - cols)
  const gridRow = clamp(Math.round((view.cy * scale) / region.ch - rows / 2), 0, gridRows - rows)
  return {
    col: Math.floor((region.cols - cols) / 2),
    row: Math.floor((region.rows - rows) / 2),
    cols,
    rows,
    gridCols,
    gridRows,
    gridCol,
    gridRow,
    x: Math.round((gridCol * image.width) / gridCols),
    y: Math.round((gridRow * image.height) / gridRows),
    w: Math.round((cols * image.width) / gridCols),
    h: Math.round((rows * image.height) / gridRows),
  }
}

// Zooms by `factor` keeping the image point under the pointer (px, py, in
// pixels from the region's top left) where it is.
export function zoomAt(image, region, view, factor, px, py) {
  const at = placement(image, region, view)
  const ix = at.x + clamp((px - at.col * region.cw) / (at.cols * region.cw), 0, 1) * at.w
  const iy = at.y + clamp((py - at.row * region.ch) / (at.rows * region.ch), 0, 1) * at.h
  const zoom = clamp(view.zoom * factor, 1, maxZoom(image, region))
  const scale = fitScale(image, region) * zoom
  const cx = ix + (region.cols * region.cw) / scale / 2 - px / scale
  const cy = iy + (region.rows * region.ch) / scale / 2 - py / scale
  return clampView(image, region, { zoom, cx, cy })
}

// The run of diagram chips, `widths` cells each, that fits in `room` cells
// and holds the current one: chips start to end - 1. It starts as far left as
// it can, so the row only scrolls once the current chip would fall off it.
export function fitChips(widths, index, room) {
  const sum = (from, to) => widths.slice(from, to).reduce((n, w) => n + w, 0)
  let start = 0
  while (start < index && sum(start, index + 1) > room) start++
  let end = start
  while (end < widths.length && sum(start, end + 1) <= room) end++
  return { start, end: Math.max(end, Math.min(index + 1, widths.length)) }
}

// Moves the picture with a drag of (dx, dy) screen pixels.
export function panBy(image, region, view, dx, dy) {
  const scale = fitScale(image, region) * view.zoom
  return clampView(image, region, { ...view, cx: view.cx - dx / scale, cy: view.cy - dy / scale })
}
