// Orbit's lead graphic: a thin, dotted black hole drawn in Unicode Braille. Pure.
//
// What it is. A dark event horizon (a circle of empty cells), a ring of light on its upper edge that is bright on
// the left shoulder and breaks into dashes to the right, a thin accretion disk that crosses the horizon a little
// below its centre and is slightly warped, arcs that peel off the ring on the left and drift away, one asymmetric
// lensed arc over the top, a few separate dim fragments of the same ring below the disk, and a handful of
// particles. Most of the picture is black. It is lopsided on purpose: the left is hotter than the right.
//
// Four stages, and each only hands the next what it needs.
//   scene       (bhscene.ts) the curves as thin soft light at 4 times the dot grid's resolution: two fields,
//               coverage (where light is) and amplitude (how bright). Drawn where the curve really is, not
//               rounded to the nearest dot.
//   sampling    (bhsample.ts) the scene down to the dot grid. WHICH dots exist comes from coverage alone: enough
//               of the dot covered, a strong core, and the best dot across the line (a thinning rule), so a line
//               is one dot thick and brightness can never ask for more dots. HOW BRIGHT each lit dot is comes
//               from its amplitude plus a share of the glow around it: the brightness field blurred a little and
//               cut off at the horizon. Glow never lights a dot of its own.
//   cells       (here) one terminal cell holds 2 x 4 dots; it shows its brightest dot's colour. ANSI colour is per
//               cell, not per dot, so two dots in a cell always share it.
//   motion      (here) brightness only, one step at most, as a slow wave. Which dots exist never changes, so the
//               picture cannot get thicker or thinner while it moves, and the horizon never moves.
//
// Why Braille. A cell holds a 2 x 4 grid of dots, so the picture has 8 places for light per cell where a half
// block has 2. A cell with one dot reads as a point of light, not a block.
//
// Aspect. Terminal cells are about twice as tall as wide, so a Braille dot is about square. That is
// `CELL_ASPECT` (cell width over cell height). Geometry is composed in physical units (a dot is 1 tall), so the
// horizon is a circle at any aspect; change the constant, not the shapes.
//
// Three compositions (small, medium, large) are drawn separately, not one picture scaled: the small one has no
// shoulder, one lower fragment and a nearly flat disk. Detail is removed at small sizes, never thickened.

import { BRAILLE_BIT, CELL_DOTS, brailleChar } from './braille'
import { type DotKind, KINDS, clamp, renderScene, sceneFrame } from './bhscene'
import { type Dots, type SampleOptions, sampleScene } from './bhsample'

export type BhSize = 'small' | 'medium' | 'large'
export type BhRun = { text: string; fg?: string; bg?: string }
export type BhSprite = BhRun[][]
/** `auto` draws Braille; `simple` draws the same dots as `'` `.` `:` `*` for fonts without Braille. */
export type ArtDetail = 'auto' | 'simple'

/** Cycle length per speed setting (ms). */
export const CYCLE_MS = { slow: 24_000, veryslow: 36_000 } as const
export type BhSpeed = keyof typeof CYCLE_MS
/** Distinct frames per cycle (2.5 a second at `slow`): what the pane redraws at, no faster. */
export const FRAMES = 60

/** Six steps of restrained amber, dark to bright. Each is an exact xterm-256 entry (94 130 137 173 215 222), so a 256-colour terminal shows what a true-colour one does. */
export const PALETTE = ['#875f00', '#af5f00', '#af875f', '#d7875f', '#ffaf5f', '#ffd787'] as const

/** Cells (columns × rows) of each composition. The dot grid is `cols * 2` wide and `rows * 4` tall. */
export const DIMENSIONS: Record<BhSize, { cols: number; rows: number }> = {
  small: { cols: 30, rows: 7 },
  medium: { cols: 44, rows: 10 },
  large: { cols: 64, rows: 14 },
}

/** A terminal cell's width over its height. Most monospaced fonts sit between 0.48 and 0.56; the dots are square at 0.5. */
export const CELL_ASPECT = 0.5

/** The size that fits `cols` columns and `rows` rows, or null when none does (then there is no picture). */
export function sizeFor(cols: number, rows: number): BhSize | null {
  for (const s of ['large', 'medium', 'small'] as const) if (cols >= DIMENSIONS[s].cols && rows >= DIMENSIONS[s].rows) return s
  return null
}

// ---- the dot grid ---------------------------------------------------------------------------
export type { DotKind }

/** Subpixels per dot, each way, that the scene is drawn at before it is sampled down. */
export const SUPERSAMPLE = 4

/** What the shipped picture asks of the sampler: palette steps of glow a dot may gain, and the share of extra halo dots (none). */
export const SAMPLING: SampleOptions = { glow: 2.6, halo: 0 }

