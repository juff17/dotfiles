import type { EngineInterface, Register } from 'claude-code'

import { describe, log } from './log'
import { renderMermaid } from './mermaid'
import { addDiagram, drawPane, endSession, restore, scrollPane } from './pane'

const PANE = 'diagram'
const TITLE = 'Diagram'
const TOOL = 'mcp__diagram-pane__show'
// 'ghostty' leaves diagrams to the Ghostty layout's viewer (dv, in the dotfiles repo),
// which reads state.json, and never opens the pane on its own; 'claude' opens
// the pane beside the chat.
const VIEWER = 'ghostty' as 'claude' | 'ghostty'

async function openPane($: EngineInterface, focus = false) {
  const opened = await $.ui.open(focus ? { id: PANE, title: TITLE, focus } : { id: PANE, title: TITLE })
  if (!opened.isPlaced) log($, `pane not placed: ${opened.reason}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'diagram-pane', description: 'Show the diagram pane' })
    await $.tool.register({
      name: 'show',
      description:
        'Render a Mermaid diagram as an image in the diagram pane beside the chat. ' +
        'Returns the parse error when the source is invalid.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title shown above the diagram' },
          mermaid: { type: 'string', description: 'Mermaid source, no code fence' },
        },
        required: ['title', 'mermaid'],
      },
      isDeferred: false,
    })
    const restored = await restore($)
    log($, `session.start surface=${e.surface} restored=${restored}`)
    if (VIEWER === 'claude' && restored > 0 && e.surface === 'terminal') void openPane($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await endSession($, e.reason)
    } catch (error) {
      log($, `session.end failed: ${describe(error)}`)
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    log($, `session.attach surface=${e.surface} client=${e.clientId}`)
    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    log($, `session.detach surface=${e.surface} client=${e.clientId} reason=${e.reason}`)
    return next(e)
  })

  on('command.run', { command: 'diagram-pane' }, async $ => {
    await openPane($, true)

    return { text: 'Diagram pane opened.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { title, mermaid } = e as unknown as { title: string; mermaid: string }
    const started = Date.now()
    const diagram = await renderMermaid($, title, mermaid)
    if ('error' in diagram) {
      log($, `show "${title}" failed: ${diagram.error.split('\n')[0]}`)
      return { deny: `Mermaid failed to render:\n${diagram.error}` }
    }
    log($, `show "${title}" rendered ${diagram.width}x${diagram.height} in ${Date.now() - started}ms`)

    const count = await addDiagram($, diagram)
    if (VIEWER === 'claude') await openPane($)
    const where = VIEWER === 'claude' ? 'the diagram pane' : 'the Ghostty viewer'

    return { result: `Shown in ${where} as "${title}" (${count} of ${count}).` }
  }).catch(($, _, next) => {
    log($, `show failed (${next.error.kind}): ${next.error.message ?? 'no message'}`)
    return { deny: 'diagram-pane: rendering failed; press `d` in the diagram pane to see its log.' }
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => scrollPane($, e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      log($, `render skipped on surface=${e.surface}`)
      return next(e)
    }
    try {
      return await drawPane($, e)
    } catch (error) {
      log($, `render threw: ${describe(error)}`)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box paddingX={1}>
          <Text color="error">diagram-pane: {String(error)}</Text>
        </Box>
      )
    }
  })
}
