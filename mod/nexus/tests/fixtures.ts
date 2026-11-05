// The named screens the golden tests pin. Deterministic: a fixed clock and fixed figures (see snap.ts).
import { agent, snap, withPrefs, NOW } from './snap'
import type { Snapshot } from '../hooks/views'

export type Fixture = { name: string; width: number; state: () => Snapshot }

const running4 = [
  agent('r1', 'nexus-search', 1, 'Map the repository and find the build and test commands', 'running', 7, 25, 38_000),
  agent('r2', 'nexus-grep', 1, 'Trace every call site of applyDiscount', 'running', 11, 25, 52_000),
  agent('r3', 'nexus-audit', 1, 'Check the working-tree change for bugs and missing tests', 'running', 4, 30, 19_000),
  agent('r4', 'nexus-test', 1, 'Run the unit tests for the pricing module', 'running', 2, 20, 9_000),
]

export const FIXTURES: Fixture[] = [
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

/** The black hole's resting frame of each size, as glyph rows and as palette-step rows (0 = dark). */
export const HOLE_SIZES = ['small', 'medium', 'large'] as const
