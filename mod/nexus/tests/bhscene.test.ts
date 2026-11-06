import { expect, test } from 'claude-code/testing'

import { buildDots, CELL_ASPECT, DIMENSIONS, SAMPLING, SUPERSAMPLE } from '../hooks/blackhole'
import type { BhSize } from '../hooks/blackhole'
import { KINDS, renderScene, sceneFrame } from '../hooks/bhscene'
import { blur, sampleScene } from '../hooks/bhsample'

const SIZES: BhSize[] = ['small', 'medium', 'large']
const scene = (size: BhSize, ss = SUPERSAMPLE, aspect = CELL_ASPECT) => renderScene(size, DIMENSIONS[size].cols, DIMENSIONS[size].rows, aspect, ss)
const litSet = (d: { lv: Uint8Array }) => d.lv.reduce((n, v) => n + (v ? 1 : 0), 0)

test('the scene is drawn at the asked multiple of the dot grid, in two separate fields', () => {
  for (const size of SIZES) {
    for (const ss of [2, 4, 8]) {
      const s = scene(size, ss)
      const { cols, rows } = DIMENSIONS[size]
      expect(s.W).toBe(cols * 2)
      expect(s.H).toBe(rows * 4)
      expect(s.SW).toBe(cols * 2 * ss)
      expect(s.SH).toBe(rows * 4 * ss)
      for (const a of [s.cov, s.amp, s.along, s.ph]) expect(a.length).toBe(s.SW * s.SH)
      expect(s.kind.length).toBe(s.SW * s.SH)
    }
  }
  expect(SUPERSAMPLE).toBe(4)
})

test('coverage is thin light, not fill: a small share of the scene, and amplitude is only set where there is coverage', () => {
  for (const size of SIZES) {
    const s = scene(size)
    let covered = 0
    let ampWithoutCover = 0
    let maxCov = 0
    let maxAmp = 0
    for (let i = 0; i < s.cov.length; i++) {
      const c = s.cov[i]!
      if (c > 0.5) covered++
      if (c === 0 && s.amp[i]! !== 0) ampWithoutCover++
      if (c > maxCov) maxCov = c
      if (s.amp[i]! > maxAmp) maxAmp = s.amp[i]!
    }
    expect(maxCov).toBeLessThan(1.0001)
    expect(maxAmp).toBeLessThan(1.0001)
    // Under 8% of subpixels are more than half covered (a one-dot line is about a dot wide; the small picture is the densest).
    expect(covered / s.cov.length).toBeLessThan(0.08)
    expect(ampWithoutCover).toBe(0)
  }
})

test('nothing in the scene lights the event horizon, except the rows the disk crosses it on', () => {
  for (const size of SIZES) {
    const s = scene(size)
    let leaked = 0
    for (let v = 0; v < s.SH; v++) {
      const Y = (v + 0.5) / s.ss
      if (Math.abs(Math.floor(Y) - s.ax) <= s.band) continue
      for (let u = 0; u < s.SW; u++) {
        const X = ((u + 0.5) / s.ss) * s.K
        if (Math.hypot(X - s.cx, Y - s.cy) < s.R && s.cov[v * s.SW + u]! > 0) leaked++
      }
    }
    expect(leaked).toBe(0)
  }
})

