// Orbit's lead graphic: a pixel-art black hole in terminal cells. Pure.
//
// What it is. A small, deliberately shaped picture, drawn in square dots like an amber halftone:
// a dark event horizon with a thin dotted photon ring hugging its edge, a bright thin accretion
// disk that crosses the horizon's lower part and tapers to dotted points, a broad dotted dome of
// lensed light over the top (dense on the hot left shoulder, thinning to one sparse outer arc), a
// faint dotted arc under the disk, and a few isolated brighter particles. Most of the picture is
// black. It is lopsided on purpose: the left is hotter and denser than the right.
//
// Where it comes from. The target is an amber halftone of a black hole (separate square dots on a
// grid, a dark horizon, a thin ring, a bright disk line, a sparse dome). It is still hand-authored:
// the shapes below are written as formulas and hand-placed particles, not traced from an image.
//
// How it is drawn. A cell is about twice as tall as it is wide, so a half block (`▀` `▄`) is a
// square pixel: the top pixel is the glyph's colour, the bottom pixel is its background. Dark
// areas (the horizon, the sky) are cells with no colour at all, never a dark colour, so a terminal
// without colour still shows the horizon as empty. The palette is eight steps of one amber hue
// whose colours are exact xterm-256 entries, so a 256-colour terminal shows the same picture as a
// true-colour one. Density is a static ordered dither (a 4x4 Bayer matrix on the pixel position):
// each region has a coverage, a pixel is lit when the coverage beats its threshold, so the dome and
// the outer disk are sparse dots while the ring, the disk core and the particles stay solid.
//
// Three compositions (small, medium, large) are tuned separately, not one picture scaled: the
// small one keeps the horizon, the thin disk and the dome; the large one adds the photon ring, the
// lower arc and more particles.
//
// How it moves. Which pixels are lit never changes (the dither is decided once), so the silhouette
// and the horizon are fixed. Only the brightness of lit pixels moves, by at most one palette step:
// a slow warm wave along the disk, a slower ripple through the dome, a shimmer round the ring and a
// gentle twinkle of the particles. A cycle is 24 seconds (36 on `veryslow`) and its last frame is
// the first frame's neighbour, so it loops without a seam.

export type BhSize = 'small' | 'medium' | 'large'
export type BhRun = { text: string; fg?: string; bg?: string }
export type BhSprite = BhRun[][]

/** Cycle length per speed setting (ms). */
export const CYCLE_MS = { slow: 24_000, veryslow: 36_000 } as const
export type BhSpeed = keyof typeof CYCLE_MS
/** Distinct frames per cycle (2.5 a second at `slow`): what the pane redraws at, no faster. */
export const FRAMES = 60

/** One amber hue, dark to bright. Each is an exact xterm-256 colour (94, 130, 136, 172, 214, 215, 221, 222). */
export const PALETTE = ['#875f00', '#af5f00', '#af8700', '#d78700', '#ffaf00', '#ffaf5f', '#ffd75f', '#ffd787'] as const

/** Cells (columns × rows) of each composition. A pixel grid is `cols` wide and `rows * 2` tall. */
export const DIMENSIONS: Record<BhSize, { cols: number; rows: number }> = {
  small: { cols: 30, rows: 7 },
  medium: { cols: 44, rows: 10 },
  large: { cols: 64, rows: 14 },
}

/**
 * Per-composition tuning: how much texture, how many particles, whether it has the photon ring and
 * the lower arc, how wide a one-pixel ring is in the horizon's own units, and which extra rows the
 * disk gets above and below its centre line.
 */
const TUNE: Record<BhSize, { texture: number; particles: number; bowl: boolean; photon: boolean; ringW: number; diskUp: boolean; diskDown: boolean }> = {
  small: { texture: 0, particles: 3, bowl: false, photon: false, ringW: 0.24, diskUp: false, diskDown: false },
  medium: { texture: 0.45, particles: 6, bowl: true, photon: true, ringW: 0.17, diskUp: true, diskDown: false },
  large: { texture: 0.8, particles: 10, bowl: true, photon: true, ringW: 0.15, diskUp: true, diskDown: true },
}

