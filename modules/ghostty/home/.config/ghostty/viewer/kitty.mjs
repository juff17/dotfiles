// Kitty graphics protocol commands. `q=2` keeps the terminal from answering,
// so replies never mix into the keyboard input.
//
// The picture is drawn with Unicode placeholders: text cells the terminal
// swaps for slices of the image. Inside tmux they're ordinary text, so tmux
// keeps them in the right pane, where a picture placed directly would land
// wherever the terminal's cursor happened to be.

// tmux only passes graphics commands on to the terminal when they're wrapped,
// with every escape doubled.
const wrap = s => (process.env.TMUX ? `\x1bPtmux;${s.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : s)

const command = (keys, payload = '') => wrap(`\x1b_G${keys},q=2${payload ? `;${payload}` : ''}\x1b\\`)

// The terminal reads the PNG from disk itself, so no pixels cross the pty.
export const transmitFile = (id, path) => command(`a=t,t=f,f=100,i=${id}`, Buffer.from(path).toString('base64'))

// The diacritics that number placeholder rows and columns, from the kitty
// spec, as code point ranges.
const RANGES = [
  [0x305], [0x30d, 0x30e], [0x310], [0x312], [0x33d, 0x33f], [0x346], [0x34a, 0x34c], [0x350, 0x352],
  [0x357], [0x35b], [0x363, 0x36f], [0x483, 0x487], [0x592, 0x595], [0x597, 0x599], [0x59c, 0x5a1],
  [0x5a8, 0x5a9], [0x5ab, 0x5ac], [0x5af], [0x5c4], [0x610, 0x617], [0x657, 0x65b], [0x65d, 0x65e],
  [0x6d6, 0x6dc], [0x6df, 0x6e2], [0x6e4], [0x6e7, 0x6e8], [0x6eb, 0x6ec], [0x730], [0x732, 0x733],
  [0x735, 0x736], [0x73a], [0x73d], [0x73f, 0x741], [0x743], [0x745], [0x747], [0x749, 0x74a],
  [0x7eb, 0x7f1], [0x7f3], [0x816, 0x819], [0x81b, 0x823], [0x825, 0x827], [0x829, 0x82d], [0x951],
  [0x953, 0x954], [0xf82, 0xf83], [0xf86, 0xf87], [0x135d, 0x135f], [0x17dd], [0x193a], [0x1a17],
  [0x1a75, 0x1a7c], [0x1b6b], [0x1b6d, 0x1b73], [0x1cd0, 0x1cd2], [0x1cda, 0x1cdb], [0x1ce0],
  [0x1dc0, 0x1dc1], [0x1dc3, 0x1dc9], [0x1dcb, 0x1dcc], [0x1dd1, 0x1de6], [0x1dfe], [0x20d0, 0x20d1],
  [0x20d4, 0x20d7], [0x20db, 0x20dc], [0x20e1], [0x20e7], [0x20e9], [0x20f0], [0x2cef, 0x2cf1],
  [0x2de0, 0x2dff], [0xa66f], [0xa67c, 0xa67d], [0xa6f0, 0xa6f1], [0xa8e0, 0xa8f1], [0xaab0],
  [0xaab2, 0xaab3], [0xaab7, 0xaab8], [0xaabe, 0xaabf], [0xaac1], [0xfe20, 0xfe26], [0x10a0f],
  [0x10a38], [0x1d185, 0x1d189], [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244],
]
export const DIACRITICS = RANGES.flatMap(([from, to = from]) =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)),
)

// Scales the whole image into a grid of cols × rows placeholder cells, as
// placement `pid` of image `id`.
export const placeGrid = (id, pid, cols, rows) => command(`a=p,U=1,i=${id},p=${pid},c=${cols},r=${rows}`)

// The placeholder cells for one row of placement `pid`'s grid, `count` of them
// from (gridRow, gridCol) on. The foreground color names the image and the
// underline color the placement, so both ids stay under 256.
export function gridRow(id, pid, gridRow, gridCol, count) {
  const row = DIACRITICS[gridRow]
  let s = `\x1b[38;5;${id};58;5;${pid}m`
  for (let c = 0; c < count; c++) s += `\u{10EEEE}${row}${DIACRITICS[gridCol + c]}`
  return `${s}\x1b[39;59m`
}

export const deleteImage = id => command(`a=d,d=I,i=${id}`)
