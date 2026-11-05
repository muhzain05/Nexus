import { expect, test } from 'claude-code/testing'

import { agentFlow, agentMark, councilMarks, flowOf } from '../hooks/flow'
import { agent, NOW, snap, withPrefs } from './snap'
import type { Fx } from '../types'

const on = withPrefs(['agentLinks', 'on'])
const fx = (kind: Fx['kind'], ref: string | null, ago: number, ms = 1600): Fx => ({ kind, at: NOW - ago, ms, ref })
const run = (over: Record<string, unknown> = {}) => ({ ...agent('a', 'nexus-test', 1, 'Run the tests', 'running', 2, 20, 5000), toolUseId: 'tu1', returnedAt: null, returnKind: null, ...over }) as ReturnType<typeof agent>
const mark = (a: ReturnType<typeof agent>, over = {}) => agentMark(agentFlow(snap(over, on), a))

test('flow: a run is linked to the lead only when its Agent call is known', () => {
  expect(mark(run()).glyph).toBe('▸')
  expect(mark(run({ toolUseId: null })).glyph).toBe(' ')
  expect(mark(run({ toolUseId: null })).tone).toBe('none')
})

test('flow: states and their marks: ✓ done, ◂ handed back, ✗ failed, ◌ cancelled', () => {
  expect(mark(run({ status: 'done' }))).toMatchObject({ glyph: '✓', tone: 'done' })
  expect(mark(run({ status: 'done', returnedAt: NOW - 100, returnKind: 'ok' }))).toMatchObject({ glyph: '◂', tone: 'back' })
  expect(mark(run({ status: 'failed' }))).toMatchObject({ glyph: '✗', tone: 'fail' })
  expect(mark(run({ status: 'cancelled' }))).toMatchObject({ glyph: '◌', tone: 'cancel' })
})

test('flow: a result that came back as an error is a failure, never a completion', () => {
  expect(mark(run({ status: 'done', returnedAt: NOW - 100, returnKind: 'error' }))).toMatchObject({ glyph: '✗', tone: 'fail' })
})

test('flow: a failure is never celebrated: no pulse on ✗ or ◌', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const m = mark(run({ status }), { fx: [fx('done', 'a', 100)] })
    expect(m.isPulse).toBe(false)
  }
})

test('flow: a finished run is never drawn as running: no ▸ after done, failed or cancelled', () => {
  for (const status of ['done', 'failed', 'cancelled'] as const) expect(mark(run({ status })).glyph).not.toBe('▸')
})

test('flow: a delegation pulse plays for its time, then settles', () => {
  const during = mark(run(), { fx: [fx('spawn', 'a', 300)] })
  expect(during).toMatchObject({ glyph: '▸', isPulse: true })
  expect(Math.abs(during.t! - 300 / 1600)).toBeLessThan(0.001)
  const after = mark(run(), { fx: [fx('spawn', 'a', 1700)] })
  expect(after).toMatchObject({ glyph: '▸', isPulse: false, t: null })
  // Another agent's event does not pulse this one.
  expect(mark(run(), { fx: [fx('spawn', 'other', 300)] }).isPulse).toBe(false)
})

test('flow: the return pulse needs the return to be recorded; a done event alone only pulses the ✓', () => {
  const back = mark(run({ status: 'done', returnedAt: NOW - 200, returnKind: 'ok' }), { fx: [fx('return', 'a', 200)] })
  expect(back).toMatchObject({ glyph: '◂', isPulse: true })
  const end = mark(run({ status: 'done' }), { fx: [fx('done', 'a', 200)] })
  expect(end).toMatchObject({ glyph: '✓', isPulse: true })
  // A return effect with no recorded return draws no ◂.
  expect(mark(run({ status: 'done' }), { fx: [fx('return', 'a', 200)] }).glyph).toBe('✓')
})

test('flow: a record from another session draws nothing, even mid-pulse', () => {
  const a = run({ session: 'old' })
  const s = snap({ session: 'new', fx: [fx('spawn', 'a', 100)] }, on)
  expect(agentFlow(s, a).isStale).toBe(true)
  expect(agentMark(agentFlow(s, a))).toMatchObject({ glyph: ' ', tone: 'none', isPulse: false })
  // The same record in its own session, and one whose session is unknown on either side, are drawn.
  expect(agentMark(agentFlow({ ...s, session: 'old' }, a)).glyph).toBe('▸')
  expect(agentMark(agentFlow({ ...s, session: null }, a)).glyph).toBe('▸')
  expect(agentMark(agentFlow(s, run())).glyph).toBe('▸')
})

