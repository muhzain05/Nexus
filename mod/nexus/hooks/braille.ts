// Unicode Braille as a 2 x 4 dot grid per terminal cell. Pure.
//
// A Braille cell (U+2800 to U+28FF) holds eight dots. Its code point is U+2800 plus a bit mask, and the
// bits are NOT numbered in reading order: dots 1-3 run down the left column (bits 0x01 0x02 0x04), dots
// 4-6 down the right column (0x08 0x10 0x20), and the two bottom dots, 7 and 8, were added later and sit
// at the bottom of the left and right column (0x40 0x80). So a dot's bit is looked up by (row, column),
// never computed from its index.
//
// An empty cell is a plain space, never U+2800: the blank Braille pattern is a different glyph, drawn in a
// different font by many terminals, and it would make dark areas "not quite empty".

/** The bit of the dot at `[row][column]` inside a cell: 4 rows of 2 columns. */
export const BRAILLE_BIT: readonly (readonly [number, number])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

/** Dots across and down inside one cell. */
export const CELL_DOTS = { cols: 2, rows: 4 } as const

/** The character for a cell with this dot mask (0 is a space, 255 is the full block of dots `⣿`). */
export function brailleChar(mask: number): string {
  return mask > 0 ? String.fromCharCode(0x2800 + (mask & 0xff)) : ' '
}

/** The dot mask of a Braille character, or 0 for anything else (a space included). */
export function brailleMask(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  return c > 0x2800 && c <= 0x28ff ? c - 0x2800 : 0
}

/** How many dots a mask lights. */
export function dotCount(mask: number): number {
  let n = 0
  for (let m = mask & 0xff; m; m &= m - 1) n++
  return n
}

/**
 * The mask of the cell whose top-left dot is (`x`, `y`) in a dot grid `w` wide, `lit` telling which dots
 * are on. Dots outside the grid are off.
 */
export function cellMask(lit: (x: number, y: number) => boolean, x: number, y: number): number {
  let mask = 0
  for (let j = 0; j < CELL_DOTS.rows; j++) for (let i = 0; i < CELL_DOTS.cols; i++) if (lit(x + i, y + j)) mask |= BRAILLE_BIT[j]![i]!
  return mask
}
