// Orchestration flow, through the test engine: the records NEXUS keeps of which agent was given which task
// and when its result came back (tool_use_id, returnedAt, returnKind, session), the log rows and effects
// that go with them, and the timer that must stop once nothing moves. Mocked engine events, not a live run.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const pane = (bodyColumns = 100) =>
  ({ plugin: 'nexus', component: 'Pane', requestId: 'nexus', surface: 'terminal', props: { title: 'NEXUS', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 46 }, view: {} } }) as const

type World = {
  /** The id the next agent.spawn answers with; otherwise agent-1, agent-2, ... */
  nextId: string | null
  /** What the Agent tool answers with (the engine's own result). */
  result: (e: any) => any
  session: string
  ticks: number
  /** The latest value written to each of the mod's own state keys: what the pane reads. */
  state: Record<string, any>
  clock: { now: () => number }
}
let w: World

function engine(on: On, prefs: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: 2_000_000 })
  w = { nextId: null, result: () => ({ result: { status: 'completed', totalTokens: 1200 } }), session: 'sess-A', ticks: 0, state: {}, clock }
  // Every frame writes the tick: counting those writes counts frames. Every write is also kept, so a test can read the records.
  on('state.set', ($, e: any, next) => {
    // A declared value is written as { shape, value }.
    if (e.plugin === 'nexus') w.state[String(e.key)] = e.value && typeof e.value === 'object' && 'shape' in e.value ? e.value.value : e.value
    if (e.key === 'tick') w.ticks++
    return next(e)
  })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on, { prefs: { version: 4, theme: 'orbit', agentLinks: true, ...prefs } })
  on('settings.read', () => ({ value: { advisorModel: 'opus' } }))
  on('session.id', () => ({ value: w.session }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.surface', () => ({ value: null }) as any)
  on('config.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 44, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => {
    throw new Error('no agent definition here')
  })
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as any)
  on('session.end', () => ({ sessionId: 's' }) as any)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e: any) => ({ text: e.text, context: e.context ?? [] }) as any)
  let n = 0
  on('agent.spawn', (_, e) => {
    const id = w.nextId ?? `agent-${++n}`
    w.nextId = null
    return { model: e.subagentType.startsWith('nexus-') ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', agentId: id }
  })
  on('classic.SubagentStop', () => ({}))
  on('tool.call', (_, e: any) => (e.tool === 'Agent' ? (w.result(e) as any) : ({ result: { ok: true } } as any)))
  return clock
}

const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

/** An agent.spawn as the engine raises it. `id` makes the engine answer with that agent id. */
function spawn($: any, subagentType: string, description: string, tool_use_id: string | undefined, id?: string) {
  if (id) w.nextId = id
  return $.agent.spawn({ ...(tool_use_id === undefined ? {} : { tool_use_id }), prompt: `${description}\nmore detail`, description, subagentType, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-sonnet-5-5', background: false, fork: false })
}
/** The lead's Agent call finishing: the result comes back through the tool.call chain. */
const agentCall = ($: any, tool_use_id: string, subagent_type = 'nexus-search') => $.tool.call({ tool: 'Agent', tool_use_id, prompt: 'x', description: 'd', subagent_type } as any)
const stop = ($: any, id: string, type = 'nexus-search') => $.classic.SubagentStop({ agent_id: id, agent_type: type, stop_hook_active: false, agent_transcript_path: '' })
const turnEnd = ($: any, agentId: string, reason: string, isAborted = false) => $.turn.complete({ turnId: `t-${agentId}-${reason}`, answer: '', durationMs: 1, isAborted, reason, agentId })
const notice = ($: any, id: string, status: string, origin = 'task-notification', text?: string) =>
  $.prompt.submit({ text: text ?? `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<result>x</result>\n</task-notification>`, origin: { kind: origin }, isMeta: true, wait: false } as any)
const run = async ($: any, args: string): Promise<string> => ((await ($ as any).command.run({ command: 'nexus', args })).text ?? '') as string

// What the mod's own records say, read the way the pane reads them.
const agentsOf = async (_$: any): Promise<any[]> => (w.state.agents ?? []) as any[]
const logOf = async (_$: any): Promise<any[]> => (w.state.log ?? []) as any[]
const fxOf = async (_$: any): Promise<any[]> => (w.state.fx ?? []) as any[]
const one = async ($: any, id: string) => (await agentsOf($)).find(a => a.id === id)

/** The shown text of a node: its own text, else its children's, joined. */
function shown(n: any): string {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  if (typeof n.text === 'string' && n.text) return n.text
  return (Array.isArray(n.children) ? n.children : []).map(shown).join('')
}
async function texts($: any, width = 100): Promise<string[]> {
  const ui = await $.ui.mount(pane(width))
  const rows = (await ui.findAll({ type: 'Text' })).map(shown)
  await ui.unmount()
  return rows
}
/** The pane's Subagents row for one label ("search#1 ... 3 turns ..."), or '' when none is drawn. */
async function rowOf($: any, label: string): Promise<string> {
  return (await texts($)).find(t => t.includes(label) && /turns/.test(t)) ?? ''
}
const MARKS = /[▸◂]/

// ---- EVENTS -------------------------------------------------------------------------------------

test('flow: a delegation is recorded with its tool_use_id and a flow out row that points at the agent', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  const a = await one($, 'agent-1')
  expect(a).toMatchObject({ id: 'agent-1', type: 'nexus-search', status: 'running', toolUseId: 'tu1', returnedAt: null, returnKind: null, session: 'sess-A' })
  const rows = (await logOf($)).filter(r => r.ref === 'agent-1')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'start', flow: 'out', ref: 'agent-1', who: 'search' })
  expect((await fxOf($)).some(f => f.kind === 'spawn' && f.ref === 'agent-1')).toBe(true)
})

