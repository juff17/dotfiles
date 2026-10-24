import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-switcher',
  component: 'Pane',
  requestId: 'agents',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('lists subagents by state and switches the view on press', async ($, on) => {
  const views: unknown[] = []
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'scan repo', type: 'Explore', status: 'running' },
      { id: 'a2', name: 'reviewer', description: 'review the diff', type: 'general-purpose', status: 'completed' },
    ],
  }))
  on('ui.view', (_, e) => {
    views.push(e)
    return { value: {} }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'ACTIVE' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'FINISHED' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'review the diff' })).toBeDefined()
    await ui.press({ key: 'agent:a1' })
    await ui.press({ key: 'main' })
    await ui.unmount()
  }

  expect(views.length).toBe(4)
})
