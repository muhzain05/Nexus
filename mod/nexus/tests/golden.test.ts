import { expect, test } from 'claude-code/testing'

import { DIMENSIONS, PALETTE, bhText, drawBlackHole } from '../hooks/blackhole'
import type { BhSprite } from '../hooks/blackhole'
import { orbitLines } from '../hooks/orbitlayout'
import { FIXTURES, HOLE_SIZES } from './fixtures'
import agent_failed from './golden/agent-failed'
import compact_80 from './golden/compact-80'
import council_active from './golden/council-active'
import dashboard_100 from './golden/dashboard-100'
import dashboard_120 from './golden/dashboard-120'
import dashboard_60 from './golden/dashboard-60'
import dashboard_80 from './golden/dashboard-80'
import four_agents from './golden/four-agents'
import hole_large from './golden/hole-large'
import hole_medium from './golden/hole-medium'
import hole_small from './golden/hole-small'
import sonnet_idle from './golden/sonnet-idle'
import sonnet_waiting from './golden/sonnet-waiting'
import sonnet_working from './golden/sonnet-working'
import telemetry_full from './golden/telemetry-full'
import telemetry_minimal from './golden/telemetry-minimal'
import telemetry_standard from './golden/telemetry-standard'

// Golden screens: the exact characters of each fixture. A failure here means a screen changed.
// If the change is intended, run .github/scripts/update-goldens.sh and review the diff.
const GOLDEN: Record<string, string[]> = {
  'agent-failed': agent_failed,
  'compact-80': compact_80,
  'council-active': council_active,
  'dashboard-100': dashboard_100,
  'dashboard-120': dashboard_120,
  'dashboard-60': dashboard_60,
  'dashboard-80': dashboard_80,
  'four-agents': four_agents,
  'hole-large': hole_large,
  'hole-medium': hole_medium,
  'hole-small': hole_small,
  'sonnet-idle': sonnet_idle,
  'sonnet-waiting': sonnet_waiting,
  'sonnet-working': sonnet_working,
  'telemetry-full': telemetry_full,
  'telemetry-minimal': telemetry_minimal,
  'telemetry-standard': telemetry_standard,
}

function same(name: string, actual: string[]) {
  const want = GOLDEN[name]!
  const at = actual.findIndex((l, i) => l !== want[i])
  if (at >= 0 || actual.length !== want.length) {
    const i = at >= 0 ? at : Math.min(actual.length, want.length)
    throw new Error(`golden "${name}" differs at row ${i} (of ${want.length} expected, ${actual.length} drawn)\n  expected: ${JSON.stringify(want[i])}\n  drawn:    ${JSON.stringify(actual[i])}\nIf this is intended: sh .github/scripts/update-goldens.sh`)
  }
}

for (const f of FIXTURES) {
  test(`golden screen: ${f.name} (${f.width} columns)`, () => {
    const lines = orbitLines(f.state(), f.width)
    same(f.name, lines.map(l => l.map(g => g.t).join('')))
    // Every row is exactly as wide as the pane: no screen is ragged.
    for (const l of lines) expect([...l.map(g => g.t).join('')].length).toBe(f.width)
  })
}

const steps = (sprite: BhSprite): string[] => {
  const W = sprite[0]!.reduce((n, r) => n + r.text.length, 0)
  const rows: string[] = []
  sprite.forEach(runs => {
    let top = ''
    let bottom = ''
    for (const run of runs) {
      for (const ch of run.text) {
        const at = (hex?: string) => (hex ? String(PALETTE.indexOf(hex as (typeof PALETTE)[number]) + 1) : '.')
        top += ch === '▀' ? at(run.fg) : '.'
        bottom += ch === '▀' ? at(run.bg) : ch === '▄' ? at(run.fg) : '.'
      }
    }
    rows.push(top.padEnd(W, '.'), bottom.padEnd(W, '.'))
  })
  return rows
}

for (const size of HOLE_SIZES) {
  test(`golden black hole: ${size} resting frame, glyphs and colours`, () => {
    const sprite = drawBlackHole(size, null)
    same(`hole-${size}`, [...bhText(sprite), '--- palette steps, one row per pixel row ---', ...steps(sprite)])
    expect(DIMENSIONS[size].rows).toBe(sprite.length)
  })
}

test('the golden files are all used, and every fixture has one', () => {
  for (const f of FIXTURES) expect(GOLDEN[f.name]).toBeTruthy()
  for (const s of HOLE_SIZES) expect(GOLDEN[`hole-${s}`]).toBeTruthy()
  expect(Object.keys(GOLDEN).length).toBe(FIXTURES.length + HOLE_SIZES.length)
})

test('what each screen must show (so a golden is never a screen that hides the point)', () => {
  const text = (name: string, w: number) => orbitLines(FIXTURES.find(f => f.name === name)!.state(), w).map(l => l.map(g => g.t).join('')).join('\n')
  for (const w of [60, 80, 100, 120]) {
    const t = text(`dashboard-${w}`, w)
    for (const must of [/Lead session/, /sonnet 5\.5/, /effort/, /working 1m 12s/, /Subagents/, /audit#1/, /Usage/]) expect(t).toMatch(must)
  }
  expect(text('sonnet-idle', 100)).toMatch(/idle · 48 steps/)
  expect(text('sonnet-waiting', 100)).toMatch(/waiting for you/)
  expect(text('agent-failed', 80)).toMatch(/! test#1 failed: timed out/)
  expect(text('council-active', 100)).toMatch(/security\s+running 31s/)
  expect(text('council-active', 100)).toMatch(/performance\s+queued/)
  expect(text('four-agents', 80)).toMatch(/4 running\s+4 total/)
  for (const r of ['search#1', 'grep#1', 'audit#1', 'test#1']) expect(text('four-agents', 80)).toContain(r)
  expect(text('telemetry-minimal', 100)).not.toMatch(/Usage|Activity|context/)
  expect(text('telemetry-full', 100)).toMatch(/\$12\.99 est/)
})