test('flow: a spawn without a tool_use_id has no flow row: the delegation is not proven', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', undefined)
  const a = await one($, 'agent-1')
  expect(a.toolUseId).toBeNull()
  const row = (await logOf($)).find(r => r.ref === 'agent-1')
  expect(row).toBeTruthy()
  expect(row.kind).toBe('start')
  expect('flow' in row).toBe(false)
})

test('flow: done by SubagentStop, then a late turn.complete with reason error: failed, and the log shows it', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await clock.advance(3000)
  await stop($, 'agent-1')
  const done = await one($, 'agent-1')
  expect(done.status).toBe('done')
  await clock.advance(2000)
  await turnEnd($, 'agent-1', 'error')
  const a = await one($, 'agent-1')
  expect(a.status).toBe('failed')
  expect(a.reason).toBe('the run ended on an error')
  // The end time stays where the stop put it: the correction does not move it.
  expect(a.endedAt).toBe(done.endedAt)
  const failure = (await logOf($)).filter(r => r.ref === 'agent-1' && r.kind === 'error')
  expect(failure).toHaveLength(1)
  expect(failure[0].text).toBe('search#1 failed')
  expect(failure[0].detail).toBe('the run ended on an error')
})

test('flow: done then a late refusal is failed, and done then a late abort is cancelled', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-grep', 'finds x', 'tu1')
  await spawn($, 'nexus-audit', 'checks y', 'tu2')
  await stop($, 'agent-1', 'nexus-grep')
  await stop($, 'agent-2', 'nexus-audit')
  await turnEnd($, 'agent-1', 'refusal')
  await turnEnd($, 'agent-2', 'aborted', true)
  expect((await one($, 'agent-1')).status).toBe('failed')
  expect((await one($, 'agent-1')).reason).toBe('the model refused')
  expect((await one($, 'agent-2')).status).toBe('cancelled')
  expect((await one($, 'agent-2')).reason).toBe('interrupted')
})

test('flow: a failed or cancelled agent never changes again, and a SubagentStop does not reopen it', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-grep', 'finds x', 'tu1')
  await spawn($, 'nexus-audit', 'reviews y', 'tu2')
  await turnEnd($, 'agent-1', 'error')
  await turnEnd($, 'agent-2', 'aborted', true)
  const before = JSON.stringify([await agentsOf($), await logOf($)])
  await stop($, 'agent-1', 'nexus-grep')
  await stop($, 'agent-2', 'nexus-audit')
  // Nor does a different late verdict turn one into the other.
  await turnEnd($, 'agent-1', 'aborted', true)
  await turnEnd($, 'agent-2', 'error')
  await turnEnd($, 'agent-1', 'refusal')
  expect(JSON.stringify([await agentsOf($), await logOf($)])).toBe(before)
  expect((await one($, 'agent-1')).status).toBe('failed')
  expect((await one($, 'agent-2')).status).toBe('cancelled')
})

