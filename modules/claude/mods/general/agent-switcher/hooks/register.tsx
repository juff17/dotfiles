import type { AgentInfo, AgentStatus, Color, Register } from 'claude-code'

const PANE = 'agents'
const TITLE = 'Agents'

const STATUS: Record<AgentStatus, { icon: string; label: string; color: Color }> = {
  pending: { icon: '◌', label: 'starting', color: 'subtle' },
  running: { icon: '◐', label: 'running', color: 'suggestion' },
  waiting: { icon: '◆', label: 'waiting', color: 'warning' },
  idle: { icon: '○', label: 'idle', color: 'subtle' },
  completed: { icon: '✓', label: 'done', color: 'success' },
  failed: { icon: '✕', label: 'failed', color: 'error' },
  killed: { icon: '■', label: 'stopped', color: 'inactive' },
}

const isLive = (agent: AgentInfo) =>
  agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting' || agent.status === 'idle'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-pane', description: 'Show this session\'s subagents in a pane' })
    void $.ui.open({ id: PANE, title: TITLE })

    // The engine raises no event when an agent's status changes, so poll and
    // redraw only when the list differs.
    let seen = ''
    $.clock.every(2000, async () => {
      const list = await $.agent.list()
      const now = list.map(a => `${a.id}:${a.status}`).join(',')
      if (now !== seen) {
        seen = now
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  on('command.run', { command: 'agent-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Agents pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const viewing = e.props.view.agentId
    const agents = await $.agent.list()
    const live = agents.filter(isLive)
    const done = agents.filter(a => !isLive(a))
    const running = agents.filter(a => a.status === 'running').length

    const row = (agent: AgentInfo, index: number) => {
      const status = STATUS[agent.status]
      const isViewing = agent.id === viewing

      return (
        <Box key={`row:${agent.id}`} flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between" gap={1}>
            <Button
              key={`agent:${agent.id}`}
              plain
              hotkey={index < 9 ? String(index + 1) : undefined}
              onPress={() => $.ui.view({ agentId: agent.id })}
            >
              <Text color={isViewing ? 'claude' : status.color}>{isViewing ? '▍ ' : '● '}</Text>
              <Text bold dimColor={!isLive(agent) && !isViewing}>
                {agent.name ?? agent.description}
              </Text>
              <Text dimColor> {agent.type}</Text>
            </Button>
            <Text color={status.color} wrap="truncate">
              {status.icon} {status.label}
            </Text>
          </Box>
          {agent.name && (
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">{agent.description}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const section = (label: string, group: AgentInfo[], offset: number) =>
      group.length > 0 && (
        <Box flexDirection="column">
          <Box marginTop={1} gap={1}>
            <Text color="suggestion" bold>{label}</Text>
            <Text dimColor>{group.length}</Text>
          </Box>
          {group.map((agent, i) => row(agent, offset + i))}
        </Box>
      )

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between" gap={1}>
          <Box gap={1}>
            <Text color="claude">◆</Text>
            <Text bold>Subagents</Text>
            <Text dimColor>in this session</Text>
          </Box>
          {running > 0 && <Text color="suggestion">◐ {running} running</Text>}
        </Box>

        <Box marginTop={1}>
          <Button key="main" plain hotkey="0" onPress={() => $.ui.view({})}>
            <Text color={viewing ? 'subtle' : 'claude'}>{viewing ? '○ ' : '▍ '}</Text>
            <Text bold={!viewing} dimColor={!!viewing}>Main conversation</Text>
          </Button>
        </Box>

        {agents.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor>No subagents yet.</Text>
          </Box>
        )}
        {section('ACTIVE', live, 0)}
        {section('FINISHED', done, live.length)}

        {agents.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>click or press 1-9 to view · 0 for main</Text>
          </Box>
        )}
      </Box>
    )
  })
}
