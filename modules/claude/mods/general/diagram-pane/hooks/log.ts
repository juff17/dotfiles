import type { EngineInterface } from 'claude-code'

import { cacheDir } from './mermaid'

const MAX_LINES = 300

// Module memory, so a reload starts it over; the file keeps the last run's
// lines until the next one writes.
const lines: string[] = []

export const logLines = (): readonly string[] => lines

// Each line goes to the pane's log view, `debug.log` in the cache folder,
// and the `claude --debug` log.
export function log($: EngineInterface, text: string) {
  lines.push(`${new Date().toISOString().slice(11, 23)} ${text}`)
  if (lines.length > MAX_LINES) lines.shift()
  $.ui.log(text, { to: 'debug' })
  void cacheDir($)
    .then(dir => $.fs.write(`${dir}/debug.log`, `${lines.join('\n')}\n`))
    .catch(() => {})
}

export const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
