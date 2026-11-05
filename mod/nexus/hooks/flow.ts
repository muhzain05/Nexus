// Orbit's orchestration flow: what the connections between the lead and everything else may show.
//
// Pure, and derived from records NEXUS already keeps (the agent list, the Council, the advisor, Jev's
// effects). Nothing here is stored, so there is no second lifecycle to drift from the first, no timer,
// and the tape and the connections cannot disagree: they read the same records.
//
// The rule that shapes it: a connection is drawn only for a relationship the data proves.
//   - lead → subagent: the Agent call's tool_use_id equals the spawn's (stored as agent.toolUseId).
//   - subagent → lead: the Agent tool's result was handed back (agent.returnedAt), or, for a background
//     run, the engine's completion notice arrived. "Handed back" never means "the model read it".
//   - lead → advisor: the advisor is the lead's own server tool; the call is reported once, when it ends,
//     so a consultation is one event, not a request and a reply.
//   - lead → Council reviewer: the reviewer record, launched and settled through the Agent call.
//   - Jev: an observation of a choice. It is never drawn as a handoff to anyone.
// Whatever cannot be proven (a timeout, nesting, which action an advisor's reply shaped, whether the model
// consumed a result) is not drawn at all.
import type { NexusAgent } from '../types'
import { ROLES } from './council'
import type { Snapshot } from './views'
import { phase } from './views'

/** How a mark reads. The renderer picks colours; this only says what is true. */
export type Tone = 'none' | 'idle' | 'out' | 'back' | 'done' | 'fail' | 'cancel'

export type Mark = {
  glyph: string
  tone: Tone
  /** A short pulse is playing (a real event just happened); false when it has settled. */
  isPulse: boolean
  /** 0..1 through the pulse, when one plays. */
  t: number | null
}

const NONE: Mark = { glyph: ' ', tone: 'none', isPulse: false, t: null }

/** What the data proves about one subagent's connection to the lead. */
export type AgentFlow = {
  id: string
  /** A record made in another session: it draws no connection and no pulse. */
  isStale: boolean
  /** The Agent call that launched it is known (tool_use_id on both ends). */
  isDelegated: boolean
  status: NexusAgent['status']
  /** Its result was handed back to the lead: normally, or as an error. */
  returned: 'ok' | 'error' | null
  pulse: { kind: 'out' | 'end' | 'back'; t: number } | null
}

export function agentFlow(s: Snapshot, a: NexusAgent): AgentFlow {
  const isStale = !!a.session && !!s.session && a.session !== s.session
  let pulse: AgentFlow['pulse'] = null
  if (!isStale) {
    const back = phase(s, 'return', a.id)
    const end = phase(s, 'done', a.id)
    const out = phase(s, 'spawn', a.id)
    // The newest event wins; a settled link shows its state, not an effect.
    if (back !== null) pulse = { kind: 'back', t: back }
    else if (end !== null) pulse = { kind: 'end', t: end }
    else if (out !== null) pulse = { kind: 'out', t: out }
  }
  return {
    id: a.id,
    isStale,
    isDelegated: a.toolUseId !== null && a.toolUseId !== undefined,
    status: a.status,
    returned: a.returnKind ?? null,
    pulse,
  }
}

/**
 * The mark beside a subagent row.
 *   ▸ running, and given its task by a known Agent call     ✓ finished, result not (yet) handed back
 *   ◂ its result was handed back to the lead                ✗ failed (never celebrated)   ◌ cancelled
 * A run with no known delegation, or from another session, gets no mark: nothing is claimed.
 */
export function agentMark(f: AgentFlow): Mark {
  if (f.isStale) return NONE
  const t = f.pulse?.t ?? null
  const isPulse = f.pulse !== null
  if (f.status === 'failed' || f.returned === 'error') return { glyph: '✗', tone: 'fail', isPulse: false, t: null }
  if (f.status === 'cancelled') return { glyph: '◌', tone: 'cancel', isPulse: false, t: null }
  if (f.returned === 'ok') return { glyph: '◂', tone: 'back', isPulse: f.pulse?.kind === 'back', t: f.pulse?.kind === 'back' ? t : null }
  if (f.status === 'done') return { glyph: '✓', tone: 'done', isPulse: f.pulse?.kind === 'end', t: f.pulse?.kind === 'end' ? t : null }
  // Running.
  if (!f.isDelegated) return NONE
  return { glyph: '▸', tone: 'out', isPulse: f.pulse?.kind === 'out' && isPulse, t: f.pulse?.kind === 'out' ? t : null }
}

/** The Council reviewers' marks, in the Council's order; from their records only. */
export function councilMarks(s: Snapshot): Mark[] {
  return ROLES.map(r => {
    const x = s.council.reviewers[r]
    const out = phase(s, 'council-out', r)
    const back = phase(s, 'council-back', r)
    const fail = phase(s, 'council-fail', r)
    switch (x.status) {
      case 'running':
        return { glyph: '▸', tone: 'out', isPulse: out !== null, t: out }
      case 'done':
        // done is set when the lead was handed the reviewer's result (or its completion notice).
        return { glyph: '◂', tone: 'back', isPulse: back !== null, t: back }
      case 'failed':
      case 'incomplete':
      case 'stale':
        return { glyph: '✗', tone: 'fail', isPulse: fail !== null, t: fail }
      default:
        return { glyph: '─', tone: 'idle', isPulse: false, t: null }
    }
  })
}

export type Flow = {
  /** The advisor was consulted at least once this session. */
  advisorCalls: number
  /** 0..1 while a consultation was just reported; one event, so no direction. */
  advisorPulse: number | null
  /** Jev answered a question just now, and whether the routing is allowed to act on it. */
  jevPulse: number | null
  isJevApplied: boolean
  /** Any reviewer or subagent running: the lead is waiting on work. */
  isWorkerRunning: boolean
}

export function flowOf(s: Snapshot): Flow {
  const jevPulse = phase(s, 'jev') ?? phase(s, 'route')
  // Applied only when the routing reported it acted ('accepted'), which only happens in active routing.
  const isJevApplied = s.fx.some(f => f.kind === 'route' && f.ref === 'accepted' && s.now - f.at >= 0 && s.now - f.at < f.ms) && s.jev.routing === 'active'
  return {
    advisorCalls: s.advisor.calls,
    advisorPulse: phase(s, 'advisor'),
    jevPulse,
    isJevApplied,
    isWorkerRunning: s.agents.some(a => a.status === 'running') || ROLES.some(r => s.council.reviewers[r].status === 'running'),
  }
}