/** The glyph set when colour is not available: shades by brightness, half blocks for the brightest. */
const MONO = [' ', '░', '▒', '▓', '█'] as const

/** The size that fits `cols` columns and `rows` rows, or null when none does (then there is no picture). */
export function sizeFor(cols: number, rows: number): BhSize | null {
  for (const s of ['large', 'medium', 'small'] as const) if (cols >= DIMENSIONS[s].cols && rows >= DIMENSIONS[s].rows) return s
  return null
}

// ---- the picture, in a reference space -----------------------------------------------------
// The picture is composed on a 620 × 274 canvas (disk tip to tip, outer arc to lower arc) and
// sampled at the pixel grid, so the three sizes share proportions but not pixels.
const REF = { w: 620, h: 274, x0: 35, y0: 118 }
const CX = 340 // the horizon's centre
const AXIS = 283 // the disk's own centre line (snapped to a pixel row per size)
const HORIZON = { rx: 95, ry: 90, up: 28 } // the horizon's centre sits `up` above the disk line
const DISK_HALF = 300 // the disk reaches this far either side of the centre
// The outer envelope of the lensed light: an ellipse on the disk line, wider on the hot left side.
const OUTER = { cx: CX + 10, rxLeft: 250, rxRight: 175, ry: 150 }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** A fixed pseudo-random number from a pixel's position: texture that never changes between frames. */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(seed + 1, 2147483647)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** The 4x4 Bayer matrix as thresholds in (0, 1): a pixel with coverage above its threshold is lit. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const threshold = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16

type Kind = 'ring' | 'dome' | 'disk' | 'bowl' | 'dust'
/** One lit pixel: its brightness step (1 to 8), what part of the picture it belongs to, and where along it. */
type Lit = { level: number; kind: Kind; along: number; phase: number }
/** A candidate pixel: lit only if its coverage (0 to 1) beats the dither threshold at its position. */
type Sample = Lit & { cov: number }

/** Where things sit for one size: the disk line snapped to a pixel row, and the pixel's own height. */
function geo(size: BhSize) {
  const H = DIMENSIONS[size].rows * 2
  const row = Math.round(((AXIS - REF.y0) / REF.h) * H - 0.5)
  const ax = REF.y0 + ((row + 0.5) / H) * REF.h
  return { ax, pxH: REF.h / H, cy: ax - HORIZON.up }
}

/** The horizon's edge distance: 1 on the edge, below 1 inside. */
const edgeOf = (X: number, Y: number, cy: number) => Math.hypot((X - CX) / HORIZON.rx, (Y - cy) / HORIZON.ry)
/** Within one pixel row of the disk's centre line: the only rows where the horizon may be lit (the disk crosses it). */
const isDiskRow = (Y: number, size: BhSize) => {
  const { ax, pxH } = geo(size)
  return Math.abs(Math.round((Y - ax) / pxH)) <= 1
}

/** A few isolated particles, in reference space, placed by hand: not on any curve, not evenly spread. */
const DUST: { x: number; y: number; level: number }[] = [
  { x: 112, y: 150, level: 6 }, { x: 600, y: 166, level: 5 }, { x: 70, y: 252, level: 4 }, { x: 628, y: 232, level: 7 },
  { x: 205, y: 372, level: 5 }, { x: 498, y: 368, level: 4 }, { x: 205, y: 128, level: 4 }, { x: 540, y: 134, level: 8 },
  { x: 150, y: 330, level: 5 }, { x: 410, y: 386, level: 3 },
]

