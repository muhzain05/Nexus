import { expect, test } from 'claude-code/testing'

import { BRAILLE_BIT, brailleMask } from '../hooks/braille'
import { CELL_ASPECT, CYCLE_MS, DIMENSIONS, FRAMES, PALETTE, bhText, blackHole, dotSteps, drawBlackHole, frames, horizonCircle, horizonPixels, litKinds, litPixels, sizeFor } from '../hooks/blackhole'
import type { BhSize, BhSprite } from '../hooks/blackhole'
import { cells } from '../hooks/orbitlayout'

const SIZES: BhSize[] = ['small', 'medium', 'large']

// Everything below reads the DRAWN sprite (its glyphs and colours), not the renderer's own dot arrays, except
// where a test says it is checking the geometry itself.

/** The lit dots of a drawn sprite, `[y][x]` on the (cols * 2) x (rows * 4) dot grid, from its Braille glyphs. */
function dotsOf(sprite: BhSprite): boolean[][] {
  const out: boolean[][] = sprite.flatMap(() => [0, 1, 2, 3].map(() => [] as boolean[]))
  sprite.forEach((runs, r) => {
    let x = 0
    for (const run of runs) {
      for (const ch of run.text) {
        const mask = brailleMask(ch)
        for (let j = 0; j < 4; j++) for (let i = 0; i < 2; i++) out[r * 4 + j]![x * 2 + i] = (mask & BRAILLE_BIT[j]![i]!) !== 0
        x++
      }
    }
  })
  return out
}
/** Each cell's palette step (1 to 6) or null for a cell with no colour, row-major. */
function steps(sprite: BhSprite): (number | null)[] {
  const out: (number | null)[] = []
  for (const runs of sprite) for (const run of runs) for (const _ of run.text) out.push(run.fg ? PALETTE.indexOf(run.fg as (typeof PALETTE)[number]) + 1 : null)
  return out
}
const litCount = (g: boolean[][]) => g.reduce((n, row) => n + row.filter(Boolean).length, 0)
/** How many of the eight neighbours of dot (x, y) are lit. */
const around = (g: boolean[][], x: number, y: number) => {
  let n = 0
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if ((i || j) && g[y + j]?.[x + i]) n++
  return n
}

test('every composition is exactly its size, drawn only with spaces and Braille dots (never the blank pattern)', () => {
  for (const size of SIZES) {
    const text = bhText(drawBlackHole(size, 0.3))
    expect(text.length).toBe(DIMENSIONS[size].rows)
    for (const row of text) {
      expect([...row].length).toBe(DIMENSIONS[size].cols)
      // The layout measures it the same way: one column per cell, so nothing is ragged.
      expect(cells(row)).toBe(DIMENSIONS[size].cols)
      expect(row).toMatch(/^[ ⠁-⣿]*$/)
    }
  }
  expect(DIMENSIONS.small.cols).toBeLessThan(DIMENSIONS.medium.cols)
  expect(DIMENSIONS.medium.cols).toBeLessThan(DIMENSIONS.large.cols)
})

test('which composition a panel gets: the largest that fits, none when nothing does', () => {
  expect(sizeFor(100, 20)).toBe('large')
  expect(sizeFor(64, 14)).toBe('large')
  expect(sizeFor(63, 14)).toBe('medium')
  expect(sizeFor(64, 13)).toBe('medium')
  expect(sizeFor(44, 10)).toBe('medium')
  expect(sizeFor(43, 10)).toBe('small')
  expect(sizeFor(30, 7)).toBe('small')
  expect(sizeFor(29, 7)).toBeNull()
  expect(sizeFor(80, 6)).toBeNull()
})

test('the dot grid is two dots a cell across and four down', () => {
  for (const size of SIZES) {
    const { cols, rows } = DIMENSIONS[size]
    const g = dotsOf(drawBlackHole(size, null))
    expect(g.length).toBe(rows * 4)
    expect(g[0]!.length).toBe(cols * 2)
    // The geometry's own count matches what the glyphs show.
    expect(litCount(g)).toBe(litPixels(size).length)
  }
})

