import { expect, test } from 'claude-code/testing'

import { CYCLE_MS, DIMENSIONS, FRAMES, PALETTE, bhText, blackHole, drawBlackHole, frames, horizonPixels, litKinds, litPixels, sizeFor } from '../hooks/blackhole'
import type { BhSize, BhSprite } from '../hooks/blackhole'

const SIZES: BhSize[] = ['small', 'medium', 'large']

/** Each pixel's palette step (1..8) or null for dark, row-major, from a drawn sprite. */
function levels(sprite: BhSprite): (number | null)[] {
  const W = sprite[0]!.reduce((n, r) => n + r.text.length, 0)
  const out: (number | null)[] = new Array(W * sprite.length * 2).fill(null)
  const step = (hex: string | undefined) => (hex ? PALETTE.indexOf(hex as (typeof PALETTE)[number]) + 1 : null)
  sprite.forEach((runs, r) => {
    let x = 0
    for (const run of runs) {
      for (const ch of run.text) {
        if (ch === '▀') {
          out[r * 2 * W + x] = step(run.fg)
          out[(r * 2 + 1) * W + x] = step(run.bg)
        } else if (ch === '▄') out[(r * 2 + 1) * W + x] = step(run.fg)
        x++
      }
    }
  })
  return out
}
const lit = (sprite: BhSprite) => levels(sprite).map(v => v !== null)

