import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'diagram-pane',
  component: 'Pane',
  requestId: 'diagram',
  props: {
    title: 'Diagram',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const crc32 = (bytes: Uint8Array) => {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

// The signature plus a whole IHDR chunk, which is all the engine checks.
const pngHeader = (width: number, height: number) => {
  const bytes = new Uint8Array(33)
  const view = new DataView(bytes.buffer)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  view.setUint32(29, crc32(bytes.subarray(12, 29)))
  return bytes.toBase64()
}

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Every render succeeds as a 720x860 PNG unless `exitCode` says otherwise;
// answers the argv of each process run, the path of each file read, the text
// of each file written, how many times a pane was opened, and a way to change
// the session id (as a /clear does). `files` holds text files to read, and
// `tmux` runs the session in pane %5 of the ghostty socket.
const fakeRenders = (
  on: On,
  {
    store = {},
    exitCode = (_: string[]) => 0,
    cached = true,
    tmux = false,
    files = {},
  }: {
    store?: Record<string, unknown>
    exitCode?: (argv: string[]) => number
    cached?: boolean
    tmux?: boolean
    files?: Record<string, string>
  } = {},
) => {
  const ran: string[][] = []
  const reads: string[] = []
  const written: Record<string, string> = {}
  let opens = 0
  let session = 'sess-1'
  mock.store(on, store)
  mock.env(on, {
    HOME: '/home/test',
    ...(tmux ? { TMUX: '/tmp/tmux-1000/ghostty,123,0', TMUX_PANE: '%5' } : {}),
  })
  on('session.id', () => ({ value: session }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const result = ok(e.argv[1] === '+show-config' ? 'background = #282c34\nforeground = #ffffff\n' : '')
    const code = exitCode([...e.argv])
    if (code === 0) return result
    const stderr = 'Error: Parse error on line 2:\nExpecting NODE\n    at foo (bar.js:1:1)'
    return { value: { ...result.value, exitCode: code, stderr } }
  })
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    if (e.path in files) return { value: files[e.path]! }
    return { value: { base64: pngHeader(720, 860) } }
  })
  on('fs.stat', () => {
    if (!cached) return { deny: 'ENOENT: no such file' }
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('ui.open', () => {
    opens++
    return { value: { isPlaced: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: session }))
  return {
    ran,
    reads,
    written,
    opens: () => opens,
    setSession: (id: string) => {
      session = id
    },
  }
}

const show = ($: Engine, title: string) =>
  $.tool.call({ tool: 'mcp__diagram-pane__show', title, mermaid: 'flowchart TD\n A-->B' })

test('the pane starts empty', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Ask for a diagram/ })).toBeDefined()
  await ui.unmount()
})

test('a rendered diagram shows as an image sized to its aspect ratio', async ($, on) => {
  const { ran } = fakeRenders(on)

  const call = await show($, 'Loop')
  expect(call.deny).toBeUndefined()
  const mmdc = ran.find(argv => argv[0]?.endsWith('/node_modules/.bin/mmdc'))
  expect(mmdc?.[mmdc.indexOf('-o') + 1]).toStartWith('/home/test/.cache/claude-diagram-pane/')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  // Too tall for the 25 free rows at full width, so it shrinks to fit.
  expect(image?.props.columns).toBe(41)
  expect(image?.props.rows).toBe(24)
  expect(image?.props.source).toEqual({ png: pngHeader(720, 860) })
  expect(await ui.find({ type: 'Text', text: / Loop / })).toBeDefined()
  await ui.unmount()
})

test('a parse error goes back to the model', async ($, on) => {
  fakeRenders(on, { exitCode: argv => (argv[0]?.endsWith('mmdc') ? 1 : 0) })

  const call = await show($, 'Bad')
  expect(call.deny).toContain('Parse error on line 2')
  expect(call.deny).not.toContain('at foo')
})

test('zooming grows the image inside a fixed viewport without new bytes', async ($, on) => {
  const { reads } = fakeRenders(on)

  await show($, 'Loop')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = reads.length
  expect((await ui.find({ type: 'Image' }))?.props.columns).toBe(41)

  await ui.press({ key: 'in' })
  await ui.press({ key: 'in' })
  expect((await ui.find({ type: 'Image' }))?.props.columns).toBe(51)
  expect(await ui.find({ type: 'Text', text: /1\.3x/ })).toBeDefined()
  expect(reads.length).toBe(before)

  await ui.press({ key: 'reset' })
  expect((await ui.find({ type: 'Image' }))?.props.columns).toBe(41)
  await ui.unmount()
})

test('each diagram gets a tab that selects it', async ($, on) => {
  fakeRenders(on)

  for (const title of ['First', 'Second', 'Third']) await show($, title)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const key of ['tab-0', 'tab-1', 'tab-2']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tab-3' })).toBeUndefined()
  expect((await ui.find({ type: 'Image' }))?.props.alt).toBe('Third')

  await ui.press({ key: 'tab-0' })
  expect((await ui.find({ type: 'Image' }))?.props.alt).toBe('First')
  await ui.unmount()
})

