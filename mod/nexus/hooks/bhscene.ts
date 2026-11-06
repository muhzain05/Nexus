// The black hole as a scene: thin curves drawn at a higher resolution than the terminal has. Pure.
//
// This is the first stage of the picture. It knows nothing about Braille, colours or terminals: it only says, at
// `ss` times the resolution of the dot grid, where a structure of light is (`cov`, 0 to 1: a thin soft line, beaded
// along its length) and how bright that structure is there (`amp`, 0 to 1). Coverage and brightness are two fields
// on purpose: what is lit is decided from coverage, how brightly from amplitude, so brightness can never ask for
// more dots. The next stage (`bhsample.ts`) samples the scene down to the dot grid.
//
// Why a higher resolution. Drawing a curve straight onto the dot grid rounds every point to the nearest dot, so a
// line is always where the grid is, never where the curve is, and nothing records how near a dot a curve passed.
// Drawn at 4x and sampled back, a curve lights the dot it passes through the middle of and tells how well it did.
//
// Geometry is composed in physical units (a dot is 1 tall and `2 * aspect` wide) so the horizon is a circle at any
// cell aspect. The picture has a dark event horizon that nothing may light, a thin accretion disk that crosses it a
// little below its centre and is slightly warped, a ring of light on the horizon's upper edge, arcs that peel off
// that ring on the left and drift away, one asymmetric lensed arc over the top, a few separate dim fragments of the
// same ring below the disk, and a handful of particles.

export const KINDS = ['ring', 'bowl', 'shoulder', 'arc', 'disk', 'dust'] as const
export type DotKind = (typeof KINDS)[number]
export type SceneSize = 'small' | 'medium' | 'large'

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const frac = (x: number) => x - Math.floor(x)

/** The few particles, placed by hand: [x from the horizon's centre in units of the picture's height, y as a fraction of it, brightness step]. */
const PARTICLES: readonly (readonly [number, number, number])[] = [
  [-0.626, 0.228, 5], [0.798, 0.146, 6], [0.566, 0.797, 5], [-0.99, 0.751, 4], [0.915, 0.442, 3], [-0.84, 0.385, 3], [-0.61, 0.84, 3],
]
const PARTICLE_COUNT: Record<SceneSize, number> = { small: 3, medium: 5, large: 7 }

/**
 * What each composition is made of, in dots (a dot is 1 tall). The three are designed apart, not scaled: the small one
 * has no shoulder, one short lower fragment and a nearly flat disk, so it stays legible in 60 x 28 dots.
 */
export const TUNE: Record<SceneSize, {
  /** The disk's warp: how far it rises in the middle, and how much lower its right end sits than its left (dots). */
  bulge: number
  tilt: number
  /** Rows either side of the disk's row where the horizon may be lit (the disk crosses it, warped). */
  band: number
  /** Arcs that peel off the ring on the left shoulder and drift away from it: radius gap at the start and end (dots), angle span (in pi), how much of their length is lit, brightness. */
  peel: { g0: number; g1: number; t0: number; t1: number; occ: number; lv: number }[]
  /** The pieces of the lower circle that are drawn, as ranges of its length. The rest is dark. */
  lower: [number, number][]
  swell: boolean
}> = {
  small: { bulge: 0.9, tilt: 0.5, band: 2, peel: [], lower: [[0.1, 0.4]], swell: false },
  medium: { bulge: 1.4, tilt: 0.8, band: 2, peel: [{ g0: 2.1, g1: 6.5, t0: 1.08, t1: 1.46, occ: 0.78, lv: 4.5 }, { g0: 3.6, g1: 9, t0: 1.18, t1: 1.34, occ: 0.5, lv: 3.5 }], lower: [[0.08, 0.32], [0.62, 0.84]], swell: true },
  large: { bulge: 1.8, tilt: 1.0, band: 3, peel: [{ g0: 2.3, g1: 8.5, t0: 1.07, t1: 1.55, occ: 0.8, lv: 4.7 }, { g0: 3.9, g1: 13, t0: 1.17, t1: 1.4, occ: 0.5, lv: 3.6 }], lower: [[0.06, 0.3], [0.43, 0.56], [0.7, 0.88]], swell: true },
}

/** The horizon's place, in the picture's physical units. */
/** Whether the dot (x, y) lies inside the event horizon, off the rows the disk crosses it on: dark, whatever the scene says. */
export const inHorizonDot = (f: { K: number; cx: number; cy: number; R: number; ax: number; band: number }, x: number, y: number) =>
  Math.hypot((x + 0.5) * f.K - f.cx, y + 0.5 - f.cy) < f.R && Math.abs(y - f.ax) > f.band