/** The candidate pixel at reference position (X, Y), or null for sky and for the horizon. */
function sample(X: number, Y: number, size: BhSize): Sample | null {
  const tune = TUNE[size]
  const { ax, pxH, cy } = geo(size)
  const dx = X - CX
  const t = dx / DISK_HALF
  const k = Math.round((Y - ax) / pxH) // pixel rows below (+) or above (-) the disk's centre line
  const left = smooth(CX + 30, CX - 130, X) // 1 on the hot left side, 0 on the right
  const E = edgeOf(X, Y, cy)

  // The disk: a bright thin line along the axis, one or two pixels tall, in front of the horizon,
  // tapering to dotted points. The rows just above and below it are dimmer.
  if (k >= -1 && k <= 1) {
    const a = Math.abs(t)
    if (a > 1) return null
    const core = smooth(0.9, 0.15, a)
    const lean = 1 + 0.35 * smooth(-0.05, -0.45, t) // the left side is the hot one
    const grain = (hash(Math.round(X / 8), Math.round(Y / 8), 2) - 0.5) * tune.texture * 0.8
    const base = 2.4 + 2.9 * core * lean + grain
    const along = t
    if (k === 0) return { level: clamp(Math.round(base), 1, 8), kind: 'disk', along, phase: 0.5, cov: 0.3 + 0.62 * smooth(0.95, 0.4, a) + 0.1 * smooth(0.3, 0.15, a) }
    if (k === -1 && tune.diskUp) return { level: clamp(Math.round(base - 1.2 - 1.6 * smooth(0.15, 0.6, a)), 1, 8), kind: 'disk', along, phase: 0.1, cov: 0.86 * smooth(0.66, 0.1, a) + 0.14 * smooth(0.3, 0.1, a) }
    if (k === 1 && tune.diskDown) return { level: clamp(Math.round(base - 3), 1, 8), kind: 'disk', along, phase: 0.9, cov: 0.8 * smooth(0.55, 0.15, a) }
    return null
  }

  // The event horizon stays unlit.
  if (E < 1.05) return null

  if (k > 1) {
    if (!tune.bowl) return null
    // A faint dotted arc continuing the horizon's edge under the disk, sparse, hotter on the left.
    if (E >= 1.1 && E < 1.1 + tune.ringW * 0.9) {
      const fade = smooth(1.5, 3.5, k) * smooth(1.12 * HORIZON.rx, 0.9 * HORIZON.rx, Math.abs(dx) * 0.9)
      return { level: clamp(Math.round(3 + 1.2 * left), 1, 6), kind: 'bowl', along: t, phase: (E - 1.1) / tune.ringW, cov: 0.85 * fade }
    }
    return null
  }

  // Above the disk: the photon ring hugging the horizon, then the lensed dome out to its outer arc.
  const rxo = X < OUTER.cx ? OUTER.rxLeft : OUTER.rxRight
  const Eo = Math.hypot((X - OUTER.cx) / rxo, (Y - ax) / OUTER.ry)
  if (tune.photon && E < 1.05 + tune.ringW) {
    return { level: clamp(Math.round(5 + 0.9 * left - 0.4 * smooth(0.1, 1, (X - CX) / 150)), 1, 8), kind: 'ring', along: t, phase: 0.2, cov: 0.8 }
  }
  if (Eo > 1) return null
  const arcW = (tune.ringW * 1.1 * HORIZON.ry) / OUTER.ry
  const rise = smooth(ax - 10, ax - OUTER.ry, Y) // 0 low, 1 at the very top
  if (Eo >= 1 - arcW) {
    // The thin outer arc: sparse dotted points, brighter toward the top and the left.
    return { level: clamp(Math.round(2.4 + 1.3 * rise + 1.0 * left), 1, 8), kind: 'dome', along: t, phase: 1, cov: 0.36 + 0.14 * left + (tune.photon ? 0 : 0.3) }
  }
  const s = clamp((E - 1.05) / (E - 1.05 + 1.7 * (1 - Eo) + 1e-6), 0, 1) // 0 at the horizon's edge .. 1 at the outer arc
  const near = 1 - smooth(0.08, 0.85, s)
  const grain = (hash(Math.round(X / 9), Math.round(Y / 9), 1) - 0.5) * tune.texture * 0.8
  const top = smooth(ax - 70, ax - 150, Y)
  const cov = 0.06 + (0.3 + 0.5 * Math.max(left, 0.5 * top)) * near ** 1.3
  const level = 1.8 + 2.2 * near + 1 * left * near + grain
  return { level: clamp(Math.round(level), 1, 7), kind: 'dome', along: t, phase: s, cov }
}