test('the event horizon is dark in every frame, in colour, in simple characters and without colour', () => {
  for (const size of SIZES) {
    const dark = new Set(horizonPixels(size))
    expect(dark.size).toBeGreaterThan(100)
    for (const t of [null, 0, 0.15, 0.4, 0.62, 0.9]) {
      for (const sprite of [drawBlackHole(size, t), drawBlackHole(size, t, true)]) {
        dotsOf(sprite).forEach((row, y) => row.forEach((on, x) => { if (on) expect(dark.has(`${x},${y}`)).toBe(false) }))
      }
    }
    // Dark is no colour at all, not a dark colour.
    for (const run of drawBlackHole(size, 0.4).flat()) if (run.text.trim() === '') expect([run.fg, run.bg]).toEqual([undefined, undefined])
  }
})

test('the middle of the horizon is dark, checked without the renderer\'s own geometry', () => {
  // A fixed block of dots in the upper middle of the horizon, clear of the ring and of the disk, in every frame.
  const blocks: Record<BhSize, [number, number, number, number]> = { small: [26, 11, 33, 14], medium: [38, 15, 49, 20], large: [56, 22, 71, 29] }
  for (const size of SIZES) {
    const [x0, y0, x1, y1] = blocks[size]
    let lit = 0
    for (const t of [null, 0, 0.2, 0.4, 0.6, 0.8]) {
      const g = dotsOf(drawBlackHole(size, t))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (g[y]![x]) lit++
    }
    expect(lit).toBe(0)
  }
})

test('the horizon is a circle: equal height and width in physical units, at the real cell aspect and at others', () => {
  for (const size of SIZES) {
    for (const aspect of [0.45, CELL_ASPECT, 0.56]) {
      const dots = horizonPixels(size, aspect).map(k => k.split(',').map(Number) as [number, number])
      const ys = dots.map(d => d[1])
      const height = Math.max(...ys) - Math.min(...ys) + 1
      // The widest row of the horizon, counted in dots, times a dot's width (2 * aspect, with a dot's height 1).
      const perRow = new Map<number, number>()
      for (const [, y] of dots) perRow.set(y, (perRow.get(y) ?? 0) + 1)
      const wide = Math.max(...perRow.values()) * 2 * aspect
      expect(Math.abs(wide - height)).toBeLessThan(2.6)
      const c = horizonCircle(size, aspect)
      expect(c.dotAspect).toBe(2 * aspect)
      expect(Math.abs(height - 2 * c.R)).toBeLessThan(2)
    }
    // The aspect moves dots across the grid but not the horizon's height.
    expect(Math.abs(horizonCircle(size, 0.45).R - horizonCircle(size, 0.56).R)).toBe(0)
    expect(litPixels(size).length).toBeGreaterThan(0)
    expect(JSON.stringify(dotSteps(size, 0.56))).not.toBe(JSON.stringify(dotSteps(size)))
  }
})

test('the silhouette never changes: the same dots are lit in every frame (occupancy is not brightness)', () => {
  for (const size of SIZES) {
    const base = bhText(drawBlackHole(size, null))
    for (let f = 0; f < FRAMES; f++) expect(bhText(drawBlackHole(size, f / FRAMES))).toEqual(base)
    // The simple characters and the uncoloured picture show the same cells lit.
    const lit = (rows: string[]) => rows.map(r => [...r].map(c => (c === ' ' ? 0 : 1)).join(''))
    expect(lit(bhText(drawBlackHole(size, null, false, 'simple')))).toEqual(lit(base))
    expect(lit(bhText(drawBlackHole(size, null, true)))).toEqual(lit(base))
  }
})

test('only brightness moves, by at most one palette step from the resting picture, and never to dark', () => {
  for (const size of SIZES) {
    const rest = steps(drawBlackHole(size, null))
    let tooFar = 0
    let dark = 0
    for (let f = 0; f < FRAMES; f += 3) {
      steps(drawBlackHole(size, f / FRAMES)).forEach((v, i) => {
        if ((v === null) !== (rest[i] === null)) dark++
        else if (v !== null && Math.abs(v - rest[i]!) > 1) tooFar++
      })
    }
    expect(tooFar).toBe(0)
    expect(dark).toBe(0)
  }
})

