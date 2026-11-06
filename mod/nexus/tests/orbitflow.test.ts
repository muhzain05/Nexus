import { expect, test } from 'claude-code/testing'

import { FLOW_FIXTURES } from './fixtures'
import { cells, evidenceOf, filterTape, orbitLines, tapeLabel, TAPE_FILTERS } from '../hooks/orbitlayout'
import type { Line } from '../hooks/orbitlayout'
import type { Snapshot } from '../hooks/views'
import { agent, NOW, snap, withPrefs } from './snap'

const on = withPrefs(['agentLinks', 'on'])
const rows = (lines: Line[]) => lines.map(l => l.map(g => g.t).join(''))
const text = (s: ReturnType<typeof snap>, w: number, h?: number) => rows(orbitLines(s, w, h))
const fixture = (name: string) => FLOW_FIXTURES.find(f => f.name === name)!
const draw = (name: string, w?: number) => text(fixture(name).state(), w ?? fixture(name).width)
const find = (lines: string[], re: RegExp) => lines.find(l => re.test(l))
/** The rows of the panel whose title row matches `title`, down to its bottom edge. */
const panelOf = (lines: string[], title: RegExp) => {
  const i = lines.findIndex(l => title.test(l))
  const end = lines.findIndex((l, k) => k > i && /^└─+╱/.test(l.trim()))
  return lines.slice(i, end + 1)
}
const withoutLead = (lines: string[]) => lines.filter(l => !/Lead session/.test(l))

test('connections: every row is exactly as wide as the pane, at every width, in every flow state', () => {
  for (const f of FLOW_FIXTURES) {
    for (const w of [40, 52, 62, 68, 76, 84, 100, 111, 112, 120, 160]) {
      for (const l of text(f.state(), w)) expect(cells(l)).toBe(w)
    }
  }
})

test('connections: off draws no marks at all (the screens before connections stay byte for byte)', () => {
  for (const f of FLOW_FIXTURES) {
    const s = f.state()
    s.prefs = withPrefs(['agentLinks', 'off'])
    const out = text(s, f.width).join('\n')
    expect(withoutLead(text(s, f.width)).join('\n')).not.toMatch(/[▸◂▾▴╎├]/)
    expect(out).not.toMatch(/SONNET[→←]/)
  }
})

test('connections: idle is calm: faint stubs at the relationships, no marks, no arrows', () => {
  const out = draw('flow-idle-120')
  expect(withoutLead(out).join('\n')).not.toMatch(/[▸◂▾▴✗]/)
  expect(find(out, /├─│ ↳ calls/)).toBeTruthy() // the lead's edge reaches the advisor
  expect(find(out, /├─┌─ Council/)).toBeTruthy()
  const stacked = withoutLead(draw('flow-idle-84')).join('\n')
  expect(stacked).not.toMatch(/[▸◂▾▴]/)
  expect(stacked).toMatch(/╎/) // the quiet line into the advisor and the Council
})