test('flow: a done agent is not changed by a later normal turn end; nothing goes back to running', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1')
  await stop($, 'agent-1')
  const before = JSON.stringify([await agentsOf($), await logOf($)])
  await turnEnd($, 'agent-1', 'answer')
  await stop($, 'agent-1')
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts', agentId: 'agent-1' })
  expect((await one($, 'agent-1')).status).toBe('done')
  // Only the tool's own bookkeeping (a count, a recent line) may move; nothing reopens it.
  expect((await one($, 'agent-1')).endedAt).not.toBeNull()
  expect((await logOf($)).length).toBe(JSON.parse(before)[1].length)
})

test('flow: the same spawn arriving twice does not reset a finished agent', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', agentId: 'agent-1' })
  await clock.advance(4000)
  await stop($, 'agent-1')
  await agentCall($, 'tu1')
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  expect((await one($, 'agent-1')).status).toBe('done')
  // The identical spawn again, and one for the same agent with no tool_use_id at all.
  await spawn($, 'nexus-search', 'maps the api', 'tu1', 'agent-1')
  await spawn($, 'nexus-search', 'maps the api', undefined, 'agent-1')
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
  const a = await one($, 'agent-1')
  expect(a.status).toBe('done')
  expect(a.tools).toBe(1)
  expect(a.returnKind).toBe('ok')
  expect(await agentsOf($)).toHaveLength(1)
})

test('flow: a spawn with a new tool_use_id for the same agent id replaces the record', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await stop($, 'agent-1')
  await agentCall($, 'tu1')
  expect((await one($, 'agent-1')).returnKind).toBe('ok')
  await clock.advance(5000)
  await spawn($, 'nexus-search', 'maps the ui', 'tu2', 'agent-1')
  const list = await agentsOf($)
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ id: 'agent-1', status: 'running', toolUseId: 'tu2', description: 'maps the ui', returnedAt: null, returnKind: null, steps: 0, tools: 0, endedAt: null })
  // The new delegation has its own flow out row.
  expect((await logOf($)).filter(r => r.flow === 'out' && r.ref === 'agent-1')).toHaveLength(2)
  // And its result is matched to it, not to the first call.
  await agentCall($, 'tu1')
  expect((await one($, 'agent-1')).returnedAt).toBeNull()
  await agentCall($, 'tu2')
  expect((await one($, 'agent-1')).returnKind).toBe('ok')
})

test('flow: a foreground Agent result marks the agent returned once, with a return effect and a flow back row', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await clock.advance(3000)
  await agentCall($, 'tu1')
  const at = w.clock.now()
  const a = await one($, 'agent-1')
  expect(a).toMatchObject({ returnedAt: at, returnKind: 'ok', reportedTokens: 1200 })
  const back = (await logOf($)).filter(r => r.flow === 'back')
  expect(back).toHaveLength(1)
  expect(back[0]).toMatchObject({ ref: 'agent-1', kind: 'info', who: 'search', text: 'search#1 result returned to the lead' })
  const returns = (await fxOf($)).filter(f => f.kind === 'return')
  expect(returns).toHaveLength(1)
  expect(returns[0].ref).toBe('agent-1')
  // A second identical result does nothing: still once.
  await clock.advance(2000)
  await agentCall($, 'tu1')
  expect((await one($, 'agent-1')).returnedAt).toBe(at)
  expect((await logOf($)).filter(r => r.flow === 'back')).toHaveLength(1)
  expect((await fxOf($)).filter(f => f.kind === 'return')).toHaveLength(1)
})

test('flow: an async_launched result hands nothing back yet: not returned, no return effect, no back row', async ($, on) => {
  engine(on)
  await start($)
  w.result = () => ({ result: { status: 'async_launched', agentId: 'agent-1', description: 'd', prompt: 'x', outputFile: '/tmp/agent-1.output' } })
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await agentCall($, 'tu1')
  const a = await one($, 'agent-1')
  expect(a.returnedAt).toBeNull()
  expect(a.returnKind).toBeNull()
  expect((await logOf($)).some(r => r.flow === 'back')).toBe(false)
  expect((await fxOf($)).some(f => f.kind === 'return')).toBe(false)
  // The engine's completion notice is what shows it came back.
  await notice($, 'agent-1', 'completed')
  expect((await one($, 'agent-1')).returnKind).toBe('ok')
})

