// Orbit's lead graphic: a pixel-art black hole in terminal cells. Pure.
//
// What it is. A small, deliberately shaped picture, drawn in square pixels: a dark event horizon
// with a thin inner arc, a dome of layered orange light above it (the far side of the disk, bent
// over the top by gravity), a thin tapering accretion disk that crosses the horizon's lower edge,
// a faint bowl of lensed light under it, and a few isolated particles. It is lopsided on purpose:
// the left of the disk is the hotter side, the dome is far brighter than the bowl.
//
// How it is drawn. A cell is about twice as tall as it is wide, so a half block (`▀` `▄`) is a
// square pixel: the top pixel is the glyph's colour, the bottom pixel is its background. Dark
// areas (the horizon, the sky) are cells with no colour at all, never a dark colour, so a terminal
// without colour still shows the horizon as empty. The palette is eight steps whose colours are
// exact xterm-256 entries, so a 256-colour terminal shows the same picture as a true-colour one.
//
// Three compositions (small, medium, large) are tuned separately, not one picture scaled: the
// small one keeps the horizon, the thin disk and the dome; the large one adds contour bands and
// disk streaks.
//
// How it moves. Which pixels are lit never changes, so the silhouette and the horizon are fixed.
// Only the brightness of lit pixels moves, by at most one palette step: a slow warm wave along
// the disk, a slower ripple through the dome, and a gentle twinkle of the particles. A cycle is
// 24 seconds (36 on `veryslow`) and its last frame is the first frame's neighbour, so it loops
// without a seam.

export type BhSize = 'small' | 'medium' | 'large'
export type BhRun = { text: string; fg?: string; bg?: string }
export type BhSprite = BhRun[][]

/** Cycle length per speed setting (ms). */
export const CYCLE_MS = { slow: 24_000, veryslow: 36_000 } as const
export type BhSpeed = keyof typeof CYCLE_MS
/** Distinct frames per cycle (2.5 a second at `slow`): what the pane redraws at, no faster. */
export const FRAMES = 60

/** Dark red to amber. Each is an exact xterm-256 colour (52, 88, 124, 166, 172, 208, 214, 221). */
export const PALETTE = ['#5f0000', '#870000', '#af0000', '#d75f00', '#d78700', '#ff8700', '#ffaf00', '#ffd75f'] as const

/** Cells (columns × rows) of each composition. A pixel grid is `cols` wide and `rows * 2` tall. */
export const DIMENSIONS: Record<BhSize, { cols: number; rows: number }> = {
  small: { cols: 30, rows: 7 },
  medium: { cols: 44, rows: 10 },
  large: { cols: 64, rows: 14 },
}

/** Per-composition tuning: how much texture, how many contour steps, how many particles. */
const TUNE: Record<BhSize, { texture: number; bands: number; particles: number; bowl: boolean; photon: boolean }> = {
  small: { texture: 0, bands: 2, particles: 3, bowl: false, photon: false },
  medium: { texture: 0.45, bands: 3, particles: 6, bowl: true, photon: true },
  large: { texture: 0.8, bands: 4, particles: 10, bowl: true, photon: true },
}

/** The glyph set when colour is not available: shades by brightness, half blocks for the brightest. */
const MONO = [' ', '░', '▒', '▓', '█'] as const

/** The size that fits `cols` columns and `rows` rows, or null when none does (then there is no picture). */
export function sizeFor(cols: number, rows: number): BhSize | null {
  for (const s of ['large', 'medium', 'small'] as const) if (cols >= DIMENSIONS[s].cols && rows >= DIMENSIONS[s].rows) return s
  return null
}

// ---- the picture, in a reference space -----------------------------------------------------
// The picture is composed on a 620 × 274 canvas (disk tip to tip, dome top to bowl bottom) and
// sampled at the pixel grid, so the three sizes share proportions but not pixels.
const REF = { w: 620, h: 274, x0: 35, y0: 118 }
const CX = 340 // the horizon's centre
const AXIS = 268 // the disk's own centre line
const HORIZON = { cy: 290, rx: 100, ry: 125 }

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

type Kind = 'dome' | 'disk' | 'bowl' | 'arc' | 'dust'
/** One lit pixel: its brightness step (1 to 8), what part of the picture it belongs to, and where along it. */
type Lit = { level: number; kind: Kind; along: number; phase: number }

/** Dome height above the disk's axis at horizontal position t (-1..1): tall in the middle, long tails. */
const domeHeight = (t: number) => 146 * Math.exp(-((Math.abs(t) / 0.58) ** 2.2)) + 7 * (1 - Math.abs(t)) ** 2