test('flow: council marks follow the reviewers\' own records', () => {
  const s = snap({}, on)
  const r = s.council.reviewers
  r.security = { ...r.security, status: 'running' }
  r.architecture = { ...r.architecture, status: 'done' }
  r.performance = { ...r.performance, status: 'failed' }
  expect(councilMarks(s).map(m => m.glyph)).toEqual(['▸', '◂', '✗'])
  r.security = { ...r.security, status: 'queued' }
  r.architecture = { ...r.architecture, status: 'idle' }
  expect(councilMarks(s).map(m => m.tone)).toEqual(['idle', 'idle', 'fail'])
})

test('flow: council pulses come from the Council\'s own effects, per reviewer', () => {
  const s = snap({ fx: [fx('council-out', 'security', 100)] }, on)
  s.council.reviewers.security = { ...s.council.reviewers.security, status: 'running' }
  const m = councilMarks(s)
  expect(m[0]).toMatchObject({ glyph: '▸', isPulse: true })
  expect(m[1]!.isPulse).toBe(false)
})

test('flow: the advisor is one event: it pulses, with no direction, and only after a report', () => {
  expect(flowOf(snap({}, on)).advisorPulse).toBeNull()
  const f = flowOf(snap({ fx: [fx('advisor', null, 1000, 4800)] }, on))
  expect(Math.abs(f.advisorPulse! - 1000 / 4800)).toBeLessThan(0.001)
  expect(f.advisorCalls).toBe(3)
  expect(flowOf(snap({ fx: [fx('advisor', null, 6000, 4800)] }, on)).advisorPulse).toBeNull()
})

test('flow: Jev is an observation unless its routing is active and it reported acting', () => {
  const fxs = [fx('route', 'accepted', 100, 900)]
  expect(flowOf(snap({ fx: fxs }, on)).isJevApplied).toBe(false) // observe-only: never "applied"
  const active = snap({ fx: fxs }, on)
  active.jev = { ...active.jev, routing: 'active' }
  expect(flowOf(active).isJevApplied).toBe(true)
  const observed = snap({ fx: [fx('route', 'observed', 100, 900)] }, on)
  observed.jev = { ...observed.jev, routing: 'active' }
  expect(flowOf(observed).isJevApplied).toBe(false)
  expect(flowOf(observed).jevPulse).not.toBeNull()
})

test('flow: an abstention (route effect "fallback") gives no Jev pulse; observed, accepted and a Jev decision do', () => {
  const pulse = (...fxs: Fx[]) => flowOf(snap({ fx: fxs }, on)).jevPulse
  // The answer missed the bar and the lead decided: not a choice Jev made.
  expect(pulse(fx('route', 'fallback', 100, 900))).toBeNull()
  // Still an abstention however fresh, and however many; a stale one is not a pulse either.
  expect(pulse(fx('route', 'fallback', 0, 900), fx('route', 'fallback', 400, 900))).toBeNull()
  // A choice Jev made pulses, with the position in its own time.
  const observed = pulse(fx('route', 'observed', 300, 900))
  expect(observed).not.toBeNull()
  expect(Math.abs(observed! - 300 / 900)).toBeLessThan(0.001)
  expect(pulse(fx('route', 'accepted', 100, 900))).not.toBeNull()
  expect(pulse(fx('jev', null, 100, 900))).not.toBeNull()
  // An abstention next to a choice: the choice still pulses.
  expect(pulse(fx('route', 'fallback', 100, 900), fx('route', 'observed', 300, 900))).not.toBeNull()
  // A fallback never counts as applied either, even in active routing.
  const active = snap({ fx: [fx('route', 'fallback', 100, 900)] }, on)
  active.jev = { ...active.jev, routing: 'active' }
  expect(flowOf(active).isJevApplied).toBe(false)
})

test('flow: idle means quiet: no pulse of any kind without an event', () => {
  const s = snap({ fx: [], agents: [run({ status: 'done' })] }, on)
  const f = flowOf(s)
  expect([f.advisorPulse, f.jevPulse]).toEqual([null, null])
  expect(agentFlow(s, s.agents[0]!).pulse).toBeNull()
})

test('flow: the flow reads the records and changes nothing: the same snapshot gives the same flow', () => {
  const s = snap({ fx: [fx('spawn', 'a', 300)], agents: [run()] }, on)
  const before = JSON.stringify(s)
  expect(agentMark(agentFlow(s, s.agents[0]!))).toEqual(agentMark(agentFlow(s, s.agents[0]!)))
  expect(JSON.stringify(s)).toBe(before)
})
