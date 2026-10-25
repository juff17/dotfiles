import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_GRID, clampView, home, panBy, placement, zoomAt } from './view.mjs'

const image = { width: 1200, height: 2000 }
const region = { cols: 60, rows: 40, cw: 10, ch: 20 }

test('at zoom 1 the whole image fits, centered across', () => {
  const at = placement(image, region, home(image))
  assert.deepEqual([at.x, at.y, at.w, at.h], [0, 0, 1200, 2000])
  assert.equal(at.rows, 40)
  assert.equal(at.col, Math.floor((60 - at.cols) / 2))
})

test('zooming keeps the point under the pointer in place', () => {
  const view = zoomAt(image, region, home(image), 2, 300, 400)
  const before = placement(image, region, home(image))
  const after = placement(image, region, view)
  const pointAt = (at, px, py) => [
    at.x + ((px - at.col * region.cw) / (at.cols * region.cw)) * at.w,
    at.y + ((py - at.row * region.ch) / (at.rows * region.ch)) * at.h,
  ]
  const [bx, by] = pointAt(before, 300, 400)
  const [ax, ay] = pointAt(after, 300, 400)
  assert.ok(Math.abs(ax - bx) < 15 && Math.abs(ay - by) < 15, `${bx},${by} moved to ${ax},${ay}`)
})

test('panning stops at the image edge', () => {
  const zoomed = clampView(image, region, { zoom: 4, cx: 600, cy: 1000 })
  const far = panBy(image, region, zoomed, 100000, 100000)
  const at = placement(image, region, far)
  assert.equal(at.x, 0)
  assert.equal(at.y, 0)
})

test('the grid keeps the image shape and shows the cells the view is on', () => {
  const at = placement(image, region, clampView(image, region, { zoom: 2, cx: 900, cy: 1000 }))
  assert.equal(at.gridCols / at.gridRows, (image.width * region.ch) / (image.height * region.cw))
  assert.equal(at.cols, region.cols)
  assert.equal(at.gridCol, at.gridCols - at.cols)
})

test('zoom stops where the grid would outgrow the diacritics', () => {
  const at = placement(image, region, clampView(image, region, { zoom: 16, cx: 600, cy: 1000 }))
  assert.ok(at.gridCols <= MAX_GRID && at.gridRows <= MAX_GRID)
  assert.equal(Math.max(at.gridCols, at.gridRows), MAX_GRID)
})
