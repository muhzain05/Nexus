// From the scene to dots: the second stage of the black-hole picture. Pure.
//
// The scene (`bhscene.ts`) is a coverage field and a brightness field at several times the dot grid's resolution.
// This stage turns it into the terminal's own grid, in three steps that never feed each other the wrong way round:
//
//   occupancy   which dots exist. From coverage only: a dot is lit when a structure of light really passes through
//               it (enough of its area, and a strong core), and only if it is the best dot across the line, so a
//               line that falls between two dots lights one of them, never both. Averaging and thresholding would
//               erase thin lines; taking the maximum would thicken them. This does neither.
//   glow        how much light is around a dot. The brightness field (coverage x amplitude), blurred a little and
//               cut off at the event horizon, so the shadow never fills with light. It is never thresholded into
//               dots: glow only changes how bright an already-lit dot is.
//   brightness  one of six palette steps per lit dot, from its own amplitude plus a share of the glow around it.
//
// An optional halo (off in the shipped picture unless it earns its place) adds a strictly bounded number of dim
// dots where glow is strong and nothing is lit.
import { type DotKind, KINDS, type Scene, clamp, inHorizonDot } from './bhscene'

/** One composition's dots, row-major. `lv` 0 is dark, 1 to 6 a palette step; the rest say what a lit dot belongs to. */
export type Dots = { W: number; H: number; lv: Uint8Array; kind: Uint8Array; along: Float32Array; ph: Float32Array }

export type SampleOptions = {
  /** Palette steps the glow around a dot may add (0 turns glow off). */
  glow: number
  /** Extra dim dots in the glow, at most this fraction of the lit dots (0 for none). */
  halo: number
}

/** The four axes a line can be crossed on, by angle (0, 45, 90 and 135 degrees, y pointing down). */
const AXES: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1]]

/** A dot is lit when its coverage and its core are at least this strong. */
const MIN_MEAN = 0.38
const MIN_PEAK = 0.5
/** The glow's blur, in dots (one sigma). Small: light spreads a dot or two, not a cloud. */
const GLOW_SIGMA = 1.5

/** The gaussian weights for a blur of `sigma` dots, `radius` each way, normalised. */
function kernel(sigma: number, radius: number): Float32Array {
  const k = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) sum += k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum
  return k
}

/** A separable blur of a W x H field; `sx` and `sy` are the sigmas in dots across and down (a dot is wider than it is tall at some aspects). */
export function blur(src: Float32Array, W: number, H: number, sx: number, sy: number): Float32Array {
  const kx = kernel(sx, Math.max(1, Math.ceil(sx * 2.5)))
  const ky = kernel(sy, Math.max(1, Math.ceil(sy * 2.5)))
  const rx = (kx.length - 1) / 2
  const ry = (ky.length - 1) / 2
  const tmp = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0
    for (let i = -rx; i <= rx; i++) {
      const xx = x + i
      if (xx >= 0 && xx < W) a += src[y * W + xx]! * kx[i + rx]!
    }
    tmp[y * W + x] = a
  }
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0
    for (let j = -ry; j <= ry; j++) {
      const yy = y + j
      if (yy >= 0 && yy < H) a += tmp[yy * W + x]! * ky[j + ry]!
    }
    out[y * W + x] = a
  }
  return out
}

