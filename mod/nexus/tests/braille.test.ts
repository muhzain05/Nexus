import { expect, test } from 'claude-code/testing'

import { BRAILLE_BIT, CELL_DOTS, brailleChar, brailleMask, cellMask, dotCount } from '../hooks/braille'
import { cells, width } from '../hooks/orbitlayout'

// Unicode lays the eight dots out as: 1 4 / 2 5 / 3 6 / 7 8 (bits 0x01 0x02 0x04 0x08 0x10 0x20 0x40 0x80).
// Dots 1-3 are the left column top to bottom, 4-6 the right column, and 7 and 8 sit under them, which is why
// the table is looked up by (row, column) and not computed.

test('the bit of every dot, by row and column, is the one Unicode gives it', () => {
  expect(CELL_DOTS).toEqual({ cols: 2, rows: 4 })
  expect(BRAILLE_BIT).toEqual([[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]])
  // Eight distinct single bits that together make the full mask.
  const all = BRAILLE_BIT.flat()
  expect(new Set(all).size).toBe(8)
  expect(all.reduce((m, b) => m | b, 0)).toBe(0xff)
  for (const b of all) expect(dotCount(b)).toBe(1)
})

test('a cell with one dot is the Braille character with that dot, for all eight positions', () => {
  // [row, column, the character a Braille table gives that single dot]
  const single: [number, number, string][] = [
    [0, 0, '⠁'], [1, 0, '⠂'], [2, 0, '⠄'], [0, 1, '⠈'], [1, 1, '⠐'], [2, 1, '⠠'], [3, 0, '⡀'], [3, 1, '⢀'],
  ]
  for (const [row, col, ch] of single) {
    expect(brailleChar(BRAILLE_BIT[row]![col]!)).toBe(ch)
    // ...and from a lit(x, y) function over a dot grid, at any offset in it.
    expect(brailleChar(cellMask((x, y) => x === 6 + col && y === 8 + row, 6, 8))).toBe(ch)
  }
})

test('empty, partial and full cells', () => {
  // An empty cell is a plain space, never the blank Braille pattern U+2800.
  expect(brailleChar(0)).toBe(' ')
  expect(brailleChar(0).codePointAt(0)).toBe(0x20)
  expect(brailleChar(0xff)).toBe('⣿')
  expect(brailleChar(0x07)).toBe('⠇') // the whole left column
  expect(brailleChar(0x38)).toBe('⠸') // the right column's top three
  expect(brailleChar(0x09)).toBe('⠉') // the top row, both dots
  expect(brailleChar(0xc0)).toBe('⣀') // the bottom row, both dots
  expect(brailleChar(0x1ff)).toBe('⣿') // only the low eight bits count
  expect(dotCount(0xff)).toBe(8)
  expect(dotCount(0)).toBe(0)
  expect(dotCount(0x4a)).toBe(3)
})

test('a character maps back to its mask, and anything else is no dots', () => {
  for (let m = 1; m <= 255; m++) {
    expect(brailleMask(brailleChar(m))).toBe(m)
    const cp = brailleChar(m).codePointAt(0)!
    expect(cp).toBe(0x2800 + m)
  }
  for (const ch of [' ', 'a', '▀', '·', '⠀', '']) expect(brailleMask(ch)).toBe(0)
})

test('a mask is read from a dot grid at the cell\'s top-left, and dots off the grid are off', () => {
  const grid = ['.#..', '.#..', '..#.', '..#.', '....', '....']
  const lit = (x: number, y: number) => grid[y]?.[x] === '#'
  // Cell (0,0) covers x 0..1: the lit dots are in its right column, rows 0 and 1 (bits 0x08, 0x10).
  expect(cellMask(lit, 0, 0)).toBe(0x08 | 0x10)
  // Cell (2,0) covers x 2..3: the lit dots are in its left column, rows 2 and 3 (bits 0x04, 0x40).
  expect(cellMask(lit, 2, 0)).toBe(0x04 | 0x40)
  expect(cellMask(lit, 4, 0)).toBe(0)
  expect(cellMask(lit, 0, 4)).toBe(0)
  expect(cellMask(() => true, 0, 0)).toBe(0xff)
  expect(cellMask(() => false, 0, 0)).toBe(0)
})

test('every Braille character is one terminal column wide, in the layout\'s own measure', () => {
  for (let m = 1; m <= 255; m++) expect(cells(brailleChar(m))).toBe(1)
  expect(cells('⣿⣿⣿')).toBe(3)
  expect(cells(' ⠁ ⡀ ')).toBe(5)
  expect(width([{ t: '⠃⠇⠿' }, { t: '   ' }, { t: '⣿' }])).toBe(7)
  // The plain characters the simple mode uses are one column too.
  expect(cells("'.:* ")).toBe(5)
})