test('every composition is exactly its size, drawn only with half blocks and spaces', () => {
  for (const size of SIZES) {
    const text = bhText(drawBlackHole(size, 0.3))
    expect(text.length).toBe(DIMENSIONS[size].rows)
    for (const row of text) {
      expect([...row].length).toBe(DIMENSIONS[size].cols)
      expect(row).toMatch(/^[ ▀▄]*$/)
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

test('the event horizon is dark in every frame, in colour and in shades', () => {
  for (const size of SIZES) {
    const dark = new Set(horizonPixels(size))
    expect(dark.size).toBeGreaterThan(20)
    const { cols } = DIMENSIONS[size]
    for (const isMono of [false, true]) {
      for (const f of [0, 9, 21, 30, 44, 59]) {
        const lv = levels(drawBlackHole(size, f / FRAMES, isMono))
        if (isMono) continue
        lv.forEach((v, i) => {
          if (v !== null) expect(dark.has(`${i % cols},${Math.floor(i / cols)}`)).toBe(false)
        })
      }
    }
    // Dark is no colour at all, not a dark colour.
    for (const run of drawBlackHole(size, 0.4).flat()) if (run.text.trim() === '') expect([run.fg, run.bg]).toEqual([undefined, undefined])
  }
})

test('the dim arc inside the horizon is the only thing lit there, and it is never bright', () => {
  for (const size of ['medium', 'large'] as const) {
    const kinds = litKinds(size)
    const arc = Object.entries(kinds).filter(([, k]) => k === 'arc').map(([key]) => key)
    expect(arc.length).toBeGreaterThan(6)
    const { cols } = DIMENSIONS[size]
    for (const f of [0, 15, 30, 45]) {
      const lv = levels(drawBlackHole(size, f / FRAMES))
      for (const key of arc) {
        const [x, y] = key.split(',').map(Number)
        expect(lv[y! * cols + x!]).toBeLessThanOrEqual(3)
      }
    }
  }
  expect(Object.values(litKinds('small')).includes('arc')).toBe(false)
})

test('the silhouette never changes: the same pixels are lit in every frame', () => {
  for (const size of SIZES) {
    const base = lit(drawBlackHole(size, null))
    expect(base.filter(Boolean).length).toBe(litPixels(size).length)
    for (const f of [0, 7, 19, 33, 47, 59]) expect(lit(drawBlackHole(size, f / FRAMES))).toEqual(base)
  }
})

test('only brightness moves, and never by more than one palette step from the resting picture', () => {
  for (const size of SIZES) {
    const rest = levels(drawBlackHole(size, null))
    let tooFar = 0
    let dark = 0
    for (let f = 0; f < FRAMES; f += 3) {
      levels(drawBlackHole(size, f / FRAMES)).forEach((v, i) => {
        if (v === null) return
        if (Math.abs(v - rest[i]!) > 1) tooFar++
        if (v < 1) dark++
      })
    }
    expect(tooFar).toBe(0)
    expect(dark).toBe(0)
  }
})

test('no flashing: neighbouring frames differ by at most one step, in a minority of pixels', () => {
  for (const size of SIZES) {
    const list = frames(size).map(levels)
    let worst = 0
    let jumps = 0
    list.forEach((a, i) => {
      const b = list[(i + 1) % list.length]!
      let changed = 0
      let litCount = 0
      a.forEach((v, k) => {
        if (v === null) return
        litCount++
        const d = Math.abs(v - b[k]!)
        if (d > 1) jumps++
        if (d) changed++
      })
      worst = Math.max(worst, changed / litCount)
    })
    expect(jumps).toBe(0)
    expect(worst).toBeLessThan(0.3)
    // ...and it does move: not a still picture (distinct frames, compared cheaply by their colour runs).
    const keys = new Set(frames(size).map(f => f.map(r => r.map(x => x.fg + x.bg).join('')).join('|')))
    expect(keys.size).toBeGreaterThan(FRAMES / 2)
  }
})

test('the loop is seamless: the end of a cycle is the start of the next', () => {
  for (const size of SIZES) expect(drawBlackHole(size, 1)).toEqual(drawBlackHole(size, 0))
  const cycle = CYCLE_MS.slow
  expect(blackHole(cycle * 3 + 1234, 'medium')).toEqual(blackHole(1234, 'medium'))
  expect(blackHole(cycle * 7, 'large', 'veryslow')).toEqual(blackHole(cycle * 7 % CYCLE_MS.veryslow, 'large', 'veryslow'))
})

test('speed and stillness: 24 s, 36 s on very slow; null, NaN and reduced motion are the one still picture', () => {
  expect(CYCLE_MS.slow).toBe(24_000)
  expect(CYCLE_MS.veryslow).toBe(36_000)
  expect(blackHole(null, 'medium')).toEqual(drawBlackHole('medium', null))
  expect(blackHole(Number.NaN, 'medium')).toEqual(drawBlackHole('medium', null))
  expect(blackHole(0, 'medium', 'slow')).toEqual(blackHole(0, 'medium', 'veryslow'))
  // Half a slow cycle in, a very slow cycle is only a third of the way round.
  expect(blackHole(CYCLE_MS.slow / 2, 'medium', 'slow')).not.toEqual(blackHole(CYCLE_MS.slow / 2, 'medium', 'veryslow'))
})

test('the palette is eight steps of dark red to amber, each an exact xterm-256 colour', () => {
  expect(PALETTE.length).toBe(8)
  const cube = [0, 95, 135, 175, 215, 255]
  PALETTE.forEach(hex => {
    const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16))
    for (const c of [r!, g!, b!]) expect(cube).toContain(c)
  })
  // Warm and brightening: red never falls, green never falls, from step to step.
  for (let i = 1; i < PALETTE.length; i++) {
    const a = PALETTE[i - 1]!
    const b = PALETTE[i]!
    expect(Number.parseInt(b.slice(1, 3), 16)).toBeGreaterThanOrEqual(Number.parseInt(a.slice(1, 3), 16))
    expect(Number.parseInt(b.slice(3, 5), 16)).toBeGreaterThanOrEqual(Number.parseInt(a.slice(3, 5), 16))
  }
})

test('it is thin pixel art, not a bar: no tall solid column, few of the very brightest pixels', () => {
  for (const size of ['medium', 'large'] as const) {
    const { cols, rows } = DIMENSIONS[size]
    const H = rows * 2
    const lv = levels(drawBlackHole(size, 0.25))
    const total = lv.filter(v => v !== null).length
    // The brightest steps are rare: hot material is a few pixels, not a stripe.
    expect(lv.filter(v => v !== null && v >= 7).length / total).toBeLessThan(0.08)
    // No column is lit top to bottom, and the disk's own band is thin: no run of lit pixels is more than 60% of the height.
    for (let x = 0; x < cols; x++) {
      let run = 0
      let longest = 0
      for (let y = 0; y < H; y++) {
        run = lv[y * cols + x] !== null ? run + 1 : 0
        longest = Math.max(longest, run)
      }
      expect(longest).toBeLessThan(H * 0.6)
    }
    // Wide, like the reference: lit from near the left edge to near the right edge, and mostly black.
    const litCols = Array.from({ length: cols }, (_, x) => lv.some((_, k) => k % cols === x && lv[k] !== null))
    expect(litCols.indexOf(true)).toBeLessThan(cols * 0.12)
    expect(litCols.lastIndexOf(true)).toBeGreaterThan(cols * 0.88)
    expect(total / lv.length).toBeLessThan(0.4)
  }
})

test('lopsided on purpose: the left of the disk runs hotter than the right, the dome is brighter than the bowl', () => {
  for (const size of ['medium', 'large'] as const) {
    const { cols, rows } = DIMENSIONS[size]
    const lv = levels(drawBlackHole(size, null))
    const mean = (pred: (x: number, y: number) => boolean) => {
      const xs = lv.map((v, i) => [v, i % cols, Math.floor(i / cols)] as const).filter(([v, x, y]) => v !== null && pred(x, y))
      return xs.reduce((n, [v]) => n + v!, 0) / Math.max(1, xs.length)
    }
    const mid = Math.floor(rows)
    expect(mean((x, y) => x < cols * 0.42 && y > mid - 6 && y < mid + 4)).toBeGreaterThan(mean((x, y) => x > cols * 0.58 && y > mid - 6 && y < mid + 4))
    expect(mean((_, y) => y < mid - 3)).toBeGreaterThan(mean((_, y) => y > mid + 5))
  }
})

test('three compositions, tuned apart: the small one has no bowl, the large one more particles and texture', () => {
  const count = (size: BhSize) => litPixels(size).length / (DIMENSIONS[size].cols * DIMENSIONS[size].rows * 2)
  const bowlRows = (size: BhSize) => {
    const lv = levels(drawBlackHole(size, null))
    const { cols, rows } = DIMENSIONS[size]
    // Lit pixels in the lowest fifth of the picture, away from the sides.
    return lv.filter((v, i) => v !== null && Math.floor(i / cols) > rows * 2 * 0.78 && (i % cols) > cols * 0.3 && (i % cols) < cols * 0.7).length
  }
  expect(bowlRows('small')).toBe(0)
  expect(bowlRows('medium')).toBeGreaterThan(3)
  expect(bowlRows('large')).toBeGreaterThan(bowlRows('medium'))
  // Not one picture scaled: the lit fraction differs between sizes.
  expect(new Set(SIZES.map(s => count(s).toFixed(3))).size).toBe(3)
})

test('a few isolated particles sit apart from the rest, in the medium and large pictures', () => {
  for (const [size, min] of [['medium', 3], ['large', 5]] as const) {
    const { cols } = DIMENSIONS[size]
    const lv = levels(drawBlackHole(size, null))
    const H = lv.length / cols
    let isolated = 0
    lv.forEach((v, i) => {
      if (v === null) return
      const x = i % cols
      const y = Math.floor(i / cols)
      let near = 0
      for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) if ((j || k) && x + k >= 0 && x + k < cols && y + j >= 0 && y + j < H && lv[(y + j) * cols + x + k] !== null) near++
      if (near === 0) isolated++
    })
    expect(isolated).toBeGreaterThanOrEqual(min)
  }
})

test('without colour the shape is the same and the horizon is still empty', () => {
  for (const size of SIZES) {
    const colour = bhText(drawBlackHole(size, 0.2))
    const mono = drawBlackHole(size, 0.2, true)
    expect(bhText(mono).map(r => r.replace(/[░▒▓█]/g, '▀'))).toEqual(colour.map(r => r))
    for (const run of mono.flat()) expect([run.fg, run.bg]).toEqual([undefined, undefined])
    expect(bhText(mono).join('')).toMatch(/[░▒▓█]/)
  }
})

test('frames are built once per size and the cache costs little', () => {
  expect(frames('medium')).toBe(frames('medium'))
  expect(blackHole(2000, 'medium')).toBe(frames('medium')[Math.floor((2000 / CYCLE_MS.slow) * FRAMES)])
  const t0 = performance.now()
  for (const s of SIZES) for (const m of [false, true]) frames(s, m)
  expect(performance.now() - t0).toBeLessThan(800)
  const t1 = performance.now()
  for (let i = 0; i < 5000; i++) blackHole(i * 100, 'large')
  expect(performance.now() - t1).toBeLessThan(400)
})