/**
 * The dots of a composition for a cell aspect: the scene drawn at `ss` times the dot grid's resolution, then sampled
 * down. Not cached: `dots` is the cached one at the real aspect.
 */
export function buildDots(size: BhSize, aspect: number = CELL_ASPECT, options: Partial<SampleOptions> & { ss?: number } = {}): Dots {
  const { cols, rows } = DIMENSIONS[size]
  return sampleScene(renderScene(size, cols, rows, aspect, options.ss ?? SUPERSAMPLE), { ...SAMPLING, ...options })
}

const dotCache = new Map<BhSize, Dots>()
const dots = (size: BhSize): Dots => {
  let d = dotCache.get(size)
  if (!d) dotCache.set(size, (d = buildDots(size)))
  return d
}

// ---- cells ----------------------------------------------------------------------------------
/** One terminal cell: its dot mask, and the step, kind and place of its brightest dot (which sets its colour and its motion). */
type Cell = { mask: number; lv: number; kind: DotKind; along: number; ph: number }
const cellCache = new Map<BhSize, Cell[][]>()

function cellsOf(size: BhSize): Cell[][] {
  let c = cellCache.get(size)
  if (c) return c
  const { cols, rows } = DIMENSIONS[size]
  const d = dots(size)
  c = []
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = []
    for (let x = 0; x < cols; x++) {
      let mask = 0
      let best = -1
      for (let j = 0; j < CELL_DOTS.rows; j++) {
        for (let i = 0; i < CELL_DOTS.cols; i++) {
          const k = (r * CELL_DOTS.rows + j) * d.W + x * CELL_DOTS.cols + i
          if (!d.lv[k]) continue
          mask |= BRAILLE_BIT[j]![i]!
          if (best < 0 || d.lv[k]! > d.lv[best]!) best = k
        }
      }
      row.push(best < 0 ? { mask: 0, lv: 0, kind: 'dust', along: 0, ph: 0 } : { mask, lv: d.lv[best]!, kind: KINDS[d.kind[best]!]!, along: d.along[best]!, ph: d.ph[best]! })
    }
    c.push(row)
  }
  cellCache.set(size, c)
  return c
}

/** A glint: 1 while the wave at a cell's position is high, 0 otherwise. */
const glint = (theta: number) => (Math.sin(Math.PI * 2 * theta) > 0.5 ? 1 : 0)

/** Where the wave is high at cycle position `t` (1 or 0): a wave that travels, not a flicker everywhere. */
function shimmer(c: Cell, t: number): number {
  switch (c.kind) {
    // A slow warm wave along the disk, twice round the cycle: the flow of hot material.
    case 'disk':
      return glint(c.along - t * 2 + 0.12 * c.ph)
    // A glint that travels round the ring.
    case 'ring':
      return glint(t * 2 - c.along * 0.8)
    // A slower ripple along the lensed arc and its ridges.
    case 'arc':
    case 'shoulder':
      return glint(t + 0.9 * c.ph - 0.35 * c.along)
    case 'bowl':
      return glint(t - 0.7 * c.along)
    // Each particle breathes on its own beat.
    case 'dust':
      return glint(t * 2 + c.ph)
  }
}

/**
 * The step a cell shows at cycle position `t` (null: the resting picture). The wave moves a cell one step, toward the
 * middle of the ramp: a cell at 5 or 6 dips as the wave passes, a dimmer one rises. So motion never makes the picture
 * brighter than its resting frame (which has the most cells at the top step), and nothing goes dark.
 */
const stepAt = (c: Cell, t: number | null) => (t === null ? c.lv : clamp(c.lv + (c.lv >= 5 ? -shimmer(c, t) : shimmer(c, t)), 1, 6))

const hex = (step: number) => PALETTE[clamp(step, 1, 6) - 1]!

/** The glyph for a cell in `simple` mode: where in the cell the light is (top `'`, bottom `.`, both `:`), `*` when it is crowded. */
function simpleChar(mask: number): string {
  const top = (BRAILLE_BIT[0]![0] | BRAILLE_BIT[0]![1] | BRAILLE_BIT[1]![0] | BRAILLE_BIT[1]![1]) & mask
  const bottom = mask & ~top
  let n = 0
  for (let m = mask; m; m &= m - 1) n++
  if (n >= 5) return '*'
  return top && bottom ? ':' : top ? "'" : '.'
}