test('motion never makes the picture brighter than its resting frame: no frame has more cells at the top step', () => {
  for (const size of SIZES) {
    const top = (sprite: BhSprite) => steps(sprite).filter(v => v === 6).length
    const bright = (sprite: BhSprite) => steps(sprite).filter(v => v !== null && v >= 5).length
    const rest = drawBlackHole(size, null)
    for (let f = 0; f < FRAMES; f++) {
      const frame = drawBlackHole(size, f / FRAMES)
      expect(top(frame)).toBeLessThanOrEqual(top(rest))
      // Cells at 5 or 6 can only dip, dimmer ones can rise to 5: the bright share stays near its resting value.
      expect(bright(frame)).toBeLessThan(bright(rest) * 1.35 + 3)
    }
  }
})

test('no flashing: neighbouring frames differ by at most one step, in a minority of cells', () => {
  for (const size of SIZES) {
    const list = frames(size).map(steps)
    let worst = 0
    let jumps = 0
    list.forEach((a, i) => {
      const b = list[(i + 1) % list.length]!
      let changed = 0
      let count = 0
      a.forEach((v, k) => {
        if (v === null) return
        count++
        const d = Math.abs(v - b[k]!)
        if (d > 1) jumps++
        if (d) changed++
      })
      worst = Math.max(worst, changed / count)
    })
    expect(jumps).toBe(0)
    expect(worst).toBeLessThan(0.3)
    // ...and it does move: not a still picture (distinct frames, compared cheaply by their colour runs).
    const keys = new Set(frames(size).map(f => f.map(r => r.map(x => x.fg ?? '').join('')).join('|')))
    expect(keys.size).toBeGreaterThan(FRAMES / 2)
  }
})

test('the loop is seamless: the end of a cycle is the start of the next', () => {
  for (const size of SIZES) expect(drawBlackHole(size, 1)).toEqual(drawBlackHole(size, 0))
  const cycle = CYCLE_MS.slow
  expect(blackHole(cycle * 3 + 1234, 'medium')).toEqual(blackHole(1234, 'medium'))
  expect(blackHole(cycle * 7, 'large', 'veryslow')).toEqual(blackHole((cycle * 7) % CYCLE_MS.veryslow, 'large', 'veryslow'))
})

test('speed and stillness: 24 s, 36 s on very slow; null, NaN and reduced motion are the one still picture', () => {
  expect(CYCLE_MS.slow).toBe(24_000)
  expect(CYCLE_MS.veryslow).toBe(36_000)
  expect(blackHole(null, 'medium')).toEqual(drawBlackHole('medium', null))
  expect(blackHole(Number.NaN, 'medium')).toEqual(drawBlackHole('medium', null))
  expect(blackHole(null, 'medium')).toBe(blackHole(null, 'medium'))
  expect(blackHole(0, 'medium', 'slow')).toEqual(blackHole(0, 'medium', 'veryslow'))
  // Half a slow cycle in, a very slow cycle is only a third of the way round.
  expect(blackHole(CYCLE_MS.slow / 2, 'medium', 'slow')).not.toEqual(blackHole(CYCLE_MS.slow / 2, 'medium', 'veryslow'))
})

test('the palette is six steps of restrained amber, each an exact xterm-256 colour', () => {
  expect(PALETTE.length).toBe(6)
  const cube = [0, 95, 135, 175, 215, 255]
  const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  PALETTE.forEach(hex => {
    for (const c of rgb(hex)) expect(cube).toContain(c)
  })
  // Brightening step by step (by luminance), warm (red at least green at least blue), and never red-dominant or yellow-flooded.
  const lum = (hex: string) => rgb(hex)[0] * 0.299 + rgb(hex)[1] * 0.587 + rgb(hex)[2] * 0.114
  for (let i = 1; i < PALETTE.length; i++) expect(lum(PALETTE[i]!)).toBeGreaterThan(lum(PALETTE[i - 1]!))
  PALETTE.forEach(hex => {
    const [r, g, b] = rgb(hex)
    expect(r >= g && g >= b).toBe(true)
    expect(r > 2.2 * g).toBe(false)
  })
  // The brightest step is a pale gold, not white; the darkest is still amber, not grey.
  expect(rgb(PALETTE[5]!)[2]).toBeLessThan(160)
  expect(rgb(PALETTE[0]!)[0] - rgb(PALETTE[0]!)[2]).toBeGreaterThan(100)
})