test('flow: an Agent result with isError records returnKind error and an error log row', async ($, on) => {
  engine(on)
  await start($)
  w.result = () => ({ result: { status: 'completed', totalTokens: 10 }, isError: true })
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await agentCall($, 'tu1')
  const a = await one($, 'agent-1')
  expect(a.returnKind).toBe('error')
  expect(a.returnedAt).not.toBeNull()
  const back = (await logOf($)).filter(r => r.flow === 'back')
  expect(back).toHaveLength(1)
  expect(back[0]).toMatchObject({ kind: 'error', ref: 'agent-1', text: 'search#1 result came back as an error' })
  expect((await fxOf($)).filter(f => f.kind === 'return')).toHaveLength(1)
})

test('flow: a task-notification marks a background agent returned once; failed and killed come back as errors', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'a', 'tu1')
  await spawn($, 'nexus-grep', 'b', 'tu2')
  await spawn($, 'nexus-audit', 'c', 'tu3')
  await notice($, 'agent-1', 'completed')
  await notice($, 'agent-2', 'failed')
  await notice($, 'agent-3', 'killed')
  const at = (await one($, 'agent-1')).returnedAt
  expect(at).not.toBeNull()
  expect((await one($, 'agent-1')).returnKind).toBe('ok')
  expect((await one($, 'agent-2')).returnKind).toBe('error')
  expect((await one($, 'agent-3')).returnKind).toBe('error')
  const back = (await logOf($)).filter(r => r.flow === 'back')
  expect(back.map(r => [r.ref, r.kind])).toEqual([['agent-1', 'info'], ['agent-2', 'error'], ['agent-3', 'error']])
  // The same notice again: once only.
  await clock.advance(1000)
  await notice($, 'agent-1', 'completed')
  await notice($, 'agent-2', 'completed')
  expect((await one($, 'agent-1')).returnedAt).toBe(at)
  expect((await one($, 'agent-2')).returnKind).toBe('error')
  expect((await logOf($)).filter(r => r.flow === 'back')).toHaveLength(3)
  expect((await fxOf($)).filter(f => f.kind === 'return')).toHaveLength(3)
})

test('flow: a peer message with no SubagentHandback seen, and notices that are not task notifications, never mark a return', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1')
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  const peer = 'Another Claude session sent a message: <agent-message from="agent-1"> [Subagent hand-back] The report follows:\n  all done </agent-message>'
  await notice($, 'agent-1', 'completed', 'peer', peer)
  // Even a frame at column zero names an agent that never called SubagentHandback: an interim message, not its result.
  await notice($, 'agent-1', 'completed', 'peer', handoff('agent-1', 'still working'))
  // Even model-written text that spells the notification out is only text, when the origin is not one.
  await notice($, 'agent-1', 'completed', 'peer')
  await notice($, 'agent-1', 'completed', 'composer')
  await notice($, 'agent-1', 'completed', 'peer-send-message')
  // A hand-back frame is only read from a peer message.
  await notice($, 'agent-1', 'completed', 'composer', handoff('agent-1', 'x'))
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
  expect((await one($, 'agent-1')).returnedAt).toBeNull()
})

/** The engine's own frame for a message from a subagent: the frame at column zero, the sender's words indented. */
const handoff = (id: string, body: string) => `Another Claude session sent a message:\n<agent-message from="${id}">\n[Subagent hand-back] The report follows:\n${body.replace(/^/gm, '  ')}\n</agent-message>`
const handBack = ($: any, id: string, result = 'the report') => $.tool.call({ tool: 'SubagentHandback', result, agentId: id } as any)
const backRows = async ($: any) => (await logOf($)).filter(r => r.flow === 'back')
const returns = async ($: any) => (await fxOf($)).filter(f => f.kind === 'return')

test('flow: a peer message at column zero marks a return once, after the agent called SubagentHandback', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-grep', 'finds x', 'tu1', 'hb-1')
  await handBack($, 'hb-1')
  // The hand-back call alone is not the lead having the result.
  expect((await one($, 'hb-1')).returnedAt).toBeNull()
  expect(await backRows($)).toHaveLength(0)
  await notice($, 'hb-1', 'completed', 'peer', handoff('hb-1', 'x is defined in src/x.ts:12'))
  const a = await one($, 'hb-1')
  expect(a.returnedAt).not.toBeNull()
  expect(a.returnKind).toBe('ok')
  const rows = await backRows($)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'info', flow: 'back', ref: 'hb-1', text: 'grep#1 result returned to the lead' })
  expect(await returns($)).toHaveLength(1)
  // Once only: the same message again, and a later one, change nothing.
  const at = a.returnedAt
  await clock.advance(1000)
  await notice($, 'hb-1', 'completed', 'peer', handoff('hb-1', 'x is defined in src/x.ts:12'))
  await notice($, 'hb-1', 'completed', 'peer', handoff('hb-1', 'more'))
  expect((await one($, 'hb-1')).returnedAt).toBe(at)
  expect(await backRows($)).toHaveLength(1)
  expect(await returns($)).toHaveLength(1)
})