export function sceneFrame(size: SceneSize, cols: number, rows: number, aspect: number) {
  const W = cols * 2
  const H = rows * 4
  const K = 2 * aspect
  const Wp = W * K
  const cy = 0.569 * H
  const ax = Math.round(0.61 * H) // the disk's row (a dot row)
  return { W, H, K, Wp, cx: Wp / 2, cy, R: 0.325 * H, ax, axc: ax + 0.5, band: TUNE[size].band }
}

export type Scene = {
  W: number
  H: number
  K: number
  /** Subpixels per dot, each way. */
  ss: number
  SW: number
  SH: number
  /** Coverage 0..1 of a structure of light, and its brightness 0..1 there; which structure, and where along it. */
  cov: Float32Array
  amp: Float32Array
  kind: Uint8Array
  along: Float32Array
  ph: Float32Array
  cx: number
  cy: number
  R: number
  ax: number
  band: number
}

/** Length of one bead and one gap together along a curve, in dots. Long enough that a gap is at least a whole dot, or the dots would run together. */
const PITCH = 3.2

/** A line's half-width (its Gaussian sigma), in dots: thin enough that a line one dot across never reaches a third dot. */
const SIGMA = 0.42

export function renderScene(size: SceneSize, cols: number, rows: number, aspect: number, ss: number): Scene {
  const { W, H, K, Wp, cx, cy, R, ax, axc, band } = sceneFrame(size, cols, rows, aspect)
  const tune = TUNE[size]
  const SW = W * ss
  const SH = H * ss
  const n = SW * SH
  const sc: Scene = { W, H, K, ss, SW, SH, cov: new Float32Array(n), amp: new Float32Array(n), kind: new Uint8Array(n), along: new Float32Array(n), ph: new Float32Array(n), cx, cy, R, ax, band }
  const huge = size === 'large'
  const half = Math.min(1.12 * H, Wp / 2 - K)

  /** Add a soft round point of coverage `c` and brightness `a` at physical (X, Y); a stronger coverage wins a subpixel. */
  const splat = (X: number, Y: number, c: number, a: number, kind: DotKind, along: number, ph: number, sg = SIGMA) => {
    if (c < 0.02) return
    const reach = 2.4 * sg
    const u0 = Math.max(0, Math.floor(((X - reach) / K) * ss))
    const u1 = Math.min(SW - 1, Math.ceil(((X + reach) / K) * ss))
    const v0 = Math.max(0, Math.floor((Y - reach) * ss))
    const v1 = Math.min(SH - 1, Math.ceil((Y + reach) * ss))
    const k = KINDS.indexOf(kind)
    for (let v = v0; v <= v1; v++) {
      const Yv = (v + 0.5) / ss
      const dy = Yv - Y
      const inBand = Math.abs(Math.floor(Yv) - ax) <= band
      for (let u = u0; u <= u1; u++) {
        const Xu = ((u + 0.5) / ss) * K
        const dx = Xu - X
        const r2 = dx * dx + dy * dy
        if (r2 > reach * reach) continue
        // The event horizon is dark: nothing is lit inside it, except where the disk crosses it.
        if (!inBand && Math.hypot(Xu - cx, Yv - cy) < R) continue
        const val = c * Math.exp(-r2 / (2 * sg * sg))
        const i = v * SW + u
        if (val <= sc.cov[i]!) continue
        sc.cov[i] = val
        sc.amp[i] = clamp(a, 0, 1)
        sc.kind[i] = k
        sc.along[i] = along
        sc.ph[i] = ph
      }
    }
  }

  /** The bead pattern along a curve: 1 on a bead, 0 between, soft edges. `duty` is how much of the length is lit; at 0.97 or more the curve is solid. */
  const bead = (L: number, duty: number, pitch: number, shift: number) => {
    if (duty >= 0.97) return 1
    if (duty <= 0.02) return 0
    const phi = L / pitch + 0.16 * Math.sin(L * 0.31 + shift * 7) + shift
    const c0 = Math.cos(Math.PI * duty)
    return smooth(c0 - 0.2, c0 + 0.2, Math.cos(2 * Math.PI * phi))
  }
  /** Whole stretches of a curve switched off at fixed, uneven places: 1 keeps the curve, `low` is what a gap still keeps. */
  const gate = (s: number, parts: number, keep: number, shift: number, low = 0.1) => (frac(Math.floor(s * parts) * 0.6180339887 + shift) < keep ? 1 : low)

  /** A curve in physical units, drawn as thin soft light, beaded and gated. `amp` is its brightness (0..1) along it. */
  const stroke = (f: (s: number) => [number, number], steps: number, amp: (s: number) => number, duty: (s: number) => number, gateAt: (s: number) => number, kind: DotKind, ph: number, shift: number, pitch = PITCH) => {
    let L = 0
    let px = Number.NaN
    let py = Number.NaN
    for (let k = 0; k <= steps; k++) {
      const s = k / steps
      const [X, Y] = f(s)
      if (k > 0) L += Math.hypot(X - px, Y - py)
      px = X
      py = Y
      splat(X, Y, bead(L, duty(s), pitch, shift) * gateAt(s), amp(s), kind, s, ph)
    }
  }

  /** The disk's centre line at physical x: rises a little in the middle (lensed over the horizon), and is lower on the right than on the left. */
  const diskY = (X: number) => {
    const dx = X - cx
    return axc - tune.bulge * Math.exp(-((dx / (1.15 * R)) ** 2)) + tune.tilt * (dx / half)
  }
  const dRow = axc - cy

  // The ring: the light hugging the horizon, over the top. It is not a border: bright and nearly continuous on the
  // left shoulder, then broken into dashes with uneven gaps, thinning and dimming to the right.
  const rr = R + 1.6
  const a0 = Math.PI - Math.asin(Math.min(0.98, dRow / rr))
  const a1 = 2 * Math.PI + Math.asin(Math.min(0.98, dRow / rr))
  stroke(
    s => { const a = a0 + s * (a1 - a0); return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] },
    2400,
    s => (5.7 - 2.5 * s ** 0.7 + 0.7 * Math.exp(-((s / 0.1) ** 2))) / 6.2,
    s => (s < 0.3 ? 0.86 - 0.2 * s : 0.72 - 0.34 * smooth(0.3, 1, s)),
    s => (s < 0.3 ? 1 : gate(s, 11, 0.82, 0.27, 0.22)),
    'ring', 0.2, 0.1,
  )

  // The lower light: a few separate short arcs of the same circle, much dimmer, never a closed circle.
  const rl = R + 2.2
  const la = Math.asin(Math.min(0.95, (ax + band + 1 - cy) / rl))
  for (const [s0, s1] of tune.lower) {
    stroke(
      s => { const a = la + (s0 + s * (s1 - s0)) * (Math.PI - 2 * la); return [cx + rl * Math.cos(a), cy + (rl + 0.6 * Math.sin(s * 3 + s0 * 9)) * Math.sin(a)] },
      900,
      s => (1.7 + 1.1 * (1 - s) * (1 - s0)) / 6.2,
      s => 0.62 * Math.sin(Math.PI * Math.min(1, 0.15 + 0.85 * s)) ** 0.6,
      () => 1,
      'bowl', s0, 0.8 + s0,
    )
  }

  // Shoulder: arcs that peel off the ring on its upper left and drift outward, brightest where they hug it (the
  // bent inner region), thinning as they leave. They diverge from the ring and from each other: they are not concentric.
  for (const [i, p] of tune.peel.entries()) {
    stroke(
      s => { const a = Math.PI * (p.t0 + (p.t1 - p.t0) * s); const r = rr + p.g0 + (p.g1 - p.g0) * s ** 1.5; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] },
      1800,
      s => (p.lv + 0.6 - 2 * s) / 6.2,
      s => p.occ * (1 - 0.88 * s ** 1.1),
      s => gate(s, 12, 0.78, 0.4 + i * 0.2, 0.15),
      'shoulder', i, 0.3 + i * 0.3,
    )
  }

  // The lensed arc: it leaves the disk's left end low, climbs slowly, is bent and brightest at its inner left side,
  // peaks right of centre and falls away faster. A wobble keeps it from being any ellipse. Thin and discontinuous.
  const xl = cx - 1.0 * H
  const xr = cx + 0.82 * H
  const hmax = ax - 0.05 * H
  const bump = (u: number) => u ** 1.9 * (1 - u) ** 1.15
  const bmax = bump(1.9 / 3.05)
  stroke(
    s => {
      const X = xl + s * (xr - xl)
      return [X, diskY(X) - 0.5 - hmax * (bump(s) / bmax) * (1 + 0.07 * Math.sin(Math.PI * 2 * (1.3 * s + 0.2)))]
    },
    3200,
    s => (2.1 + 3.5 * Math.exp(-(((s - 0.33) / 0.24) ** 2)) + 0.5 * Math.sin(Math.PI * s) - 0.5 * smooth(0.6, 1, s)) / 6.2,
    s => 0.2 + 0.58 * Math.sin(Math.PI * Math.min(1, s ** 0.85)),
    s => gate(s, 18, 0.8, 0.13, 0.2),
    'arc', 1, 0.45,
  )

  // The disk: one line, tapering to its tips, warped by diskY; brightness gathers in a hot spot left of the horizon
  // and a smaller one right of it. It swells to three rows only beside the horizon, and sparsely.
  for (let u = 0; u < SW; u++) {
    const X = ((u + 0.5) / ss) * K
    const dx = X - cx
    const t = Math.abs(dx) / half
    if (t > 1) continue
    const left = dx < 0
    const near = smooth(0.55, 0, Math.abs(Math.abs(dx) - R * 1.02) / R) // 1 close to either edge of the horizon
    const duty = (t < 0.66 ? 1 : 0.96 * (1 - t) + 0.04) * (t > 0.5 && !left ? 0.88 : 1)
    const hot = 1.3 * Math.exp(-(((dx + 0.95 * R) / (0.55 * R)) ** 2)) + 0.6 * Math.exp(-(((dx - 0.75 * R) / (0.45 * R)) ** 2))
    // Brighter, never denser: a higher floor, a bright centre, and a few bright beads along it.
    const spark = 1.2 * Math.max(0, Math.sin((2 * Math.PI * dx) / 11.5 + 1.3)) ** 6
    const lvl = 2.2 + 2 * (1 - t) ** 0.8 + hot + 0.6 * Math.exp(-((dx / (0.4 * R)) ** 2)) + spark * (1 - t)
    const along = dx / half
    const Y0 = diskY(X)
    const rows: [number, number, number, number][] = [[0, bead(dx, duty, PITCH, 0.21), lvl, 0.5]]
    if (tune.swell) {
      rows.push([-1, bead(dx, 0.55 * near * (left ? 1 : 0.6) + 0.12 * smooth(0.4, 0, t), PITCH, 0.55), lvl - 1, 0.1])
      rows.push([1, bead(dx, 0.36 * near * (left ? 0.9 : 0.5) + 0.06 * smooth(0.3, 0, t), PITCH, 0.77), lvl - 1.6, 0.9])
    }
    for (const [off, c, lv, ph] of rows) {
      if (c < 0.02) continue
      const Yc = Y0 + off
      const vlo = Math.max(0, Math.floor((Yc - 1.2) * ss))
      const vhi = Math.min(SH - 1, Math.ceil((Yc + 1.2) * ss))
      for (let v = vlo; v <= vhi; v++) {
        const Yv = (v + 0.5) / ss
        // The horizon is dark here too: the disk's own rows may cross it, its soft edges may not spill into it.
        if (Math.abs(Math.floor(Yv) - ax) > band && Math.hypot(X - cx, Yv - cy) < R) continue
        const dy = Yv - Yc
        const val = c * Math.exp(-(dy * dy) / (2 * SIGMA * SIGMA))
        const i = v * SW + u
        if (val <= sc.cov[i]!) continue
        sc.cov[i] = val
        sc.amp[i] = clamp(lv / 6.2, 0, 1)
        sc.kind[i] = KINDS.indexOf('disk')
        sc.along[i] = along
        sc.ph[i] = ph
      }
    }
  }

  // Particles: a few single points, the brightest two of the large picture a little larger (2 x 2).
  PARTICLES.slice(0, PARTICLE_COUNT[size]).forEach(([px, py, lv], i) => {
    // On the middle of a dot, so a particle is one dot (or one 2 x 2 square), never straddling two.
    const X = (Math.floor((cx + px * H) / K) + 0.5) * K
    const Y = Math.floor(py * H) + 0.5
    const ph = frac(i * 0.6180339887 + 0.37)
    const at = (x: number, y: number, step: number) => splat(x, y, 1, step / 6.2, 'dust', px, ph, 0.5)
    at(X, Y, lv + 1)
    if (huge && i < 2) {
      at(X + K, Y, lv)
      at(X, Y + 1, lv)
      at(X + K, Y + 1, lv - 1)
    }
  })
  return sc
}