/** A few isolated particles, in reference space, placed by hand: not on any curve, not evenly spread. */
const DUST: { x: number; y: number; level: number }[] = [
  { x: 112, y: 150, level: 6 }, { x: 590, y: 160, level: 4 }, { x: 70, y: 262, level: 3 }, { x: 628, y: 292, level: 7 },
  { x: 205, y: 372, level: 5 }, { x: 498, y: 355, level: 3 }, { x: 288, y: 128, level: 3 }, { x: 560, y: 120, level: 8 },
  { x: 150, y: 330, level: 4 }, { x: 410, y: 384, level: 2 },
]

/** The lit pixel at reference position (X, Y), or null for sky and for the horizon. */
function sample(X: number, Y: number, size: BhSize): Lit | null {
  const tune = TUNE[size]
  const dx = X - CX
  const t = dx / 315
  // E is 1 on the horizon's edge, below 1 inside it. Only the upper half is a dome; below the
  // centre line the horizon is closed by the disk's near edge.
  const E = Y <= HORIZON.cy + 1 ? Math.hypot(dx / HORIZON.rx, (Y - HORIZON.cy) / HORIZON.ry) : 9
  if (E < 1.05) {
    // The event horizon and the thin dark outline round it stay unlit. One dim arc inside it, the
    // photon ring, is the only thing drawn there.
    if (tune.photon && E > 0.64 && E < 0.74 && Y < HORIZON.cy - 8) return { level: 2, kind: 'arc', along: t, phase: 0 }
    return null
  }

  // The dome: the far side of the disk, lifted over the horizon. A thin bright rim hugs the
  // outline; beyond it a body of layered red and orange, brightest as a band, hotter on the left.
  const envelope = AXIS - domeHeight(t)
  const floor = AXIS - 8
  if (Y >= envelope && Y <= floor && Math.abs(t) < 1) {
    const rimTop = Math.abs(dx) < HORIZON.rx * 1.2 ? HORIZON.cy - HORIZON.ry * 1.2 * Math.sqrt(1 - (dx / (HORIZON.rx * 1.2)) ** 2) : floor
    const s = clamp((Y - envelope) / Math.max(1, Math.min(floor, rimTop) - envelope), 0, 1) // 0 outer edge .. 1 at the rim
    const glow = Math.sin(Math.PI * s ** 0.9)
    const bands = Math.sin(2 * Math.PI * (tune.bands * 0.55 * s + 0.45 * t)) * (0.55 + 0.5 * tune.texture)
    const hot = 1.1 * smooth(-0.1, -0.55, t) * (1 - s * 0.6) + 0.4 * smooth(0.15, 0.5, t) * smooth(0.95, 0.4, t)
    const grain = (hash(Math.round(X / 9), Math.round(Y / 9), 1) - 0.5) * tune.texture * 0.6
    // The body is never dark: a red floor everywhere, an orange band through the middle.
    let level = 2.2 + 1.9 * glow + 0.9 * bands + 0.8 * hot + grain
    level *= 0.72 + 0.28 * smooth(1, 0.5, Math.abs(t))
    if (s < 0.07) level -= 1.4
    if (E < 1.17) level = 4.2 + 0.9 * smooth(0.2, -0.5, t) + 0.4 * (E < 1.1 ? 1 : 0) // the rim itself
    const lv = Math.round(level)
    if (lv >= 1) return { level: clamp(lv, 1, 7), kind: 'dome', along: t, phase: s }
    return null
  }

  // The disk: thin, widest a little left of centre, tapering to points; it crosses the horizon's
  // lower edge as a flat band and is hidden behind the horizon above that.
  const lens = 1 - Math.abs(t) ** 1.15
  const top = AXIS - 31 * lens - 2
  const bottom = AXIS + 29 * (1 - Math.abs(t) ** 1.7) + 2
  const half = (bottom - top) / 2
  if (Math.abs(t) <= 1 && Y >= top && Y <= bottom) {
    const front = Math.abs(dx) < HORIZON.rx + 12
    if (E < 1.17 || (front && Y < HORIZON.cy - 3)) return null
    const along = Math.abs(t)
    const core = smooth(0.95, 0.35, along)
    const streak = Math.sin(2 * Math.PI * (7 * t + (0.9 * (Y - AXIS)) / Math.max(8, half))) * 0.55 * tune.texture
    const grain = (hash(Math.round(X / 8), Math.round(Y / 8), 2) - 0.5) * tune.texture * 0.9
    const lean = 1 + 0.55 * smooth(-0.1, -0.5, t) // the left side is the hot one
    const edge = 1 - Math.abs((Y - (top + bottom) / 2) / (half + 1)) ** 2
    let level = (2.2 + 3.4 * core * lean) * (0.6 + 0.4 * edge) + streak + grain
    if (front) level = 2.2 + 0.6 * edge + grain * 0.5 // under the horizon it is a dim flat band
    const lv = Math.round(level)
    if (lv >= 1) return { level: clamp(lv, 1, 8), kind: 'disk', along: t, phase: (Y - top) / (bottom - top) }
    return null
  }

  // The bowl: lensed light under the horizon, flat and understated, a gap below the disk, two or
  // three stripes that follow the curve.
  if (tune.bowl && Y > AXIS + 46) {
    const e = Math.hypot(dx / 116, (Y - 312) / 66)
    if (e <= 1 && e >= 0.3 && Math.abs(dx) < 118) {
      const bandPos = (e - 0.3) / 0.7
      const stripe = Math.sin(2 * Math.PI * (tune.bands * 0.5 * bandPos + 0.2))
      const fade = smooth(1, 0.82, e) * smooth(0.3, 0.46, e) * smooth(0.98, 0.7, Math.abs(t) * 2.6)
      const lean = 1 + 0.25 * smooth(0, -0.4, t)
      let level = (2.1 + 1.7 * stripe + 1.2 * (1 - Math.abs(bandPos - 0.55) * 2)) * fade * lean
      if (hash(Math.round(X / 5), Math.round(Y / 5), 3) < 0.12 * tune.texture) level -= 1
      const lv = Math.round(level)
      if (lv >= 1) return { level: clamp(lv, 1, 6), kind: 'bowl', along: t, phase: bandPos }
    }
  }
  return null
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
      px[y * W + x] = sample(REF.x0 + ((x + 0.5) / W) * REF.w, REF.y0 + ((y + 0.5) / H) * REF.h, size)
    }
  }
  // The disk's near edge always shows under the horizon as a flat band at least one pixel tall, so
  // the horizon is never open at the bottom whatever the grid's size.
  // The first row whose centre is below the horizon's last row.
  const bandY = Math.ceil(((HORIZON.cy + 2 - REF.y0) / REF.h) * H - 0.5)
  for (let x = 0; x < W; x++) {
    const dx = REF.x0 + ((x + 0.5) / W) * REF.w - CX
    if (Math.abs(dx) < HORIZON.rx + 14 && bandY >= 0 && bandY < H && !px[bandY * W + x]) px[bandY * W + x] = { level: 3, kind: 'disk', along: dx / 315, phase: 0.9 }
  }
  // Isolated particles go on last, only on dark pixels and never next to anything lit.
  const n = TUNE[size].particles
  const taken = (x: number, y: number) => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (px[(y + j) * W + x + i]) return true
    return false
  }
  DUST.slice(0, n).forEach((d, k) => {
    const x = Math.round(((d.x - REF.x0) / REF.w) * W - 0.5)
    const y = Math.round(((d.y - REF.y0) / REF.h) * H - 0.5)
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || taken(x, y)) return
    px[y * W + x] = { level: d.level, kind: 'dust', along: x / W, phase: hash(x, y, 7 + k) }
  })
  g = { W, H, px }
  gridCache.set(size, g)
  return g
}