test('sampling: which dots are lit does not depend on the glow, and the glow never adds a dot of its own', () => {
  for (const size of SIZES) {
    const s = scene(size)
    const none = sampleScene(s, { glow: 0, halo: 0 })
    const full = sampleScene(s, { glow: 2.6, halo: 0 })
    const huge = sampleScene(s, { glow: 40, halo: 0 })
    expect([...none.lv].map(v => (v ? 1 : 0))).toEqual([...full.lv].map(v => (v ? 1 : 0)))
    expect([...none.lv].map(v => (v ? 1 : 0))).toEqual([...huge.lv].map(v => (v ? 1 : 0)))
    // The glow only brightens: no dot is dimmer for it, and none gains more than 1.5 steps (the cap).
    let brighter = 0
    for (let i = 0; i < none.lv.length; i++) {
      if (!none.lv[i]) continue
      expect(full.lv[i]!).toBeGreaterThanOrEqual(none.lv[i]!)
      expect(full.lv[i]! - none.lv[i]!).toBeLessThan(3)
      if (full.lv[i]! > none.lv[i]!) brighter++
    }
    // ...and not every dot: glow is not a uniform brightening.
    expect(brighter).toBeGreaterThan(5)
    expect(brighter).toBeLessThan(litSet(full) * 0.7)
  }
})

test('the glow is blurred light with the horizon cut out: it conserves light and leaves the shadow dark', () => {
  const W = 21
  const H = 21
  const delta = new Float32Array(W * H)
  delta[10 * W + 10] = 1
  const b = blur(delta, W, H, 1.5, 1.5)
  expect(Math.abs(b.reduce((n, v) => n + v, 0) - 1)).toBeLessThan(0.01)
  expect(b[10 * W + 10]!).toBeGreaterThan(b[10 * W + 13]!)
  expect(b[10 * W + 13]!).toBeGreaterThan(b[10 * W + 18]!)
  // A flat field stays flat away from the edges.
  const flat = blur(new Float32Array(W * H).fill(0.5), W, H, 1.5, 1.5)
  expect(Math.abs(flat[10 * W + 10]! - 0.5)).toBeLessThan(0.01)
  // Even with a huge glow weight, no dot inside the horizon is lit.
  for (const size of SIZES) {
    const s = scene(size)
    const d = sampleScene(s, { glow: 40, halo: 1 })
    for (let y = 0; y < d.H; y++) {
      for (let x = 0; x < d.W; x++) {
        if (Math.hypot((x + 0.5) * s.K - s.cx, y + 0.5 - s.cy) < s.R && Math.abs(y - s.ax) > s.band) expect(d.lv[y * d.W + x]).toBe(0)
      }
    }
  }
})

test('the sparse halo, when asked for, is strictly bounded, dim, and never touches a lit dot', () => {
  for (const size of SIZES) {
    const s = scene(size)
    const base = sampleScene(s, { glow: SAMPLING.glow, halo: 0 })
    const withHalo = sampleScene(s, { glow: SAMPLING.glow, halo: 0.12 })
    const extra = litSet(withHalo) - litSet(base)
    expect(extra).toBeGreaterThanOrEqual(0)
    expect(extra).toBeLessThanOrEqual(Math.round(litSet(base) * 0.12))
    for (let y = 0; y < base.H; y++) {
      for (let x = 0; x < base.W; x++) {
        const i = y * base.W + x
        if (base.lv[i] || !withHalo.lv[i]) continue
        expect(withHalo.lv[i]).toBe(1)
        for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) expect(base.lv[(y + j) * base.W + x + k] ?? 0).toBe(0)
      }
    }
    // The shipped picture has no halo.
    expect(SAMPLING.halo).toBe(0)
  }
})

test('the dots are the same however finely the scene is drawn, to within a few edge dots', () => {
  for (const size of SIZES) {
    const at = (ss: number) => buildDots(size, CELL_ASPECT, { ss })
    const a = at(2)
    const b = at(4)
    const c = at(8)
    const differ = (x: { lv: Uint8Array }, y: { lv: Uint8Array }) => x.lv.reduce((n, v, i) => n + ((v ? 1 : 0) !== (y.lv[i] ? 1 : 0) ? 1 : 0), 0)
    // 4x is the default because it is within a handful of dots of 8x; 2x is not as steady.
    expect(differ(b, c)).toBeLessThan(litSet(c) * 0.04 + 2)
    expect(differ(a, c)).toBeLessThan(litSet(c) * 0.12 + 3)
  }
})