test('flow: a peer message marks only the agent it names, and a task-notification after it adds nothing', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'a', 'tu1', 'hb-2a')
  await spawn($, 'nexus-audit', 'b', 'tu2', 'hb-2b')
  await handBack($, 'hb-2a')
  await handBack($, 'hb-2b')
  await notice($, 'hb-2b', 'completed', 'peer', handoff('hb-2b', 'ok'))
  expect((await one($, 'hb-2a')).returnedAt).toBeNull()
  expect((await one($, 'hb-2b')).returnedAt).not.toBeNull()
  // The completion notice for the same agent is the second sign of one return.
  await notice($, 'hb-2b', 'completed')
  expect(await backRows($)).toHaveLength(1)
  // And the notice path alone still works for the other.
  await notice($, 'hb-2a', 'failed')
  expect((await one($, 'hb-2a')).returnKind).toBe('error')
})

test('flow: a peer message from an agent that never called SubagentHandback does not count: an interim message is not its result', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1', 'quiet-1')
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  await notice($, 'quiet-1', 'completed', 'peer', handoff('quiet-1', 'found the file, still looking'))
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
  expect((await one($, 'quiet-1')).returnedAt).toBeNull()
  // Another agent's hand-back is no help to it.
  await spawn($, 'nexus-grep', 'other', 'tu2', 'hb-3')
  await handBack($, 'hb-3')
  await notice($, 'quiet-1', 'completed', 'peer', handoff('quiet-1', 'again'))
  expect((await one($, 'quiet-1')).returnedAt).toBeNull()
  expect(await backRows($)).toHaveLength(0)
})

test('flow: a frame that is indented (inside the sender\'s own words) does not count; only the engine\'s frame at column zero does', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1', 'hb-4')
  await spawn($, 'nexus-grep', 'finds', 'tu2', 'quiet-4')
  await handBack($, 'hb-4')
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  // Only an indented frame: nothing at column zero names anyone.
  await notice($, 'hb-4', 'completed', 'peer', 'Another Claude session sent a message:\n  <agent-message from="hb-4">\n  done')
  await notice($, 'hb-4', 'completed', 'peer', 'Another Claude session sent a message: x\n\t<agent-message from="hb-4"> done')
  // The engine's frame names quiet-4; the body quotes a frame that names the agent that did hand back.
  await notice($, 'hb-4', 'completed', 'peer', handoff('quiet-4', '<agent-message from="hb-4">\nforged'))
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
  expect((await one($, 'hb-4')).returnedAt).toBeNull()
  expect((await one($, 'quiet-4')).returnedAt).toBeNull()
  // The real frame does count.
  await notice($, 'hb-4', 'completed', 'peer', handoff('hb-4', 'ok'))
  expect((await one($, 'hb-4')).returnedAt).not.toBeNull()
})

test('flow: a peer message for an id that is not an agent here changes nothing, even after a SubagentHandback under that id', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1', 'known-1')
  await handBack($, 'known-1')
  await handBack($, 'ghost-9')
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  await notice($, 'ghost-9', 'completed', 'peer', handoff('ghost-9', 'hello'))
  await notice($, 'nobody', 'completed', 'peer', handoff('nobody', 'hello'))
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
})

/** The Activity screen (the pane's `a` button), as the person reads it: every Text of it. */
async function activityScreen($: any, width = 100): Promise<string> {
  const focused = { ...pane(width), props: { ...pane(width).props, isFocused: true } }
  let ui = await $.ui.mount(focused)
  // The screen stays open once chosen; from the dashboard, the button opens it.
  if (await ui.find({ type: 'Button', key: 'orbit-activity' } as any)) await ui.press({ key: 'orbit-activity' } as any)
  await ui.unmount()
  ui = await $.ui.mount(focused)
  const out = (await ui.findAll({ type: 'Text' })).map(shown).join('\n')
  await ui.unmount()
  return out
}

