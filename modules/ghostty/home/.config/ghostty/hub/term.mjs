// Terminal drawing shared by the hub and the rail: Catppuccin Mocha colors,
// lines built from styled spans and clipped to a width in cells, and the
// input parser. Text from transcripts (prompts, PR comments, log lines) is
// written by other people, so clean() strips control characters before it
// can reach the terminal as escape sequences.

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
export const fg = hex => `\x1b[38;2;${rgb(hex)}m`
export const bg = hex => `\x1b[48;2;${rgb(hex)}m`

export const P = {
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
  surface0: '#313244',
  surface1: '#45475a',
  overlay0: '#6c7086',
  overlay1: '#7f849c',
  sub: '#a6adc8',
  text: '#cdd6f4',
  blue: '#89b4fa',
  green: '#a6e3a1',
  peach: '#fab387',
  red: '#f38ba8',
  yellow: '#f9e2af',
  mauve: '#cba6f7',
  teal: '#94e2d5',
}

// The glyph and color of each state, the same on the board, the rail and the
// tmux tabs, so a state reads the same everywhere and without color too.
export const STATE = {
  needs: { glyph: '▲', color: P.peach, name: 'Needs you' },
  working: { glyph: '✻', color: P.blue, name: 'Working' },
  done: { glyph: '✓', color: P.green, name: 'Done' },
  idle: { glyph: '○', color: P.sub, name: 'Idle' },
}
export const MONITOR = {
  action: { glyph: '▲', color: P.peach, name: 'needs action' },
  watching: { glyph: '◉', color: P.teal, name: 'watching' },
  stale: { glyph: '◌', color: P.sub, name: 'stale' },
  ended: { glyph: '✓', color: P.sub, name: 'ended' },
}

// t of a over b, for the tinted header bars.
export const mix = (a, b, t) =>
  `#${[1, 3, 5]
    .map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)))
    .map(n => n.toString(16).padStart(2, '0'))
    .join('')}`

// Rounded caps (Powerline glyphs, which Ghostty draws itself, no Nerd Font
// needed): the ends of a pill or a bar.
export const CAP_L = '\ue0b6'
export const CAP_R = '\ue0b4'

export const BOLD = '\x1b[1m'
export const ITALIC = '\x1b[3m'
export const RESET = '\x1b[0m'

export const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')

const WIDE =
  /\p{Emoji_Presentation}|[ᄀ-ᅟ⺀-〾ぁ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u
// biome-ignore lint/suspicious/noMisleadingCharacterClass: each zero-width code point is matched on its own, not as a pair
const ZERO = /[\p{Mn}\p{Me}\u200B-\u200F\uFE0F]/u

export const charWidth = ch => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
export const width = s => {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

// A span is [text, style]; a line is a list of spans. render() writes one
// line of exactly `cols` cells: spans past the edge are cut, the last visible
// character becoming …, and the rest is filled with `fill` (a style).
export function render(spans, cols, fill = '') {
  if (cols <= 0) return ''
  const cut = spans.reduce((n, [t]) => n + width(t), 0) > cols
  const limit = cut ? cols - 1 : cols
  let out = fill
  let used = 0
  let full = false
  for (const [text, style = ''] of spans) {
    let piece = ''
    for (const ch of text) {
      const w = charWidth(ch)
      if (used + w > limit) {
        full = true
        break
      }
      piece += ch
      used += w
    }
    if (piece) out += `${style}${piece}${RESET}${fill}`
    if (full) break
  }
  if (cut) {
    out += `${fill}…`
    used++
  }
  return `${out}${' '.repeat(Math.max(0, cols - used))}${RESET}`
}

// A bar `w` cells wide with rounded ends, tinted `tint`, on `outer` (both
// hex): the lanes' and the tray's headers. The cells are one size, so a
// header stands out by its background rather than bigger text.
export function bar(left, right, w, tint, outer) {
  const edge = fg(tint) + bg(outer)
  return render([[CAP_L, edge]], 1) + split(left, right, w - 2, bg(tint)) + render([[CAP_R, edge]], 1)
}

// A pill: text on `color` with rounded ends, on `outer`.
export const pill = (text, color, outer, style = '') => [
  [CAP_L, fg(color) + bg(outer)],
  [text, style + bg(color)],
  [CAP_R, fg(color) + bg(outer)],
]

// Left and right parts on one line, the left cut first when they don't fit.
export function split(left, right, cols, fill = '') {
  const rw = right.reduce((n, [t]) => n + width(t), 0)
  if (rw >= cols) return render(right, cols, fill)
  return render(left, cols - rw, fill) + render(right, rw, fill)
}

export const ago = (ms, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (!ms) return ''
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

// Keys, pasted text and SGR mouse reports, one token at a time.
const INPUT = /\x1b\[200~([\s\S]*?)\x1b\[201~|\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[^a-zA-Z~]*[a-zA-Z~]|\x1bO[a-zA-Z]|\x1b[\s\S]?|[\s\S]/g
export function* tokens(data) {
  for (const m of data.matchAll(INPUT)) {
    if (m[1] !== undefined) yield { paste: m[1] }
    else if (m[2] !== undefined)
      yield { mouse: { button: Number(m[2]), x: Number(m[3]), y: Number(m[4]), up: m[5] === 'm' } }
    else yield { key: m[0] }
  }
}

export const out = s => process.stdout.write(s)

// Alternate screen, hidden cursor, button reports in SGR form and bracketed
// paste; leave() puts the terminal back.
export function enter() {
  out('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h')
}
export function leave() {
  out('\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
}

// Draws whole lines in one synchronized frame, so a redraw never flickers.
export function paint(lines) {
  let frame = '\x1b[?2026h'
  lines.forEach((line, i) => {
    frame += `\x1b[${i + 1};1H${line}`
  })
  out(`${frame}\x1b[?2026l`)
}