/** The lit pixels of one composition as a grid, row-major, `null` for dark. Computed once. */
const gridCache = new Map<BhSize, { W: number; H: number; px: (Lit | null)[] }>()

function grid(size: BhSize) {
  let g = gridCache.get(size)
  if (g) return g
  const { cols, rows } = DIMENSIONS[size]
  const W = cols
  const H = rows * 2
  const px: (Lit | null)[] = new Array(W * H).fill(null)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // The dither: lit or dark is decided here, once, so the silhouette is the same in every frame.
      const s = sample(REF.x0 + ((x + 0.5) / W) * REF.w, REF.y0 + ((y + 0.5) / H) * REF.h, size)
      if (s && s.cov > threshold(x, y)) px[y * W + x] = { level: s.level, kind: s.kind, along: s.along, phase: s.phase }
    }
  }
  // Isolated particles go on last, only on dark pixels and never next to anything lit.
  const n = TUNE[size].particles
  const taken = (x: number, y: number) => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (px[(y + j) * W + x + i]) return true
    return false
  }
  const { cy } = geo(size)
  DUST.slice(0, n).forEach((d, k) => {
    const x = Math.round(((d.x - REF.x0) / REF.w) * W - 0.5)
    const y = Math.round(((d.y - REF.y0) / REF.h) * H - 0.5)
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || taken(x, y)) return
    if (edgeOf(d.x, d.y, cy) < 1.3) return
    px[y * W + x] = { level: d.level, kind: 'dust', along: x / W, phase: hash(x, y, 7 + k) }
  })
  g = { W, H, px }
  gridCache.set(size, g)
  return g
}

/** A glint: a pixel is one step brighter while the wave at its position is high, and at its resting step otherwise. */
const glint = (theta: number) => (Math.sin(Math.PI * 2 * theta) > 0.5 ? 1 : 0)

/** How much brighter (in palette steps, never more than one) a lit pixel is at `phase`: a wave that travels, not a flicker everywhere. */
function shimmer(p: Lit, phase: number): number {
  switch (p.kind) {
    // A slow warm wave along the disk, twice round the picture a cycle: the flow of hot material.
    case 'disk':
      return glint(p.along - phase * 2 + 0.12 * p.phase)
    // A slower ripple moving through the dome's bands.
    case 'dome':
      return glint(phase + 0.9 * p.phase - 0.35 * p.along)
    // A glint that travels round the photon ring.
    case 'ring':
      return glint(phase * 2 - p.along * 0.8)
    case 'bowl':
      return glint(phase - 0.7 * p.phase)
    // Each particle breathes on its own beat.
    case 'dust':
      return glint(phase * 2 + p.phase)
    default:
      return 0
  }
}

/** The palette step shown for `p` at cycle position `t` (null: the still frame). Never leaves 1..8, never goes dark. */
function stepAt(p: Lit, t: number | null): number {
  if (t === null) return p.level
  return clamp(Math.round(p.level + shimmer(p, t)), 1, 8)
}

const hex = (level: number) => PALETTE[clamp(level, 1, 8) - 1]!
const mono = (level: number) => MONO[Math.min(4, Math.ceil(level / 2))]!