const saved = (id: string, opened: number) => ({
  id,
  title: `Saved ${id}`,
  mermaid: 'flowchart TD\n A-->B',
  file: `/home/test/.cache/claude-diagram-pane/${id}.png`,
  width: 720,
  height: 860,
  opened,
})

const sessions = (tabs: Record<string, ReturnType<typeof saved>[]>, current = 0) => ({
  sessions: Object.fromEntries(Object.entries(tabs).map(([id, diagrams]) => [id, { diagrams, current, used: 1 }])),
})

test('a resumed session gets its own tabs back with the same one open', async ($, on) => {
  fakeRenders(on, { store: sessions({ 'sess-1': [saved('a', 1), saved('b', 2)], other: [saved('c', 3)] }) })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'tab-1' })).toBeDefined()
  expect((await ui.find({ type: 'Image' }))?.props.alt).toBe('Saved a')
  await ui.unmount()
})

test('a PNG gone from the cache is drawn again from its source', async ($, on) => {
  const { ran } = fakeRenders(on, { store: sessions({ 'sess-1': [saved('a', 1)] }), cached: false })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const mmdc = ran.find(argv => argv[0]?.endsWith('/node_modules/.bin/mmdc'))
  expect(mmdc?.[mmdc.indexOf('-o') + 1]).toBe('/home/test/.cache/claude-diagram-pane/a.png')
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('past 50 diagrams the least recently opened is deleted', async ($, on) => {
  const full = Array.from({ length: 50 }, (_, i) => saved(`d${i}`, i === 7 ? 0 : 100 + i))
  const { ran } = fakeRenders(on, { store: sessions({ 'sess-1': full }) })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await show($, 'New')
  expect(ran).toContainEqual(['rm', '-f', '/home/test/.cache/claude-diagram-pane/d7.png'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / New / })).toBeDefined()
  await ui.unmount()
})

test('switching the transcript in view sends the picture again', async ($, on) => {
  fakeRenders(on)

  await show($, 'Loop')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = (await ui.find({ type: 'Image' }))?.key
  await ui.redraw({ ...PANE.props, view: { agentId: 'a1' } })
  await ui.redraw({ ...PANE.props, view: {} })
  const back = (await ui.find({ type: 'Image' }))?.key
  expect(back).not.toBe(first)

  await ui.press({ key: 'redraw' })
  expect((await ui.find({ type: 'Image' }))?.key).not.toBe(back)
  await ui.unmount()
})

test('the log view lists what happened', async ($, on) => {
  fakeRenders(on)

  await show($, 'Loop')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'log' })
  expect(await ui.find({ type: 'Text', text: /show "Loop" rendered 720x860/ })).toBeDefined()
  await ui.press({ key: 'log' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('with the Ghostty viewer a diagram does not open the pane', async ($, on) => {
  const { opens } = fakeRenders(on)

  const call = await show($, 'Loop')
  expect(call.result).toContain('the Ghostty viewer')
  expect(opens()).toBe(0)
})

test('a new session starts with no tabs, whatever other sessions saved', async ($, on) => {
  fakeRenders(on, { store: { ...sessions({ other: [saved('c', 3)] }), diagrams: [saved('old', 1)], current: 0 } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Ask for a diagram/ })).toBeDefined()
  await ui.unmount()
})

const PANE_FILE = '/home/test/.cache/claude-diagram-pane/panes/ghostty-5.json'

test('in tmux the tabs go to a file for the pane, named for its session', async ($, on) => {
  const { written } = fakeRenders(on, { tmux: true })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(written[PANE_FILE]!)).toEqual({ session: 'sess-1', diagrams: [], current: 0 })
  await show($, 'Loop')
  const state = JSON.parse(written[PANE_FILE]!)
  expect(state.session).toBe('sess-1')
  expect(state.diagrams.map((d: { title: string }) => d.title)).toEqual(['Loop'])
})

test('a tab the viewer closed stays closed', async ($, on) => {
  const files: Record<string, string> = {}
  const { written } = fakeRenders(on, { tmux: true, files })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await show($, 'First')
  await show($, 'Second')
  const state = JSON.parse(written[PANE_FILE]!)
  files[PANE_FILE] = JSON.stringify({ ...state, diagrams: state.diagrams.slice(1), current: 0 })
  await show($, 'Third')
  const titles = JSON.parse(written[PANE_FILE]!).diagrams.map((d: { title: string }) => d.title)
  expect(titles).toEqual(['Second', 'Third'])
})

test('after a /clear the tabs start over, and the old session keeps its own', async ($, on) => {
  const { written, setSession } = fakeRenders(on, { tmux: true })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await show($, 'Before')
  await $.session.end({ reason: 'clear' } as never)
  expect(JSON.parse(written[PANE_FILE]!).diagrams).toEqual([])
  setSession('sess-2')
  await show($, 'After')
  const titles = () => JSON.parse(written[PANE_FILE]!).diagrams.map((d: { title: string }) => d.title)
  expect(titles()).toEqual(['After'])

  setSession('sess-1')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(titles()).toEqual(['Before'])
})

test('when the session exits its pane file goes', async ($, on) => {
  const { ran } = fakeRenders(on, { tmux: true })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.end({ reason: 'prompt_input_exit' } as never)
  expect(ran).toContainEqual(['rm', '-f', PANE_FILE])
})