test('it is mostly black and thin: few lit dots, almost none crowded, no solid block anywhere', () => {
  const fill = (size: BhSize) => litPixels(size).length / (DIMENSIONS[size].cols * 2 * DIMENSIONS[size].rows * 4)
  expect(fill('large')).toBeLessThan(0.08)
  expect(fill('medium')).toBeLessThan(0.1)
  expect(fill('small')).toBeLessThan(0.11)
  for (const size of SIZES) {
    const g = dotsOf(drawBlackHole(size, 0.25))
    let crowded = 0
    let worst = 0
    let total = 0
    g.forEach((row, y) => row.forEach((on, x) => {
      if (!on) return
      total++
      const n = around(g, x, y)
      if (n >= 5) crowded++
      worst = Math.max(worst, n)
    }))
    // A stroke is one dot thick: a dot with five or more lit neighbours is a blob. The few that exist are where the
    // disk swells beside the horizon and where ridges cross the ring (measured: under 8% of the dots at every size).
    expect(crowded / total).toBeLessThan(0.08)
    // No dot sits in the middle of a solid patch.
    expect(worst).toBeLessThan(8)
    // Lit from near the left edge to near the right edge, like the reference (whose disk tips are faint), and the black
    // stays black. The small composition is narrower by design, and its disk tips are the sparsest dots of all.
    const cols = g[0]!.length
    const litCols = Array.from({ length: cols }, (_, x) => g.some(row => row[x]))
    expect(litCols.indexOf(true)).toBeLessThan(cols * 0.12)
    expect(litCols.lastIndexOf(true)).toBeGreaterThan(cols * (size === 'small' ? 0.84 : 0.88))
  }
})

test('the accretion disk is one dot row thick away from the horizon, and the lensed arc is one dot thick everywhere', () => {
  for (const size of SIZES) {
    const kinds = litKinds(size)
    const { cols, rows } = DIMENSIONS[size]
    const W = cols * 2
    const H = rows * 4
    const cx = W / 2
    const half = Math.min(1.12 * H, W / 2 - 1)
    const diskPerColumn = new Map<number, number>()
    const arcPerColumn = new Map<number, number>()
    for (const [key, kind] of Object.entries(kinds)) {
      const [x] = key.split(',').map(Number) as [number, number]
      if (kind === 'disk') diskPerColumn.set(x, (diskPerColumn.get(x) ?? 0) + 1)
      if (kind === 'arc') arcPerColumn.set(x, (arcPerColumn.get(x) ?? 0) + 1)
    }
    for (const [x, n] of diskPerColumn) if (Math.abs(x + 0.5 - cx) > 0.5 * half) expect(n).toBeLessThan(2)
    // The swell beside the horizon is at most three rows.
    for (const n of diskPerColumn.values()) expect(n).toBeLessThan(4)
    // The arc climbs gently (a column of it may hold a few dots where it is steepest); never a band.
    const steepest = Math.max(...arcPerColumn.values())
    expect(steepest).toBeLessThan(size === 'small' ? 5 : 8)
    // Disk dots exist on both sides of the horizon: it crosses it.
    expect(Object.entries(kinds).some(([k, v]) => v === 'disk' && Number(k.split(',')[0]) < cx - 5)).toBe(true)
    expect(Object.entries(kinds).some(([k, v]) => v === 'disk' && Number(k.split(',')[0]) > cx + 5)).toBe(true)
  }
})

test('the lower arc is subtler than the upper: fewer dots, dimmer', () => {
  for (const size of SIZES) {
    const kinds = litKinds(size)
    const rest = dotSteps(size)
    const of = (k: string) => Object.entries(kinds).filter(([, v]) => v === k).map(([key]) => rest[key]!)
    const ring = of('ring')
    const bowl = of('bowl')
    expect(bowl.length).toBeGreaterThan(5)
    expect(bowl.length).toBeLessThan(ring.length)
    const mean = (xs: number[]) => xs.reduce((n, v) => n + v, 0) / xs.length
    expect(mean(bowl)).toBeLessThan(mean(ring) - 0.8)
  }
})

test('lopsided on purpose: the left of the disk runs hotter than the right', () => {
  for (const size of SIZES) {
    const kinds = litKinds(size)
    const rest = dotSteps(size)
    const cx = DIMENSIONS[size].cols
    const mean = (pred: (x: number) => boolean) => {
      const xs = Object.entries(kinds).filter(([k, v]) => v === 'disk' && pred(Number(k.split(',')[0]))).map(([k]) => rest[k]!)
      return xs.reduce((n, v) => n + v, 0) / Math.max(1, xs.length)
    }
    expect(mean(x => x < cx)).toBeGreaterThan(mean(x => x > cx))
  }
})