/** One frame of one composition; `t` in [0, 1) is the point in the cycle, null the resting picture. */
export function drawBlackHole(size: BhSize, t: number | null, isMono = false, detail: ArtDetail = 'auto'): BhSprite {
  const out: BhSprite = []
  for (const row of cellsOf(size)) {
    const runs: BhRun[] = []
    for (const c of row) {
      const text = c.mask === 0 ? ' ' : detail === 'simple' ? simpleChar(c.mask) : brailleChar(c.mask)
      const last = runs.at(-1)
      if (c.mask === 0 || isMono) {
        // Only runs without colour merge. Every coloured cell is its own run, so a frame's run list has the same
        // shape in every frame: a colour that changes never joins or splits its neighbours, so the pane's elements
        // keep their place from one frame to the next (its rows are keyed by position).
        if (last && !last.fg) last.text += text
        else runs.push({ text })
      } else runs.push({ text, fg: hex(stepAt(c, t)) })
    }
    out.push(runs)
  }
  return out
}

const cache = new Map<string, BhSprite[]>()
const key = (size: BhSize, isMono: boolean, detail: ArtDetail) => `${size}${isMono ? ':m' : ''}${detail === 'simple' ? ':s' : ''}`

/** The resting frame of each size, built once (reduced motion and animation off draw it on every render). */
const still = new Map<string, BhSprite>()
function stillFrame(size: BhSize, isMono: boolean, detail: ArtDetail): BhSprite {
  const k = key(size, isMono, detail)
  let f = still.get(k)
  if (!f) still.set(k, (f = drawBlackHole(size, null, isMono, detail)))
  return f
}

/** Every frame of a cycle for a size, computed once. Without colour nothing moves, so those frames are one picture. */
export function frames(size: BhSize, isMono = false, detail: ArtDetail = 'auto'): BhSprite[] {
  const k = key(size, isMono, detail)
  let list = cache.get(k)
  if (!list) {
    list = isMono ? Array.from({ length: FRAMES }, () => stillFrame(size, true, detail)) : Array.from({ length: FRAMES }, (_, f) => drawBlackHole(size, f / FRAMES, false, detail))
    cache.set(k, list)
  }
  return list
}

const wrap1 = (x: number) => x - Math.floor(x)

/** The frame to draw at `ms`; null is the resting picture (idle, reduced motion). */
export function blackHole(ms: number | null, size: BhSize, speed: BhSpeed = 'slow', isMono = false, detail: ArtDetail = 'auto'): BhSprite {
  if (ms === null || !Number.isFinite(ms)) return stillFrame(size, isMono, detail)
  const f = Math.floor(wrap1(ms / CYCLE_MS[speed]) * FRAMES) % FRAMES
  return frames(size, isMono, detail)[f]!
}

/** The sprite as plain text, one string a row. */
export function bhText(s: BhSprite): string[] {
  return s.map(r => r.map(x => x.text).join(''))
}

// ---- for tests -------------------------------------------------------------------------------
/** Which dots are lit in a composition, as `x,y` keys (dot grid): the silhouette. Tests compare it across frames. */
export function litPixels(size: BhSize): string[] {
  const { W, H, lv } = dots(size)
  const out: string[] = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lv[y * W + x]) out.push(`${x},${y}`)
  return out
}

/** Each lit dot's palette step (1 to 6), keyed `x,y`, for a cell aspect (the real one by default). */
export function dotSteps(size: BhSize, aspect: number = CELL_ASPECT): Record<string, number> {
  const { W, H, lv } = aspect === CELL_ASPECT ? dots(size) : buildDots(size, aspect)
  const out: Record<string, number> = {}
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lv[y * W + x]) out[`${x},${y}`] = lv[y * W + x]!
  return out
}

/** The dots that must stay dark in every frame: the event horizon, except the rows the (warped) disk crosses it on. */
export function horizonPixels(size: BhSize, aspect: number = CELL_ASPECT): string[] {
  const { W, H, K, cx, cy, R, ax, band } = sceneFrame(size, DIMENSIONS[size].cols, DIMENSIONS[size].rows, aspect)
  const out: string[] = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot((x + 0.5) * K - cx, y + 0.5 - cy) < R && Math.abs(y - ax) > band) out.push(`${x},${y}`)
  return out
}

/** The horizon's circle in physical units: its centre and radius, and the dots' width over height. For tests of the aspect correction. */
export function horizonCircle(size: BhSize, aspect: number = CELL_ASPECT) {
  const { K, cx, cy, R } = sceneFrame(size, DIMENSIONS[size].cols, DIMENSIONS[size].rows, aspect)
  return { cx, cy, R, dotAspect: K }
}

/** What each lit dot is part of (`ring`, `bowl`, `shoulder`, `arc`, `disk`, `dust`), keyed `x,y`. */
export function litKinds(size: BhSize): Record<string, DotKind> {
  const { W, H, lv, kind } = dots(size)
  const out: Record<string, DotKind> = {}
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lv[y * W + x]) out[`${x},${y}`] = KINDS[kind[y * W + x]!]!
  return out
}
