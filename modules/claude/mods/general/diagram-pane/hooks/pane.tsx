import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput, UiScrollInput } from 'claude-code'

import type { Diagram } from '../types'
import { log, logLines } from './log'
import { cacheDir, ensureRendered, removeRender, SCALE } from './mermaid'
import { type Cells, type Layout, clamp, fit, HOME, layout, pan, zoomAt } from './viewport'

// Where the viewport sits in the pane body: after paddingX, below the tab row
// and its margin.
const VIEWPORT_LEFT = 1
const VIEWPORT_TOP = 2
// Rows the pane draws besides the viewport: tabs, two margins, two control rows.
const CHROME_ROWS = 5
const TAB_MAX = 18
const MAX_DIAGRAMS = 50
// Sessions whose tabs the store keeps for a resume, the least recently used
// going first with their PNGs.
const MAX_SESSIONS = 20
const PAN_KEYS = [
  ['h', '←', -1, 0],
  ['j', '↓', 0, 1],
  ['k', '↑', 0, -1],
  ['l', '→', 1, 0],
] as const

const diagrams = atom({ plugin: 'diagram-pane', key: 'diagrams' } as const, [], {
  shape: 'diagrams-2',
})
const current = atom({ plugin: 'diagram-pane', key: 'current' } as const, 0)
const view = atom({ plugin: 'diagram-pane', key: 'view' } as const, HOME)
const logOpen = atom({ plugin: 'diagram-pane', key: 'logOpen' } as const, false)
const redraws = atom({ plugin: 'diagram-pane', key: 'redraws' } as const, 0)

// What the pane last drew, so a wheel tick can tell which cell it was over.
let shown: { file: string; base: Cells; room: Cells; at: Layout } | undefined
// The terminal keeps the picture it was last sent, so zooming and panning
// resize and move the same bytes instead of sending new ones.
let source = { file: '', base64: '' }
// The terminal can drop the picture while another transcript is in view, and
// the engine sends nothing for a source equal to the last one drawn, so each
// switch of view keys the Image afresh to send its bytes again.
let lastView: string | undefined
let viewSwitches = 0
// The facts of the last frame, logged only when they change.
let lastFrame = ''

const tabLabel = (title: string) =>
  title.length > TAB_MAX ? `${title.slice(0, TAB_MAX - 1)}…` : title

// The run of tabs around the current one that fits the row, grown one tab at
// a time on alternating sides, with room left for the overflow counts.
const tabWindow = (titles: string[], index: number, columns: number) => {
  const width = (i: number) => tabLabel(titles[i] ?? '').length + 3
  const room = columns - 8
  let start = index
  let end = index + 1
  let used = width(index)
  for (let grew = true; grew; ) {
    grew = false
    if (end < titles.length && used + width(end) <= room) {
      used += width(end++)
      grew = true
    }
    if (start > 0 && used + width(start - 1) <= room) {
      used += width(--start)
      grew = true
    }
  }
  return { start, end }
}

type Saved = { diagrams: Diagram[]; current: number; used: number }

// The session whose tabs are loaded. A /clear goes on under a new id without
// a session.start, so each change checks the id first.
let loadedSession: string | undefined

async function savedSessions($: EngineInterface) {
  const all = await $.store.get('sessions')
  return (all && typeof all === 'object' ? all : {}) as Record<string, Saved>
}

// `$.state` lasts a session; the store keeps each session's tabs, under its id,
// for a resume.
async function persist($: EngineInterface) {
  const all = await savedSessions($)
  all[await $.session.id()] = { diagrams: await read($, diagrams), current: await read($, current), used: Date.now() }
  const byUse = Object.keys(all).sort((a, b) => all[b]!.used - all[a]!.used)
  for (const id of byUse.slice(MAX_SESSIONS)) {
    for (const diagram of all[id]!.diagrams) await removeRender($, diagram)
    delete all[id]
  }
  await $.store.set('sessions', all)
  await publish($)
}