test('connections: a delegation is marked on its own row, and a run with no known Agent call is not', () => {
  const out = draw('flow-delegating-84')
  expect(find(out, /▸ .*search#1/)).toBeTruthy()
  expect(find(out, /▸ .*grep#1/)).toBeTruthy()
  expect(find(out, /▸ .*audit#1/)).toBeTruthy()
  const test1 = find(out, /test#1 +Run the unit/)!
  expect(test1).toBeTruthy()
  expect(test1).not.toMatch(/▸/)
})

test('connections: done, handed back and failed look different, and a failure is never a completion', () => {
  const out = draw('flow-returned-100')
  expect(find(out, /◂ .*search#1/)).toBeTruthy() // handed back
  expect(find(out, /◂ .*grep#1/)).toBeTruthy()
  expect(find(out, /✓ .*audit#1/)).toBeTruthy() // finished, not handed back: ✓ only
  expect(find(out, /audit#1/)).not.toMatch(/◂/)
  const failed = find(out, /Run the unit tests/)!
  expect(failed).toMatch(/✗ .*test#1/)
  expect(failed).not.toMatch(/◂|✓/)
  // The state glyph says finished; the mark column adds only ▸ and ◂, so no doubled glyph.
  expect(find(out, /audit#1 +Check/)).toMatch(/^│   ✓ audit#1/)
})

test('connections: the tape names who gave what to whom, only for confirmed rows', () => {
  const out = draw('flow-delegating-84').join('\n')
  expect(out).toMatch(/SONNET→SEARCH/)
  expect(out).toMatch(/SONNET→GREP/)
  // The Test run with no known Agent call is on the tape as itself, with no arrow.
  expect(out).toMatch(/\bTEST +● test#1 started/)
  expect(out).not.toMatch(/SONNET→TEST/)
  const back = draw('flow-returned-100').join('\n')
  expect(back).toMatch(/SONNET←SEARCH/)
  expect(back).toMatch(/SONNET←GREP/)
  expect(back).not.toMatch(/SONNET←TEST/)
})

test('connections: tape labels and filters', () => {
  expect(tapeLabel({ at: NOW, who: 'test', kind: 'start', text: 't', detail: '', ref: 'x', flow: 'out' }).label).toBe('SONNET→TEST')
  expect(tapeLabel({ at: NOW, who: 'grep', kind: 'info', text: 't', detail: '', ref: 'x', flow: 'back' }).label).toBe('SONNET←GREP')
  expect(tapeLabel({ at: NOW, who: 'test', kind: 'start', text: 't', detail: '' }).label).toBe('TEST')
  expect(tapeLabel({ at: NOW, who: 'advisor', kind: 'advisor', text: 't', detail: '' }).label).toBe('OPUS')
  const log = snap({}, on).log
  expect(filterTape(log, 'jev').every(r => r.who === 'jev')).toBe(true)
  expect(filterTape(log, 'council').every(r => r.who === 'council')).toBe(true)
  expect(filterTape(log, 'nonsense')).toEqual(log)
  expect(filterTape(log, null)).toEqual(log)
  expect(TAPE_FILTERS).toContain('problems')
  const bad = [{ at: NOW, who: 'test' as const, kind: 'error' as const, text: 'x', detail: '' }, ...log]
  expect(filterTape(bad, 'problems')).toHaveLength(1)
})

test('connections: what backs a tape row is said in plain words, from the record', () => {
  const a = { ...agent('r1', 'nexus-test', 1, 'Run', 'done', 2, 20, 1000), toolUseId: 'tu9', returnedAt: NOW - 5000 }
  const out = { at: NOW, who: 'test' as const, kind: 'start' as const, text: 's', detail: '', ref: 'r1', flow: 'out' as const }
  expect(evidenceOf(out, [a])).toMatch(/delegation confirmed.*tu9/)
  expect(evidenceOf({ ...out, flow: 'back' }, [a])).toMatch(/handed back.*not reported/)
  expect(evidenceOf(out, [{ ...a, toolUseId: null }])).toMatch(/was not reported/)
  expect(evidenceOf({ ...out, ref: 'gone' }, [a])).toMatch(/no longer/)
  expect(evidenceOf({ ...out, ref: undefined, flow: undefined }, [a])).toBe('')
})

test('connections: the Council at 120 columns marks each reviewer; the running one is ▸, a finished one ◂', () => {
  const out = draw('flow-council-120')
  expect(find(out, /├▸│ .*security.*running/)).toBeTruthy()
  expect(find(out, /├◂│ .*architecture.*done/)).toBeTruthy()
  expect(find(out, /├─│ .*performance.*queued/)).toBeTruthy()
})

test('connections: at 120 columns the advisor and Council link marks sit on the drawn panel rows (advisor first body row, each reviewer in order)', () => {
  const out = draw('flow-council-120')
  // A link mark is the glyph between the two columns, on a row whose right side is a panel body row.
  const linked = out.map((l, i) => ({ l, i })).filter(({ l }) => /├[─▸◂]│/.test(l))
  // Four links: the advisor's first body row, then the Council's three reviewers.
  expect(linked).toHaveLength(4)
  const adv = out.findIndex(l => /advisor/.test(l) && /┌─/.test(l))
  expect(linked[0]!.i).toBe(adv + 1)
  expect(linked[0]!.l).toMatch(/├─│ ↳ calls/)
  const council = out.findIndex(l => /┌─ Council/.test(l))
  expect(linked.slice(1).map(x => x.i)).toEqual([council + 1, council + 2, council + 3])
  expect(linked.slice(1).map(x => /↳ (security|architecture|performance)/.exec(x.l)?.[1])).toEqual(['security', 'architecture', 'performance'])
  // The advisor's own edge row carries the lead's edge (╱╱╱ corner) and no link; the gap row between panels has none.
  expect(out.slice(adv, adv + 1).join('')).not.toMatch(/├/)
})

test('connections: stacked layouts draw a line into the advisor and the Council, and give it up when tight', () => {
  const roomy = draw('flow-council-84')
  const i = roomy.findIndex(l => /└─+╱/.test(l))
  expect(roomy[i + 1]).toMatch(/[┃▾▴╎]/)
  // Fit-to-height drops the row exactly as it drops the blank it replaced.
  const s = fixture('flow-council-84').state()
  const tight = text(s, 84, 10)
  expect(tight.length).toBeLessThan(roomy.length)
  const j = tight.findIndex(l => /└─+╱/.test(l))
  expect(tight[j + 1]).not.toMatch(/^[ ┃▾▴╎]+$/)
  // Compact density keeps no gap rows at all.
  const compact = text({ ...s, prefs: withPrefs(['agentLinks', 'on'], ['density', 'compact']) }, 84)
  expect(compact.join('\n')).not.toMatch(/^\s+[┃▾▴╎]\s+[┃▾▴╎]\s*$/m)
})

test('connections: a fresh advisor consultation is one event: ┃ in the stacked connector row, never an arrow', () => {
  const s = fixture('flow-council-84').state()
  const at = (ago: number) => ({ ...s, fx: s.fx.map(f => (f.kind === 'advisor' ? { ...f, at: NOW - ago } : f)) })
  // The connector row is the one under the lead's panel; its advisor mark sits on the left, the Council's on the right.
  const connector = (lines: string[]) => lines[lines.findIndex(l => /└─+╱/.test(l)) + 1]!
  const fresh = connector(text(at(500), 84))
  expect(fresh).toMatch(/┃/)
  const marks = fresh.trim().split(/\s+/)
  expect(marks[0]).toBe('┃') // the advisor column
  expect(marks[1]).toBe('▾') // the Council has a reviewer running: its arrow is unchanged
  expect(fresh.indexOf('┃')).toBeLessThan(fresh.indexOf('▾'))
  // Advisor alone (the Council quiet): the row has no arrow at all.
  const quiet = fixture('flow-idle-84').state()
  const only = connector(text({ ...quiet, fx: [{ kind: 'advisor', at: NOW - 500, ms: 4800, ref: null }] }, 84))
  expect(only).toMatch(/┃/)
  expect(only).not.toMatch(/[▾▴]/)
  // Once the pulse is over, the quiet line comes back.
  const stale = connector(text(at(9000), 84))
  expect(stale).not.toMatch(/┃/)
  expect(stale.trim().split(/\s+/)[0]).toBe('╎')
  // The pulse is drawn bold, in the advisor's bright lavender.
  const lines = orbitLines(at(500), 84)
  const row = lines[lines.findIndex(l => /└─+╱/.test(l.map(g => g.t).join('')) ) + 1]!
  expect(row.find(g => g.t === '┃')).toMatchObject({ b: true })
})

test('connections: with connections off the tape hides the hand-back rows; on shows them', () => {
  const log: Snapshot['log'] = [
    { at: NOW - 3000, who: 'grep', kind: 'start', text: 'grep#1 given its task', detail: '', ref: 'x', flow: 'out' },
    { at: NOW - 1000, who: 'grep', kind: 'info', text: 'grep#1 result returned to the lead', detail: '', ref: 'x', flow: 'back' },
    { at: NOW - 500, who: 'lead', kind: 'info', text: 'tests running', detail: '' },
  ]
  const states = (links: 'on' | 'off') => ({ ...fixture('flow-idle-84').state(), log, prefs: withPrefs(['agentLinks', links]) })
  for (const w of [62, 84, 120]) {
    const onTape = text(states('on'), w).join('\n')
    expect(onTape).toMatch(/result returned to the lead/)
    const offTape = text(states('off'), w).join('\n')
    expect(offTape).not.toMatch(/returned to the lead/)
    // The other rows are still there: only the connections' own rows are hidden.
    expect(offTape).toMatch(/given its task/)
    expect(offTape).toMatch(/tests running/)
  }
  // Nothing but hand-back rows: with connections off the tape is empty, as it was before they existed.
  const only = { ...states('off'), log: [log[1]!] }
  expect(text(only, 84).join('\n')).toMatch(/nothing yet/)
})

test('connections: Jev is observed, never "applied", unless routing is active; and it is never an arrow', () => {
  const out = draw('flow-jev-84').join('\n')
  expect(out).toMatch(/◇ observed/)
  expect(out).not.toMatch(/applied/)
  const jevRow = find(draw('flow-jev-84'), /Jev · routing/)!
  expect(jevRow).not.toMatch(/[▸◂]/)
  const quiet = text(snap({}, on), 84).join('\n')
  expect(quiet).not.toMatch(/◇ observed/)
})

test('connections: reduced motion shows the arrival at once: no orange phase, same symbols', () => {
  const calm = fixture('flow-delegating-84').state()
  const colourOf = (lines: Line[]) => lines.find(l => l.map(g => g.t).join('').includes('audit#1'))?.find(g => g.t === '▸')?.c
  const animated = { ...calm, reduceMotion: false }
  const reduced = { ...calm, reduceMotion: true }
  // audit#1's spawn pulse is in its first half: orange when animated, the worker's colour when not.
  expect(colourOf(orbitLines(animated, 84))).toBe('#ffbe7d') // the lead's orange, on its way
  expect(colourOf(orbitLines(reduced, 84))).toBe('#a6cbff') // the worker's colour at once
  // Same screen but for the working spinner, which is a still dot under reduced motion.
  const flat = (s: typeof animated) => text(s, 84).join('\n').replace(/[●◐◓◑◒]/g, '*').replace(/\s+/g, ' ')
  expect(flat(animated)).toBe(flat(reduced))
})

test('connections: model text cannot break a connected row (escapes, bidi, wide characters)', () => {
  const nasty = 'run \u001b[2Jtests ‮evil\u0007 修复🚀 ☀️ done'
  const a = { ...agent('n1', 'nexus-test', 1, nasty, 'running', 3, 20, 9000), toolUseId: 'tu1', returnedAt: null, returnKind: null }
  const s = snap({ agents: [a], log: [{ at: NOW, who: 'test', kind: 'start', text: nasty, detail: nasty, ref: 'n1', flow: 'out' }], fx: [{ kind: 'spawn', at: NOW - 100, ms: 1600, ref: 'n1' }] }, on)
  for (const w of [40, 62, 84, 100, 120]) {
    for (const l of text(s, w)) {
      expect(cells(l)).toBe(w)
      expect(l).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮]/)
    }
  }
})

test('connections: many agents of the same role are each their own row and mark', () => {
  const list = Array.from({ length: 6 }, (_, i) => ({ ...agent(`s${i}`, 'nexus-search', i + 1, `Map part ${i + 1}`, 'running', 2, 25, 4000), toolUseId: `tu${i}`, returnedAt: null, returnKind: null }))
  const out = text(snap({ agents: list }, on), 100)
  expect(out.filter(l => /▸ .*search#\d/.test(l))).toHaveLength(6)
})

test('connections: nothing is drawn for agents when there are none, and nothing runs', () => {
  const out = panelOf(text(snap({ agents: [], fx: [] }, on), 100), /Subagents/).join('\n')
  expect(out).not.toMatch(/[▸◂]/)
  expect(out).toMatch(/search +grep +audit +test/)
})