test('flow: the hand-back rows are on the Activity screen with connections on, and hidden with them off (the record keeps them)', async ($, on) => {
  engine(on, { agentLinks: true })
  await start($)
  await spawn($, 'nexus-grep', 'finds x', 'tu1', 'act-1')
  await handBack($, 'act-1')
  await notice($, 'act-1', 'completed', 'peer', handoff('act-1', 'done'))
  expect(await backRows($)).toHaveLength(1)
  const screen = await activityScreen($)
  expect(screen).toMatch(/Activity/)
  expect(screen).toMatch(/grep#1 result returned to the lead/)
  // The same record, the same screen, connections off: the tape of before connections existed.
  await run($, 'settings agentLinks off')
  expect(await backRows($)).toHaveLength(1)
  const off = await activityScreen($)
  expect(off).toMatch(/Activity/)
  expect(off).not.toMatch(/returned to the lead/)
  expect(off).toMatch(/grep#1/) // the delegation row itself stays
})

test('flow: a notification for an unknown task id changes nothing', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1')
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  await notice($, 'agent-99', 'completed')
  await notice($, 'agent-99', 'failed')
  await notice($, 'agent-1x', 'completed')
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
})

test('flow: events for an unknown agent id (turn end, stop, tool call, Agent result) are ignored without error', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1')
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  await turnEnd($, 'ghost', 'error')
  await turnEnd($, 'ghost', 'aborted', true)
  await turnEnd($, 'ghost', 'refusal')
  await stop($, 'ghost')
  await $.tool.call({ tool: 'Read', file_path: '/repo/x.ts', agentId: 'ghost' })
  await $.tool.call({ tool: 'SubagentHandback', result: 'hello', agentId: 'ghost' } as any)
  // The lead's Agent call for a launch NEXUS never saw.
  await agentCall($, 'tu-unseen')
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
  expect(await agentsOf($)).toHaveLength(1)
})

test('flow: two instances of one role and four roles at once keep separate records, labels and results', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await spawn($, 'nexus-search', 'maps the ui', 'tu2')
  await spawn($, 'nexus-grep', 'finds x', 'tu3')
  await spawn($, 'nexus-audit', 'reviews y', 'tu4')
  await spawn($, 'nexus-test', 'runs the tests', 'tu5')
  const list = await agentsOf($)
  expect(list.map(a => a.label)).toEqual(['search#1', 'search#2', 'grep#1', 'audit#1', 'test#1'])
  expect(new Set(list.map(a => a.id)).size).toBe(5)
  expect(list.map(a => a.toolUseId)).toEqual(['tu1', 'tu2', 'tu3', 'tu4', 'tu5'])
  // One result, one agent: the second search only.
  await agentCall($, 'tu2')
  expect((await agentsOf($)).map(a => a.returnKind)).toEqual([null, 'ok', null, null, null])
  // One stop, one agent.
  await stop($, 'agent-3', 'nexus-grep')
  expect((await agentsOf($)).map(a => a.status)).toEqual(['running', 'running', 'done', 'running', 'running'])
  // One failure, one agent.
  await turnEnd($, 'agent-5', 'error')
  expect((await agentsOf($)).map(a => a.status)).toEqual(['running', 'running', 'done', 'running', 'failed'])
  // Every one is on the tape under its own label, with its own flow out row.
  const outs = (await logOf($)).filter(r => r.flow === 'out')
  expect(outs.map(r => r.ref)).toEqual(['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'])
  expect(outs.map(r => r.text)).toEqual(['search#1 started', 'search#2 started', 'grep#1 started', 'audit#1 started', 'test#1 started'])
})

test('flow: four roles launched at the same moment each keep a record', async ($, on) => {
  engine(on)
  await start($)
  await Promise.all([
    spawn($, 'nexus-search', 'a', 'tu1', 'agent-a'),
    spawn($, 'nexus-grep', 'b', 'tu2', 'agent-b'),
    spawn($, 'nexus-audit', 'c', 'tu3', 'agent-c'),
    spawn($, 'nexus-test', 'd', 'tu4', 'agent-d'),
  ])
  const list = await agentsOf($)
  expect(list.map(a => a.type).sort()).toEqual(['nexus-audit', 'nexus-grep', 'nexus-search', 'nexus-test'])
  expect(new Set(list.map(a => a.label)).size).toBe(4)
  expect(new Set(list.map(a => a.toolUseId)).size).toBe(4)
})