// The Ghostty layout's viewer (dv, in ghosty-config) runs outside Claude Code,
// so it reads the tabs from a file per tmux pane beside the PNGs and shows the
// active tab's. Named for the tmux socket too, as pane ids repeat across
// servers. Its format is in the README.
async function paneFile($: EngineInterface) {
  const tmux = await $.env.get('TMUX')
  const pane = await $.env.get('TMUX_PANE')
  if (!tmux || !pane) return undefined
  const socket = tmux.split(',')[0]!.split('/').pop()
  return `${await cacheDir($)}/panes/${socket}-${pane.replace('%', '')}.json`
}

async function publish($: EngineInterface) {
  const file = await paneFile($)
  if (!file) return
  const list = (await read($, diagrams)).map(({ id, title, file, width, height }) => ({ id, title, file, width, height }))
  const state = { session: await $.session.id(), diagrams: list, current: await read($, current) }
  await $.fs.write(file, JSON.stringify(state))
}

// dv closes tabs by rewriting the pane file, which the mod can't watch, so a
// change starts from the tabs the file says this session still has.
async function syncFromViewer($: EngineInterface) {
  const file = await paneFile($)
  if (!file) return
  let shown: { session?: unknown; diagrams?: unknown; current?: unknown }
  try {
    shown = JSON.parse(await $.fs.read(file))
  } catch {
    return
  }
  if (shown.session !== (await $.session.id()) || !Array.isArray(shown.diagrams)) return
  const kept = new Set((shown.diagrams as { id?: unknown }[]).map(d => d.id))
  const list = await update($, diagrams, all => all.filter(d => kept.has(d.id)))
  await update($, current, () => clamp(Number(shown.current) || 0, 0, Math.max(0, list.length - 1)))
}

// Loads this session's tabs: none for a new session, its own on a resume.
// Answers how many there are.
export async function restore($: EngineInterface) {
  // Tabs were once kept for every session at once, under these keys.
  await $.store.delete('diagrams')
  await $.store.delete('current')
  loadedSession = await $.session.id()
  const saved = (await savedSessions($))[loadedSession]
  const list = await update($, diagrams, () => saved?.diagrams ?? [])
  await update($, current, () => clamp(saved?.current ?? 0, 0, Math.max(0, list.length - 1)))
  await update($, view, () => HOME)
  await publish($)
  return list.length
}

// Before a change: the session's own tabs, less any dv closed.
async function prepare($: EngineInterface) {
  if (loadedSession !== (await $.session.id())) await restore($)
  await syncFromViewer($)
}

// Saves the ending session's tabs for a resume. Its pane file goes when the
// session does, so dv shows nothing for that tab; a /clear or a resume goes on
// in the same pane, so the file empties instead and the next change loads the
// new session's tabs.
export async function endSession($: EngineInterface, reason: string) {
  await syncFromViewer($)
  await persist($)
  loadedSession = undefined
  const file = await paneFile($)
  if (!file) return
  if (reason === 'clear' || reason === 'resume') {
    await update($, diagrams, () => [])
    await update($, current, () => 0)
    await publish($)
  } else {
    await $.process.run(['rm', '-f', file])
  }
}

// Appends the diagram as the newest tab and shows it, evicting the least
// recently opened past the limit; answers how many tabs there are.
export async function addDiagram($: EngineInterface, diagram: Diagram) {
  await prepare($)
  let list = [...(await read($, diagrams)), diagram]
  while (list.length > MAX_DIAGRAMS) {
    const oldest = list.reduce((a, b) => (b.opened < a.opened ? b : a))
    await removeRender($, oldest)
    list = list.filter(d => d !== oldest)
  }
  await update($, diagrams, () => list)
  await update($, current, () => list.length - 1)
  await update($, view, () => HOME)
  await persist($)
  return list.length
}