export function sampleScene(sc: Scene, opt: SampleOptions): Dots {
  const { W, H, ss, SW } = sc
  const n = W * H
  const mean = new Float32Array(n) // coverage averaged over the dot's area
  const peak = new Float32Array(n) // the strongest coverage in it
  const rad = new Float32Array(n) // brightness (coverage x amplitude) averaged over it
  const win = new Int32Array(n).fill(-1) // the subpixel with the strongest coverage

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0
      let sumRad = 0
      let best = 0
      let at = -1
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const k = (y * ss + j) * SW + x * ss + i
          const c = sc.cov[k]!
          if (c <= 0) continue
          sum += c
          sumRad += c * sc.amp[k]!
          if (c > best) {
            best = c
            at = k
          }
        }
      }
      const d = y * W + x
      mean[d] = sum / (ss * ss)
      rad[d] = sumRad / (ss * ss)
      peak[d] = best
      win[d] = at
    }
  }

  /** Inside the event horizon, off the rows the disk crosses it on: dark, whatever the scene says. */
  const isHorizon = (x: number, y: number) => inHorizonDot(sc, x, y)

  // Occupancy: the ridge of the coverage. The direction across a line is where the coverage curves down the most (the
  // Hessian's most negative direction); a dot is kept when it is stronger than the neighbour on one side of that
  // direction and at least as strong as the other, so a line that falls between two dots keeps exactly one of them.
  const m = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : mean[y * W + x]!)
  const lit = new Uint8Array(n)
  let count = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = y * W + x
      if (mean[d]! < MIN_MEAN || peak[d]! < MIN_PEAK || isHorizon(x, y)) continue
      const v = mean[d]!
      const a = m(x + 1, y) + m(x - 1, y) - 2 * v
      const c = m(x, y + 1) + m(x, y - 1) - 2 * v
      const b = (m(x + 1, y + 1) - m(x + 1, y - 1) - m(x - 1, y + 1) + m(x - 1, y - 1)) / 4
      // The eigenvector of the largest eigenvalue points along the line (or across it for a point); across is 90 degrees on.
      const along = 0.5 * Math.atan2(2 * b, a - c)
      const across = (((along + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI // 0..pi, y pointing down
      const q = Math.round(across / (Math.PI / 4)) % 4
      const [dx, dy] = AXES[q]!
      if (v > m(x - dx, y - dy) && v >= m(x + dx, y + dy)) {
        lit[d] = 1
        count++
      }
    }
  }

  // Thinning: where a line still ended up two dots across (a line that crosses between rows or columns while it
  // slopes), take the extra dots away without breaking the line. Zhang-Suen: remove a dot only if it has between two
  // and six lit neighbours and removing it leaves its neighbours connected. A dotted line (single dots with gaps) and
  // the ends of a line are never touched, and particles are left alone.
  const dust = KINDS.indexOf('dust')
  const body = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : lit[y * W + x]! && sc.kind[win[y * W + x]!] !== dust ? 1 : 0)
  for (let changed = true, guard = 0; changed && guard < 8; guard++) {
    changed = false
    for (const step of [0, 1]) {
      const doomed: number[] = []
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!body(x, y)) continue
          const p = [body(x, y - 1), body(x + 1, y - 1), body(x + 1, y), body(x + 1, y + 1), body(x, y + 1), body(x - 1, y + 1), body(x - 1, y), body(x - 1, y - 1)]
          const b = p.reduce((q, v) => q + v, 0)
          if (b < 2 || b > 6) continue
          let a = 0
          for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) a++
          if (a !== 1) continue
          const [n, , e, , so, , w] = p as [number, number, number, number, number, number, number, number]
          if (step === 0 ? n * e * so === 0 && e * so * w === 0 : n * e * w === 0 && n * so * w === 0) doomed.push(y * W + x)
        }
      }
      for (const d of doomed) lit[d] = 0
      if (doomed.length) changed = true
    }
  }
  count = lit.reduce((q, v) => q + v, 0)

  // Glow: the brightness field, blurred, with the horizon cut out.
  const glow = opt.glow > 0 || opt.halo > 0 ? blur(rad, W, H, GLOW_SIGMA / sc.K, GLOW_SIGMA) : new Float32Array(n)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isHorizon(x, y)) glow[y * W + x] = 0

  const out: Dots = { W, H, lv: new Uint8Array(n), kind: new Uint8Array(n), along: new Float32Array(n), ph: new Float32Array(n) }
  for (let d = 0; d < n; d++) {
    if (!lit[d]) continue
    const k = win[d]!
    // The glow's share grows faster than the glow does: dots in strong light gain a step, dots in weak light do not.
    const g = glow[d]!
    out.lv[d] = clamp(Math.round(sc.amp[k]! * 6.2 + Math.min(1.5, opt.glow * g * (0.35 + 2.2 * g))), 1, 6)
    out.kind[d] = sc.kind[k]!
    out.along[d] = sc.along[k]!
    out.ph[d] = sc.ph[k]!
  }

  // The halo: a bounded number of the dimmest dots, in the strongest glow where nothing is lit and no lit dot touches.
  if (opt.halo > 0) {
    const cap = Math.round(count * opt.halo)
    const cand: { d: number; g: number }[] = []
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const d = y * W + x
        if (lit[d] || isHorizon(x, y) || glow[d]! < 0.12) continue
        let touching = false
        for (let j = -1; j <= 1 && !touching; j++) for (let i = -1; i <= 1; i++) if (lit[d + j * W + i]) touching = true
        if (!touching) cand.push({ d, g: glow[d]! })
      }
    }
    cand.sort((a, b) => b.g - a.g || a.d - b.d)
    const taken: number[] = []
    for (const c of cand) {
      if (taken.length >= cap) break
      const cxd = c.d % W
      const cyd = Math.floor(c.d / W)
      // Apart from every other halo dot, so the halo is points of light and never a smear.
      if (taken.some(t => Math.abs((t % W) - cxd) < 3 && Math.abs(Math.floor(t / W) - cyd) < 3)) continue
      taken.push(c.d)
      out.lv[c.d] = 1
      out.kind[c.d] = KINDS.indexOf('dust' as DotKind)
      out.along[c.d] = 0
      out.ph[c.d] = (c.d * 0.6180339887) % 1
    }
  }
  return out
}