test('flow: out of order: a result that arrives before its spawn is ignored, and the later spawn does not become returned', async ($, on) => {
  engine(on)
  await start($)
  await agentCall($, 'tu1')
  expect(await agentsOf($)).toHaveLength(0)
  expect((await logOf($)).some(r => r.flow === 'back')).toBe(false)
  expect((await fxOf($)).some(f => f.kind === 'return')).toBe(false)
  await spawn($, 'nexus-search', 'maps', 'tu1')
  const a = await one($, 'agent-1')
  expect(a.returnedAt).toBeNull()
  expect(a.returnKind).toBeNull()
  expect(a.status).toBe('running')
  expect((await logOf($)).some(r => r.flow === 'back')).toBe(false)
})

test('flow: records carry the session id from session.start', async ($, on) => {
  engine(on)
  w.session = 'sess-A'
  await start($)
  await spawn($, 'nexus-search', 'maps', 'tu1')
  expect((await one($, 'agent-1')).session).toBe('sess-A')
  // A reload that lands in another session: new records carry the new id, old ones keep theirs.
  w.session = 'sess-B'
  await start($)
  await spawn($, 'nexus-grep', 'finds', 'tu2')
  expect((await one($, 'agent-1')).session).toBe('sess-A')
  expect((await one($, 'agent-2')).session).toBe('sess-B')
})

test('flow: a record from another session draws no link mark; the same record in its own session does', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await spawn($, 'nexus-grep', 'finds x', 'tu2')
  await agentCall($, 'tu2', 'nexus-grep')
  // Matching session: ▸ for the run given its task, ◂ for the one whose result came back.
  const mine = await rowOf($, 'search#1')
  expect(mine).toMatch(/▸/)
  expect(await rowOf($, 'grep#1')).toMatch(/◂/)
  // The snapshot is now another session's: the same records, drawn with no connection.
  w.session = 'sess-B'
  await start($)
  expect((await one($, 'agent-1')).session).toBe('sess-A')
  const a = await rowOf($, 'search#1')
  const b = await rowOf($, 'grep#1')
  expect(a).toMatch(/search#1/)
  expect(b).toMatch(/grep#1/)
  expect(a).not.toMatch(MARKS)
  expect(b).not.toMatch(MARKS)
})

// ---- LIFECYCLE ----------------------------------------------------------------------------------

test('flow: a burst of 20 spawns, results and finishes in one instant leaves bounded effects, log and agents', async ($, on) => {
  engine(on)
  await start($)
  for (let i = 1; i <= 20; i++) {
    await spawn($, 'nexus-search', `task ${i}`, `tu${i}`, `b-${i}`)
    await agentCall($, `tu${i}`)
    await stop($, `b-${i}`)
  }
  const list = await agentsOf($)
  expect(list).toHaveLength(20)
  expect(list.length).toBeLessThanOrEqual(40)
  expect((await fxOf($)).length).toBeLessThanOrEqual(24)
  expect((await fxOf($)).length).toBeGreaterThan(0)
  expect((await logOf($)).length).toBeLessThanOrEqual(50)
  expect((await logOf($)).length).toBeGreaterThan(0)
  // Each one still has its own single return.
  expect(list.every(a => a.returnKind === 'ok' && a.status === 'done')).toBe(true)
})

test('flow: more than forty agents in one instant keep the newest forty', async ($, on) => {
  engine(on)
  await start($)
  for (let i = 1; i <= 45; i++) {
    await spawn($, 'nexus-grep', `task ${i}`, `tu${i}`, `c-${i}`)
    await stop($, `c-${i}`, 'nexus-grep')
  }
  const list = await agentsOf($)
  expect(list.length).toBeLessThanOrEqual(40)
  expect(list.at(-1).id).toBe('c-45')
  expect((await fxOf($)).length).toBeLessThanOrEqual(24)
  expect((await logOf($)).length).toBeLessThanOrEqual(50)
})

test('flow: once every effect has played and nothing runs, the frame timer stops: no more ticks', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  // While the agent runs the pane is redrawn.
  const t0 = w.ticks
  await clock.advance(3000)
  expect(w.ticks).toBeGreaterThan(t0)
  await agentCall($, 'tu1')
  await stop($, 'agent-1')
  // Past the longest effect (1.6 s) and the tape's fresh time.
  await clock.advance(10_000)
  const idle = w.ticks
  await clock.advance(120_000)
  expect(w.ticks).toBe(idle)
})

test('flow: a failed or cancelled correction after the effects settled starts no new timer', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'a', 'tu1')
  await stop($, 'agent-1')
  await clock.advance(10_000)
  const idle = w.ticks
  await clock.advance(60_000)
  expect(w.ticks).toBe(idle)
  // A late failure is a real event: it may draw, and then it settles again.
  await turnEnd($, 'agent-1', 'error')
  await clock.advance(10_000)
  const after = w.ticks
  await clock.advance(60_000)
  expect(w.ticks).toBe(after)
})