async function open($: EngineInterface, index: number) {
  await prepare($)
  const now = Date.now()
  const list = await update($, diagrams, all => all.map((d, i) => (i === index ? { ...d, opened: now } : d)))
  await update($, current, () => clamp(index, 0, list.length - 1))
  await update($, view, () => HOME)
  await persist($)
}

function frame($: EngineInterface, facts: string) {
  if (facts === lastFrame) return
  lastFrame = facts
  log($, `draw ${facts}`)
}

// Sends the picture again, for a terminal that lost it.
async function redraw($: EngineInterface) {
  log($, 'redraw pressed')
  await update($, redraws, n => n + 1)
}

async function showing($: EngineInterface) {
  const list = await read($, diagrams)
  return list[Math.min(await read($, current), list.length - 1)]
}

async function zoomBy($: EngineInterface, diagram: Diagram, steps: number, column: number, row: number) {
  if (shown?.file !== diagram.file) return
  const { base, room, at } = shown
  await update($, view, v => zoomAt(v, base, at, room, steps, column, row))
}

async function panBy($: EngineInterface, diagram: Diagram, dx: number, dy: number) {
  if (shown?.file !== diagram.file) return
  const { room, at } = shown
  await update($, view, v => pan(v, at, room, dx, dy))
}

// The wheel zooms rather than scrolls; the arrow keys arrive here too, with
// no pointer, and pan.
export async function scrollPane($: EngineInterface, e: UiScrollInput) {
  const diagram = await showing($)
  if (!diagram || !shown) return {}
  if (!e.pointer) {
    await panBy($, diagram, 0, Math.sign(e.by))
    return {}
  }
  const { room } = shown
  const column = e.pointer.column - VIEWPORT_LEFT
  const row = e.pointer.row - VIEWPORT_TOP
  const inside = column >= 0 && column < room.columns && row >= 0 && row < room.rows
  await zoomBy(
    $,
    diagram,
    -e.by,
    inside ? column : Math.floor(room.columns / 2),
    inside ? row : Math.floor(room.rows / 2),
  )
  return {}
}

function drawLog($: EngineInterface, e: RenderInput<'Pane', 'terminal'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const all = logLines()
  const tail = all.slice(-Math.max(1, e.props.scroll.bodyRows - 3))
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text bold>Log</Text>
        <Text dimColor>
          {all.length} lines · also in ~/.cache/claude-diagram-pane/debug.log
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {tail.length === 0 ? <Text dimColor>Nothing logged yet.</Text> : null}
        {tail.map((line, i) => (
          <Text key={`line-${i}`} wrap="truncate-end" color={/threw|failed|not placed/.test(line) ? 'error' : undefined}>
            {line}
          </Text>
        ))}
      </Box>
      <Box gap={1} marginTop={1}>
        <Button key="log" hotkey="d" plain label="back to diagrams" onPress={() => update($, logOpen, () => false)} />
      </Box>
    </Box>
  )
}

