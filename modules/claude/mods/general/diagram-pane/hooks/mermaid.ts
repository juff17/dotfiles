import type { EngineInterface } from 'claude-code'

import type { Diagram } from '../types'
import { ghosttyColors, mermaidConfig } from './theme'

const CHROME = '/usr/bin/google-chrome'
// Rendered larger than the pane needs so zooming in stays sharp.
export const SCALE = 4
// An Image takes at most 2 MiB of PNG. Raw pixel sources stop at 2048 a
// side, and a PNG is held to the same.
const MAX_BYTES = 2 * 1024 * 1024
const MAX_SIDE = 2048

// Width and height sit at bytes 16 to 23 of a PNG, inside its first 32
// base64 characters.
const pngSize = (base64: string) => {
  const bytes = Uint8Array.fromBase64(base64.slice(0, 32))
  const view = new DataView(bytes.buffer)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const decodedBytes = (base64: string) => (base64.length * 3) / 4

// A cache, not data: every PNG can be drawn again from its saved source.
export async function cacheDir($: EngineInterface) {
  const root = (await $.env.get('XDG_CACHE_HOME')) || `${await $.env.get('HOME')}/.cache`
  return `${root}/claude-diagram-pane`
}

export async function renderMermaid(
  $: EngineInterface,
  title: string,
  mermaid: string,
  id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
): Promise<Diagram | { error: string }> {
  const dir = await cacheDir($)
  const input = `${dir}/${id}.mmd`
  const output = `${dir}/${id}.png`
  const config = `${dir}/${id}.json`
  const puppeteer = `${dir}/puppeteer.json`

  await $.process.run(['mkdir', '-p', dir])
  await $.fs.write(input, mermaid)
  await $.fs.write(config, JSON.stringify(mermaidConfig(await ghosttyColors($))))
  await $.fs.write(puppeteer, JSON.stringify({ executablePath: CHROME }))

  const ran = await $.process.run(
    [
      `${$.plugin.root}/node_modules/.bin/mmdc`,
      ...['-q', '-i', input, '-o', output, '-c', config, '-p', puppeteer],
      ...['-b', 'transparent', '-s', String(SCALE)],
    ],
    { timeoutMs: 60_000 },
  )
  await $.process.run(['rm', '-f', input, config])
  if (ran.exitCode !== 0) {
    const error = ran.stderr.match(/Error:[\s\S]*?(?=\n\s+at |$)/)?.[0] ?? ran.stderr
    return { error: error.trim().slice(0, 1500) }
  }

  let { base64 } = await $.fs.read(output, { as: 'bytes' })
  const { width, height } = pngSize(base64)
  if (Math.max(width, height) > MAX_SIDE) {
    await $.process.run(['magick', output, '-resize', `${MAX_SIDE}x${MAX_SIDE}>`, output])
    ;({ base64 } = await $.fs.read(output, { as: 'bytes' }))
  }
  for (let tries = 0; decodedBytes(base64) > MAX_BYTES && tries < 4; tries++) {
    await $.process.run(['magick', output, '-resize', '70%', output])
    ;({ base64 } = await $.fs.read(output, { as: 'bytes' }))
  }

  return { id, title, mermaid, file: output, ...pngSize(base64), opened: Date.now() }
}

// Draws the diagram again when its PNG is gone from the cache.
export async function ensureRendered($: EngineInterface, diagram: Diagram) {
  const found = await $.fs.stat(diagram.file).catch(() => undefined)
  if (found?.kind === 'file') return diagram
  const redrawn = await renderMermaid($, diagram.title, diagram.mermaid, diagram.id)
  if ('error' in redrawn) throw new Error(redrawn.error)
  return { ...redrawn, opened: diagram.opened }
}

export async function removeRender($: EngineInterface, diagram: Diagram) {
  await $.process.run(['rm', '-f', diagram.file])
}