test('flow: closing the pane after a spawn stops the frame timer', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await clock.advance(2000)
  expect(w.ticks).toBeGreaterThan(2)
  await run($, 'close')
  await clock.advance(1000) // a frame already due may land
  const closed = w.ticks
  await clock.advance(60_000)
  expect(w.ticks).toBe(closed)
  // The agent is still recorded; only the drawing stopped.
  expect((await one($, 'agent-1')).status).toBe('running')
})

test('flow: the session ending after a spawn stops the frame timer', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await clock.advance(2000)
  expect(w.ticks).toBeGreaterThan(2)
  await $.session.end({ reason: 'exit' } as any)
  await clock.advance(500)
  const ended = w.ticks
  await clock.advance(60_000)
  expect(w.ticks).toBe(ended)
})

test('flow: switching to the Classic theme does not throw, and the Orbit-only marks are gone from its output', async ($, on) => {
  engine(on)
  await start($)
  // Classic draws arrows of its own (the lead's links), so the marks are counted before and after the agents exist.
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await spawn($, 'nexus-grep', 'finds x', 'tu2')
  await agentCall($, 'tu2', 'nexus-grep')
  const orbit = (await texts($)).join('\n')
  expect(orbit).toMatch(/▸/)
  expect(orbit).toMatch(/◂/)
  expect(await run($, 'settings theme classic')).toMatch(/theme → classic/)
  const count = (t: string[]) => (t.join('\n').match(/[▸◂]/g) ?? []).length
  const withAgents = await texts($, 120)
  expect(withAgents.join('\n')).toMatch(/search#1/)
  expect(withAgents.join('\n')).not.toMatch(/SONNET[→←]/)
  const arrows = count(withAgents)
  // New events in Classic still record, and still draw without adding marks.
  await spawn($, 'nexus-audit', 'checks', 'tu3')
  await agentCall($, 'tu3', 'nexus-audit')
  await stop($, 'agent-3', 'nexus-audit')
  expect(count(await texts($, 120))).toBe(arrows)
  expect((await one($, 'agent-3')).returnKind).toBe('ok')
})

test('flow: the Classic pane draws the same arrows whether or not agents were delegated to', async ($, on) => {
  engine(on, { theme: 'classic' })
  await start($)
  const count = (t: string[]) => (t.join('\n').match(/[▸◂]/g) ?? []).length
  const empty = count(await texts($, 120))
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await spawn($, 'nexus-grep', 'finds x', 'tu2')
  await agentCall($, 'tu2', 'nexus-grep')
  const rows = await texts($, 120)
  expect(rows.join('\n')).toMatch(/search#1/)
  expect(count(rows)).toBe(empty)
})

test('flow: agentLinks off removes the marks from the pane and changes nothing that was recorded', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'nexus-search', 'maps the api', 'tu1')
  await spawn($, 'nexus-grep', 'finds x', 'tu2')
  await agentCall($, 'tu2', 'nexus-grep')
  expect(await rowOf($, 'search#1')).toMatch(/▸/)
  expect(await rowOf($, 'grep#1')).toMatch(/◂/)
  const before = JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])
  expect(await run($, 'settings agentLinks off')).toMatch(/agentLinks → off/)
  const a = await rowOf($, 'search#1')
  const b = await rowOf($, 'grep#1')
  expect(a).toMatch(/search#1/)
  expect(b).toMatch(/grep#1/)
  expect(a).not.toMatch(MARKS)
  expect(b).not.toMatch(MARKS)
  // Display only: what was recorded is identical.
  expect(JSON.stringify([await agentsOf($), await logOf($), await fxOf($)])).toBe(before)
  // And with it off, new events still record the same fields.
  await spawn($, 'nexus-audit', 'checks', 'tu3')
  await agentCall($, 'tu3', 'nexus-audit')
  expect(await one($, 'agent-3')).toMatchObject({ toolUseId: 'tu3', returnKind: 'ok', session: 'sess-A' })
  expect((await logOf($)).filter(r => r.ref === 'agent-3').map(r => r.flow)).toEqual(['out', 'back'])
  // Back on: the marks return.
  await run($, 'settings agentLinks on')
  expect(await rowOf($, 'search#1')).toMatch(/▸/)
})