test('the dots are the same every time, and the picture is thin: no crowded dot, no doubled line', () => {
  for (const size of SIZES) {
    const a = buildDots(size)
    const b = buildDots(size)
    expect([...a.lv]).toEqual([...b.lv])
    const on = (x: number, y: number) => (x < 0 || y < 0 || x >= a.W || y >= a.H ? 0 : a.lv[y * a.W + x] ? 1 : 0)
    for (let y = 0; y < a.H; y++) {
      for (let x = 0; x < a.W; x++) {
        if (!on(x, y)) continue
        let n = 0
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) n += on(x + i, y + j)
        // A line (even a diagonal) touches two neighbours; the 2 x 2 particles and a junction a few more. Never a patch.
        expect(n).toBeLessThan(6)
      }
    }
  }
})

test('the thinning keeps particles whole and never breaks a line: every large 2 x 2 particle is four dots', () => {
  const d = buildDots('large')
  const dust = KINDS.indexOf('dust')
  let squares = 0
  for (let y = 0; y < d.H - 1; y++) {
    for (let x = 0; x < d.W - 1; x++) {
      if ([0, 1].every(j => [0, 1].every(i => d.lv[(y + j) * d.W + x + i] && d.kind[(y + j) * d.W + x + i] === dust))) squares++
    }
  }
  expect(squares).toBe(2)
  // The count of particle dots: 5 single dots and two squares.
  expect(d.kind.reduce((n, k, i) => n + (d.lv[i] && k === dust ? 1 : 0), 0)).toBe(13)
  for (const [size, n] of [['small', 3], ['medium', 5]] as const) {
    const s = buildDots(size)
    expect(s.kind.reduce((m, k, i) => m + (s.lv[i] && k === dust ? 1 : 0), 0)).toBe(n)
  }
})

test('brightness is distributed, not uniform: the top step is a minority, and the disk has highlights, not a plateau', () => {
  for (const size of SIZES) {
    const d = buildDots(size)
    const lit = [...d.lv].filter(Boolean)
    const share = (min: number) => lit.filter(v => v >= min).length / lit.length
    expect(share(6)).toBeLessThan(0.3)
    expect(share(5)).toBeLessThan(0.55)
    // Every step but the dimmest is used: a ramp, not two tones.
    expect(new Set(lit).size).toBeGreaterThanOrEqual(5)
    const disk = KINDS.indexOf('disk')
    const steps: number[] = []
    for (let y = 0; y < d.H; y++) for (let x = 0; x < d.W; x++) if (d.lv[y * d.W + x] && d.kind[y * d.W + x] === disk) steps.push(d.lv[y * d.W + x]!)
    const counts = new Map<number, number>()
    for (const v of steps) counts.set(v, (counts.get(v) ?? 0) + 1)
    expect(Math.max(...counts.values()) / steps.length).toBeLessThan(0.5)
    expect(counts.size).toBeGreaterThanOrEqual(4)
  }
})

test('the horizon stays a circle at another cell aspect: the scene is composed in physical units', () => {
  for (const size of SIZES) {
    for (const aspect of [0.45, 0.56]) {
      const f = sceneFrame(size, DIMENSIONS[size].cols, DIMENSIONS[size].rows, aspect)
      const d = buildDots(size, aspect)
      expect(f.K).toBe(2 * aspect)
      // A wider cell means fewer dots across the same physical width: the grid is the same, the shapes are not stretched.
      expect(d.W).toBe(DIMENSIONS[size].cols * 2)
      expect(litSet(d)).toBeGreaterThan(50)
      for (let y = 0; y < d.H; y++) for (let x = 0; x < d.W; x++) if (Math.hypot((x + 0.5) * f.K - f.cx, y + 0.5 - f.cy) < f.R && Math.abs(y - f.ax) > f.band) expect(d.lv[y * d.W + x]).toBe(0)
    }
  }
})
