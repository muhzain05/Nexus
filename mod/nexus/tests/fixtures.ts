// The named screens the golden tests pin. Deterministic: a fixed clock and fixed figures (see snap.ts).
import { agent, snap, withPrefs, NOW } from './snap'
import type { Fx } from '../types'
import { NEW_COUNCIL } from '../hooks/council'
import type { Snapshot } from '../hooks/views'

export type Fixture = { name: string; width: number; state: () => Snapshot }

const running4 = [
  agent('r1', 'nexus-search', 1, 'Map the repository and find the build and test commands', 'running', 7, 25, 38_000),
  agent('r2', 'nexus-grep', 1, 'Trace every call site of applyDiscount', 'running', 11, 25, 52_000),
  agent('r3', 'nexus-audit', 1, 'Check the working-tree change for bugs and missing tests', 'running', 4, 30, 19_000),
  agent('r4', 'nexus-test', 1, 'Run the unit tests for the pricing module', 'running', 2, 20, 9_000),
]

const BASE_FIXTURES: Fixture[] = [
  { name: 'dashboard-60', width: 60, state: () => snap() },
  { name: 'dashboard-80', width: 80, state: () => snap() },
  { name: 'dashboard-100', width: 100, state: () => snap() },
  { name: 'dashboard-120', width: 120, state: () => snap() },
  { name: 'sonnet-working', width: 100, state: () => snap() },
  { name: 'sonnet-idle', width: 100, state: () => snap({ lead: { ...snap().lead, turnStartedAt: null } }) },
  { name: 'sonnet-waiting', width: 100, state: () => snap({ lead: { ...snap().lead, isWaiting: true } }) },
  { name: 'agent-failed', width: 80, state: () => snap({ agents: [agent('f1', 'nexus-test', 1, 'Run the unit tests', 'failed', 6, 20, 41_000), agent('f2', 'nexus-grep', 1, 'Trace calculations', 'running', 9, 25, 12_000)] }) },
  { name: 'telemetry-minimal', width: 100, state: () => snap({}, withPrefs(['telemetry.preset', 'minimal'])) },
  { name: 'telemetry-standard', width: 100, state: () => snap({}, withPrefs(['telemetry.preset', 'standard'])) },
  { name: 'telemetry-full', width: 100, state: () => snap({}, withPrefs(['telemetry.preset', 'full'])) },
  {
    name: 'council-active',
    width: 100,
    state: () => {
      const s = snap()
      s.council.reviewers.security = { ...s.council.reviewers.security, status: 'running', startedAt: NOW - 31_000, endedAt: null, findings: null }
      s.council.reviewers.architecture = { ...s.council.reviewers.architecture, status: 'running', startedAt: NOW - 31_000, endedAt: null, findings: null }
      s.council.reviewers.performance = { ...s.council.reviewers.performance, status: 'queued', startedAt: null, endedAt: null, findings: null }
      return s
    },
  },
  { name: 'four-agents', width: 80, state: () => snap({ agents: running4 }) },
  { name: 'compact-80', width: 80, state: () => snap({}, withPrefs(['density', 'compact'])) },
]

// ---- the connections (Show agent connections: on). Every event time is relative to NOW, so every pulse frame is fixed.
const links = (...c: [string, string][]) => withPrefs(['agentLinks', 'on'], ...c)
const fx = (kind: Fx['kind'], ref: string | null, ago: number, ms = 1600): Fx => ({ kind, at: NOW - ago, ms, ref })
const given = (a: ReturnType<typeof agent>, toolUseId: string | null, extra: Partial<ReturnType<typeof agent>> = {}) => ({ ...a, toolUseId, returnedAt: null, returnKind: null, ...extra })
// Nothing has run: no agents, no reviewers, no events. The advisor has been used before, so its quiet line shows.
const idle = () => snap({ lead: { ...snap().lead, turnStartedAt: null }, agents: [], log: [], fx: [], council: JSON.parse(JSON.stringify(NEW_COUNCIL)) }, links())

const delegating = [
  given(agent('r1', 'nexus-search', 1, 'Map the repository and find the build and test commands', 'running', 7, 25, 38_000), 'tu1'),
  given(agent('r2', 'nexus-grep', 1, 'Trace every call site of applyDiscount', 'running', 11, 25, 52_000), 'tu2'),
  given(agent('r3', 'nexus-audit', 1, 'Check the working-tree change for bugs and missing tests', 'running', 4, 30, 19_000), 'tu3'),
  // No Agent call id was reported for this one: nothing is claimed about who launched it.
  given(agent('r4', 'nexus-test', 1, 'Run the unit tests for the pricing module', 'running', 2, 20, 9_000), null),
]