test('three compositions, tuned apart: detail is removed at small sizes, not thickened', () => {
  const kindsOf = (size: BhSize) => new Set(Object.values(litKinds(size)))
  expect(kindsOf('small').has('shoulder')).toBe(false)
  expect(kindsOf('medium').has('shoulder')).toBe(true)
  expect(kindsOf('large').has('shoulder')).toBe(true)
  for (const size of SIZES) for (const k of ['ring', 'bowl', 'arc', 'disk', 'dust']) expect(kindsOf(size).has(k as never)).toBe(true)
  const dust = (size: BhSize) => Object.values(litKinds(size)).filter(k => k === 'dust').length
  expect(dust('small')).toBeLessThan(dust('medium'))
  expect(dust('medium')).toBeLessThan(dust('large'))
})

test('a few isolated particles sit apart from the rest', () => {
  for (const [size, min] of [['small', 2], ['medium', 3], ['large', 5]] as const) {
    const g = dotsOf(drawBlackHole(size, null))
    let isolated = 0
    g.forEach((row, y) => row.forEach((on, x) => { if (on && around(g, x, y) === 0) isolated++ }))
    expect(isolated).toBeGreaterThanOrEqual(min)
  }
})

test('without colour the shape is the same and nothing has a colour', () => {
  for (const size of SIZES) {
    const colour = bhText(drawBlackHole(size, 0.2))
    const mono = drawBlackHole(size, 0.2, true)
    expect(bhText(mono)).toEqual(colour)
    for (const run of mono.flat()) expect([run.fg, run.bg]).toEqual([undefined, undefined])
    // No colour means nothing to animate: every frame is the one picture.
    expect(frames(size, true)[0]).toBe(frames(size, true)[FRAMES - 1])
  }
})

test('simple detail: the same lit cells as plain characters, for fonts without Braille', () => {
  for (const size of SIZES) {
    const plain = bhText(drawBlackHole(size, 0.2, false, 'simple'))
    const fine = bhText(drawBlackHole(size, 0.2))
    expect(plain.length).toBe(fine.length)
    plain.forEach((row, r) => {
      expect(row).toMatch(/^[ '.:*]*$/)
      expect(cells(row)).toBe(DIMENSIONS[size].cols)
      expect([...row].map(c => c !== ' ')).toEqual([...fine[r]!].map(c => c !== ' '))
    })
    // Still coloured and still animated, and a separate cache from the fine one.
    expect(drawBlackHole(size, 0.2, false, 'simple').flat().some(r => r.fg)).toBe(true)
    expect(blackHole(5000, size, 'slow', false, 'simple')).not.toBe(blackHole(5000, size, 'slow', false, 'auto'))
    expect(blackHole(null, size, 'slow', false, 'simple')).toBe(blackHole(null, size, 'slow', false, 'simple'))
  }
})

test('frames are built once per size and the cache costs little', () => {
  expect(frames('medium')).toBe(frames('medium'))
  expect(blackHole(2000, 'medium')).toBe(frames('medium')[Math.floor((2000 / CYCLE_MS.slow) * FRAMES)])
  const t0 = performance.now()
  for (const s of SIZES) for (const m of [false, true]) frames(s, m)
  expect(performance.now() - t0).toBeLessThan(1500)
  const t1 = performance.now()
  for (let i = 0; i < 5000; i++) blackHole(i * 100, 'large')
  expect(performance.now() - t1).toBeLessThan(400)
})

test('every coloured cell is its own run, so a frame\'s run list has the same shape in every frame', () => {
  for (const size of SIZES) {
    const shape = (s: BhSprite) => s.map(r => r.map(x => (x.fg ? '1' : String(x.text.length))).join(',')).join('|')
    const base = shape(drawBlackHole(size, null))
    for (const f of [0, 13, 29, 44, 59]) expect(shape(drawBlackHole(size, f / FRAMES))).toBe(base)
    for (const run of drawBlackHole(size, 0.1).flat()) if (run.fg) expect([...run.text].length).toBe(1)
  }
})