/** How much brighter or dimmer (in palette steps, never more than one) a lit pixel is at `phase`. */
function shimmer(p: Lit, phase: number): number {
  const TAU = Math.PI * 2
  switch (p.kind) {
    // A slow warm wave along the disk, twice round the picture a cycle: the flow of hot material.
    case 'disk':
      return 0.9 * Math.sin(TAU * (p.along - phase * 2 + 0.12 * p.phase))
    // A slower ripple moving through the dome's bands.
    case 'dome':
      return 0.75 * Math.sin(TAU * (phase + 0.9 * p.phase - 0.35 * p.along))
    case 'bowl':
      return 0.55 * Math.sin(TAU * (phase - 0.7 * p.phase))
    // Each particle breathes on its own beat.
    case 'dust':
      return 0.9 * Math.sin(TAU * (phase * 2 + p.phase))
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
      const last = runs.at(-1)
      if (last && last.fg === fg && last.bg === bg) last.text += text
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

/** The pixels that must stay dark in every frame: the event horizon and its outline, except the one dim arc inside it. */
export function horizonPixels(size: BhSize): string[] {
  const { cols, rows } = DIMENSIONS[size]
  const W = cols
  const H = rows * 2
  const out: string[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const X = REF.x0 + ((x + 0.5) / W) * REF.w
      const Y = REF.y0 + ((y + 0.5) / H) * REF.h
      const E = Y <= HORIZON.cy + 1 ? Math.hypot((X - CX) / HORIZON.rx, (Y - HORIZON.cy) / HORIZON.ry) : 9
      const isArc = E > 0.64 && E < 0.74 && Y < HORIZON.cy - 8
      if (E < 1.05 && !isArc) out.push(`${x},${y}`)
    }
  }
  return out
}

/** What each lit pixel is part of (`dome`, `disk`, `bowl`, `arc`, `dust`), keyed `x,y`. For tests. */
export function litKinds(size: BhSize): Record<string, string> {
  const { W, H, px } = grid(size)
  const out: Record<string, string> = {}
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = px[y * W + x]
    if (p) out[`${x},${y}`] = p.kind
  }
  return out
}