const councilRunning = () => {
  // The tape tells the same story as the panel below it: the advisor was consulted, one reviewer is done, one running, one queued.
  const log: Snapshot['log'] = [
    { at: NOW - 20_000, who: 'council', kind: 'done', text: 'architecture review · done · 1 finding', detail: '' },
    { at: NOW - 500, who: 'advisor', kind: 'advisor', text: 'consulted · opus 5.5', detail: '' },
    { at: NOW - 300, who: 'council', kind: 'start', text: 'security review started', detail: '' },
  ]
  const s = snap({ log, fx: [fx('council-out', 'security', 300), fx('advisor', null, 500, 4800)] }, links())
  s.council.reviewers.security = { ...s.council.reviewers.security, status: 'running', startedAt: NOW - 300, endedAt: null, findings: null }
  s.council.reviewers.architecture = { ...s.council.reviewers.architecture, status: 'done', findings: 1 }
  s.council.reviewers.performance = { ...s.council.reviewers.performance, status: 'queued', startedAt: null, endedAt: null, findings: null }
  return s
}

export const FLOW_FIXTURES: Fixture[] = [
  { name: 'flow-idle-84', width: 84, state: idle },
  { name: 'flow-idle-120', width: 120, state: idle },
  {
    name: 'flow-delegating-84',
    width: 84,
    state: () => snap({
      agents: delegating,
      fx: [fx('spawn', 'r3', 300), fx('spawn', 'r2', 1200)],
      log: [
        { at: NOW - 3000, who: 'search', kind: 'start', text: 'search#1 started', detail: 'Map the repository', ref: 'r1', flow: 'out' },
        { at: NOW - 1200, who: 'grep', kind: 'start', text: 'grep#1 started', detail: 'Trace call sites', ref: 'r2', flow: 'out' },
        { at: NOW - 300, who: 'audit', kind: 'start', text: 'audit#1 started', detail: 'Check the change', ref: 'r3', flow: 'out' },
        { at: NOW - 100, who: 'test', kind: 'start', text: 'test#1 started', detail: 'Run the pricing tests', ref: 'r4' },
      ],
    }, links()),
  },
  {
    name: 'flow-returned-100',
    width: 100,
    state: () => snap({
      agents: [
        given(agent('d1', 'nexus-search', 1, 'Map the repository', 'done', 9, 25, 30_000), 'tu1', { returnedAt: NOW - 3000, returnKind: 'ok' }),
        given(agent('d2', 'nexus-grep', 1, 'Trace the call graph', 'done', 12, 25, 22_000), 'tu2', { returnedAt: NOW - 400, returnKind: 'ok' }),
        given(agent('d3', 'nexus-audit', 1, 'Check the change for bugs', 'done', 14, 30, 41_000), 'tu3'),
        given(agent('d4', 'nexus-test', 1, 'Run the unit tests', 'failed', 6, 20, 41_000), 'tu4'),
        given(agent('d5', 'nexus-grep', 2, 'Find the discount rules', 'running', 3, 25, 6_000), 'tu5'),
      ],
      fx: [fx('return', 'd2', 400)],
      log: [
        { at: NOW - 3000, who: 'search', kind: 'info', text: 'search#1 result returned to the lead', detail: '', ref: 'd1', flow: 'back' },
        { at: NOW - 2000, who: 'test', kind: 'error', text: 'test#1 failed', detail: 'the run ended on an error', ref: 'd4' },
        { at: NOW - 400, who: 'grep', kind: 'info', text: 'grep#1 result returned to the lead', detail: '', ref: 'd2', flow: 'back' },
      ],
    }, links()),
  },
  { name: 'flow-council-120', width: 120, state: councilRunning },
  { name: 'flow-council-84', width: 84, state: councilRunning },
  { name: 'flow-jev-84', width: 84, state: () => snap({ fx: [fx('jev', 'which tool', 200, 900)] }, links()) },
  { name: 'flow-narrow-62', width: 62, state: () => snap({ agents: delegating, fx: [fx('spawn', 'r1', 200)] }, links()) },
  { name: 'flow-reduced-84', width: 84, state: () => snap({ agents: delegating, reduceMotion: true, fx: [fx('spawn', 'r3', 300)] }, links()) },
]

/** Every named screen: the ones from before connections existed (drawn with them off, byte for byte as then), and the connected ones. */
export const FIXTURES: Fixture[] = [...BASE_FIXTURES, ...FLOW_FIXTURES]

/** The black hole's resting frame of each size, as glyph rows and as palette-step rows (0 = dark). */
export const HOLE_SIZES = ['small', 'medium', 'large'] as const