/** One frame of one composition; `t` in [0, 1) is the point in the cycle, null the still frame. */
export function drawBlackHole(size: BhSize, t: number | null, isMono = false): BhSprite {
  const { W, H, px } = grid(size)
  const rows: BhSprite = []
  for (let r = 0; r < H / 2; r++) {
    const runs: BhRun[] = []
    const push = (text: string, fg?: string, bg?: string) => {
      // Only runs of empty space merge. Every coloured cell is its own run, so a frame's run list has the
      // same shape in every frame: a colour that changes never joins or splits its neighbours, and a
      // renderer comparing frames run by run sees exactly the cells that changed.
      const last = runs.at(-1)
      if (last && !fg && !bg && !last.fg && !last.bg) last.text += text
      else runs.push({ text, fg, bg })
    }
    for (let x = 0; x < W; x++) {
      const a = px[r * 2 * W + x] ?? null
      const b = px[(r * 2 + 1) * W + x] ?? null
      if (!a && !b) push(' ')
      else if (isMono) {
        const lv = Math.max(a ? stepAt(a, t) : 0, b ? stepAt(b, t) : 0)
        push(a && b ? mono(lv) : a ? '▀' : '▄')
      } else if (a && b) push('▀', hex(stepAt(a, t)), hex(stepAt(b, t)))
      else if (a) push('▀', hex(stepAt(a, t)))
      else push('▄', hex(stepAt(b!, t)))
    }
    rows.push(runs)
  }
  return rows
}

const cache = new Map<string, BhSprite[]>()

/** Every frame of a cycle for a size, computed once. */
export function frames(size: BhSize, isMono = false): BhSprite[] {
  const key = `${size}${isMono ? ':m' : ''}`
  let list = cache.get(key)
  if (!list) {
    list = Array.from({ length: FRAMES }, (_, f) => drawBlackHole(size, f / FRAMES, isMono))
    cache.set(key, list)
  }
  return list
}

const wrap1 = (x: number) => x - Math.floor(x)

/** The resting frame of each size, built once (reduced motion and animation off draw it on every render). */
const still = new Map<string, BhSprite>()

/** The frame to draw at `ms`; null is the still frame (idle, reduced motion). */
export function blackHole(ms: number | null, size: BhSize, speed: BhSpeed = 'slow', isMono = false): BhSprite {
  if (ms === null || !Number.isFinite(ms)) {
    const key = `${size}${isMono ? ':m' : ''}`
    let f = still.get(key)
    if (!f) still.set(key, (f = drawBlackHole(size, null, isMono)))
    return f
  }
  const f = Math.floor(wrap1(ms / CYCLE_MS[speed]) * FRAMES) % FRAMES
  return frames(size, isMono)[f]!
}

/** The sprite as plain text, one string a row. */
export function bhText(s: BhSprite): string[] {
  return s.map(r => r.map(x => x.text).join(''))
}

/** Which pixels are lit in a composition, as `x,y` keys: the silhouette. Tests compare it across frames. */
export function litPixels(size: BhSize): string[] {
  const { W, H, px } = grid(size)
  const out: string[] = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[y * W + x]) out.push(`${x},${y}`)
  return out
}

/** The pixels that must stay dark in every frame: the event horizon, except the rows the disk crosses it on. */
export function horizonPixels(size: BhSize): string[] {
  const { cols, rows } = DIMENSIONS[size]
  const W = cols
  const H = rows * 2
  const { cy } = geo(size)
  const out: string[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const X = REF.x0 + ((x + 0.5) / W) * REF.w
      const Y = REF.y0 + ((y + 0.5) / H) * REF.h
      if (edgeOf(X, Y, cy) < 1.05 && !isDiskRow(Y, size)) out.push(`${x},${y}`)
    }
  }
  return out
}

/** What each lit pixel is part of (`ring`, `dome`, `disk`, `bowl`, `dust`), keyed `x,y`. For tests. */
export function litKinds(size: BhSize): Record<string, string> {
  const { W, H, px } = grid(size)
  const out: Record<string, string> = {}
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = px[y * W + x]
    if (p) out[`${x},${y}`] = p.kind
  }
  return out
}
