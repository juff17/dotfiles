import type { EngineInterface } from 'claude-code'

type Rgb = [number, number, number]

const hex = (color: string): Rgb => {
  const n = parseInt(color.replace('#', '').slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (rgb: Rgb) =>
  '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')

const mix = (from: string, to: string, amount: number) => {
  const a = hex(from)
  const b = hex(to)
  return toHex([0, 1, 2].map(i => a[i] + (b[i] - a[i]) * amount) as Rgb)
}

const isDark = (color: string) => {
  const [r, g, b] = hex(color)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

const parseConfig = (text: string, into: Map<string, string>) => {
  for (const line of text.split('\n')) {
    const match = line.match(/^([\w-]+) = (.*)$/)
    if (!match) continue
    const [, key, value] = match
    const slot = key === 'palette' ? value.match(/^(\d+)=(#[0-9a-fA-F]{6})/) : null
    if (slot) into.set(`palette.${slot[1]}`, slot[2])
    else if (key !== 'palette') into.set(key, value)
  }
}

// `+show-config` prints only what the theme and the user's file set, so it is
// layered over the defaults.
export async function ghosttyColors($: EngineInterface) {
  const config = new Map<string, string>()
  for (const argv of [
    ['ghostty', '+show-config', '--default'],
    ['ghostty', '+show-config'],
  ]) {
    const ran = await $.process.run(argv).catch(() => undefined)
    if (ran?.exitCode === 0) parseConfig(ran.stdout, config)
  }
  const bg = config.get('background') || '#282c34'
  const fg = config.get('foreground') || '#ffffff'
  const color = (n: number) => config.get(`palette.${n}`) || fg
  const font = config.get('font-family') || 'JetBrains Mono'

  return { bg, fg, blue: color(4), yellow: color(3), magenta: color(5), font }
}

export const mermaidConfig = (c: Awaited<ReturnType<typeof ghosttyColors>>) => {
  const node = mix(c.bg, c.fg, 0.1)
  const line = mix(c.bg, c.fg, 0.6)

  return {
    theme: 'base',
    themeVariables: {
      darkMode: isDark(c.bg),
      background: c.bg,
      fontFamily: `"${c.font}", monospace`,
      textColor: c.fg,
      primaryColor: node,
      primaryTextColor: c.fg,
      primaryBorderColor: c.blue,
      secondaryColor: mix(c.bg, c.magenta, 0.25),
      tertiaryColor: mix(c.bg, c.fg, 0.05),
      lineColor: line,
      edgeLabelBackground: c.bg,
      clusterBkg: mix(c.bg, c.fg, 0.04),
      clusterBorder: c.magenta,
      noteBkgColor: mix(c.bg, c.yellow, 0.2),
      noteTextColor: c.fg,
      noteBorderColor: c.yellow,
      actorBkg: node,
      actorBorder: c.blue,
      actorTextColor: c.fg,
      signalColor: line,
      signalTextColor: c.fg,
    },
  }
}