export async function drawPane($: EngineInterface, e: RenderInput<'Pane', 'terminal'>) {
  const { Box, Text, Button, Image, Link } = $.ui.resolve(e)
  const inView = e.props.view.agentId ?? 'main'
  if (lastView !== undefined && inView !== lastView) {
    viewSwitches++
    log($, `view ${lastView} -> ${inView}; image re-keyed`)
  }
  lastView = inView
  if (await read($, logOpen)) return drawLog($, e)

  const list = await read($, diagrams)
  const index = Math.min(await read($, current), list.length - 1)
  const saved = list[index]

  if (!saved) {
    shown = undefined
    frame($, `view=${inView} ${e.props.placement} empty`)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Text color="claude">◆</Text>
          <Text bold>Diagrams</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Ask for a diagram and it draws here.</Text>
        </Box>
        <Box marginTop={1}>
          <Button key="log" hotkey="d" plain label="log" onPress={() => update($, logOpen, () => true)} />
        </Box>
      </Box>
    )
  }

  const diagram = await ensureRendered($, saved)
  if (diagram !== saved) log($, `"${saved.title}" was missing from the cache; drew it again`)
  const select = (to: (n: number) => number) => () => open($, to(index))
  const v = await read($, view)
  const space = { columns: e.props.bodyColumns - 2, rows: e.props.scroll.bodyRows - CHROME_ROWS }
  const base = fit(diagram, space, Math.round(diagram.width / (SCALE * 4)))
  const at = layout(base, space, v)
  const room = { columns: Math.min(space.columns, at.columns), rows: Math.min(space.rows, at.rows) }
  shown = { file: diagram.file, base, room, at }

  if (source.file !== diagram.file) {
    // Bytes rather than a path: iTerm2 and tmux draw a file source as its alt.
    const { base64 } = await $.fs.read(diagram.file, { as: 'bytes' })
    source = { file: diagram.file, base64 }
    log($, `read ${diagram.file.split('/').pop()} (${Math.round((base64.length * 3) / 4 / 1024)} KiB)`)
  }
  const imageKey = `diagram-${await read($, redraws)}-${viewSwitches}`
  frame(
    $,
    `view=${inView} ${e.props.placement} body=${space.columns}x${space.rows} ` +
      `fit=${base.columns}x${base.rows} "${diagram.title}" key=${imageKey}`,
  )
  const image = (
    <Image
      key={imageKey}
      source={{ png: source.base64 }}
      columns={at.columns}
      rows={at.rows}
      alt={diagram.title}
    />
  )
  const tabs = tabWindow(
    list.map(d => d.title),
    index,
    space.columns,
  )

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        {tabs.start > 0 && <Text dimColor>‹ {tabs.start}</Text>}
        {list.slice(tabs.start, tabs.end).map((d, i) => {
          const at = tabs.start + i
          return (
            <Button key={`tab-${at}`} plain onPress={select(() => at)}>
              <Text inverse={at === index} bold={at === index} dimColor={at !== index}>
                {` ${tabLabel(d.title)} `}
              </Text>
            </Button>
          )
        })}
        {tabs.end < list.length && <Text dimColor>{list.length - tabs.end} ›</Text>}
      </Box>
      {v.zoom > 1 ? (
        <Box marginTop={1} width={room.columns} height={room.rows} overflow="hidden">
          <Box position="absolute" top={-at.top} left={-at.left}>
            {image}
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>{image}</Box>
      )}
      <Box gap={1} marginTop={1}>
        <Button key="prev" hotkey="p" plain label="prev" onPress={select(n => n - 1)} />
        <Button key="next" hotkey="n" plain label="next" onPress={select(n => n + 1)} />
        <Button key="in" hotkey="i" plain label="in" onPress={() => zoomBy($, diagram, 1, room.columns / 2, room.rows / 2)} />
        <Button key="out" hotkey="o" plain label="out" onPress={() => zoomBy($, diagram, -1, room.columns / 2, room.rows / 2)} />
        <Button key="reset" hotkey="0" plain label="reset" onPress={() => update($, view, () => HOME)} />
        <Button key="redraw" hotkey="r" plain label="redraw" onPress={() => redraw($)} />
        <Button key="log" hotkey="d" plain label="log" onPress={() => update($, logOpen, () => true)} />
        <Link href={`file://${diagram.file}`} label="open full size" />
      </Box>
      <Box gap={1}>
        {PAN_KEYS.map(([key, label, dx, dy]) => (
          <Button key={`pan-${key}`} hotkey={key} plain label={label} onPress={() => panBy($, diagram, dx, dy)} />
        ))}
        <Text dimColor>
          scroll to zoom{v.zoom > 1 ? ` · ${v.zoom.toFixed(1)}x` : ''}
        </Text>
      </Box>
    </Box>
  )
}
