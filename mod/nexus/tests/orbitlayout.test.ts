import { expect, test } from 'claude-code/testing'

import { blackHole, frames } from '../hooks/blackhole'
import { O, agentRows, alerts, cells, fitLine, leadPlan, orbitLines, orbitMode, panel, tapeRows, width } from '../hooks/orbitlayout'
import type { Line } from '../hooks/orbitlayout'
import { NOW, agent, snap, unreported, withPrefs } from './snap'

const text = (lines: Line[]) => lines.map(l => l.map(g => g.t).join(''))
/** Terminal cells of a row: wide characters take two, combining marks and joiners none. */
const displayWidth = (s: string) => [...s].reduce((n, ch) => { const cp = ch.codePointAt(0)!; if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return n; if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return n + 2; return n + 1 }, 0)
const all = (lines: Line[]) => text(lines).join('\n')
const WIDTHS = [40, 48, 56, 64, 72, 84, 96, 100, 110, 130, 160]
// East Asian wide characters and emoji would take two cells: none may appear.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1f300}-\u{1faff}]/u

test('every line is exactly as wide as the pane, at every width, density, graphic and preset', () => {
  for (const w of WIDTHS)
    for (const density of ['comfortable', 'compact'])
      for (const cp of ['blackhole', 'classic', 'off'])
        for (const preset of ['minimal', 'standard', 'full']) {
          const p = withPrefs(['density', density], ['centerpiece', cp], ['telemetry.preset', preset])
          const lines = orbitLines(snap({}, p), w)
          const widths = new Set(text(lines).map(l => [...l].length))
          expect([w, ...widths]).toEqual([w, w])
        }
})

test('only single-cell glyphs: no wide characters, so a column is a cell', () => {
  for (const w of [56, 100]) expect(all(orbitLines(snap(), w))).not.toMatch(WIDE)
})

test('layout modes: wide beside, stacked, narrow; compact forces stacking', () => {
  expect(orbitMode(120, 'auto')).toBe('wide')
  expect(orbitMode(112, 'auto')).toBe('wide')
  expect(orbitMode(100, 'auto')).toBe('stacked')
  expect(orbitMode(84, 'auto')).toBe('stacked')
  expect(orbitMode(60, 'auto')).toBe('narrow')
  expect(orbitMode(120, 'compact')).toBe('stacked')
  // Wide has the lead and the advisor on the same row; stacked does not.
  const wide = text(orbitLines(snap(), 120)).find(l => l.includes('Lead session'))!
  expect(wide).toMatch(/advisor/)
  expect(text(orbitLines(snap(), 80)).find(l => l.includes('Lead session'))).not.toMatch(/advisor/)
})

test('the lead centrepiece: black hole by default, the classic orbit, or none', () => {
  const braille = (p: ReturnType<typeof withPrefs>) => (all(orbitLines(snap({}, p), 100)).match(/[▀▄]/g) ?? []).length
  expect(braille(withPrefs())).toBeGreaterThan(60)
  expect(braille(withPrefs(['centerpiece', 'off']))).toBe(0)
  const classic = all(orbitLines(snap({}, withPrefs(['centerpiece', 'classic'])), 100))
  expect(classic).toMatch(/[∙●]/)
  expect(classic.match(/[⠀-⣿]/g) ?? []).toHaveLength(0)
  // Off gives the room back.
  expect(orbitLines(snap({}, withPrefs(['centerpiece', 'off'])), 100).length).toBeLessThan(orbitLines(snap(), 100).length)
})

test('density: compact is shorter than comfortable', () => {
  expect(orbitLines(snap({}, withPrefs(['density', 'compact'])), 100).length).toBeLessThan(orbitLines(snap(), 100).length)
})

/** The black hole's cells with their colours, as one string: what actually changes from frame to frame. */
const holeLook = (lines: Line[]) => lines.flatMap(l => l.filter(g => /[▀▄]/.test(g.t)).map(g => `${g.t}|${g.c ?? ''}|${g.bg ?? ''}`)).join('\n')

test('the black hole moves with the clock and holds still under reduced motion', () => {
  const at = (now: number, reduce: boolean) => holeLook(orbitLines(snap({ now, reduceMotion: reduce }), 100))
  expect(at(NOW, false)).not.toBe(at(NOW + 12_000, false))
  expect(at(NOW, true)).toBe(at(NOW + 12_000, true))
  const off = withPrefs(['animation', 'off'])
  expect(holeLook(orbitLines(snap({ now: NOW }, off), 100))).toBe(holeLook(orbitLines(snap({ now: NOW + 12_000 }, off), 100)))
  // Only colours move: the shapes (which cells are half blocks) are the same at any time.
  const shape = (now: number) => text(orbitLines(snap({ now }), 100)).join('\n').replace(/[^▀▄\n ]/g, ' ')
  expect(shape(NOW)).toBe(shape(NOW + 9_000))
})

test('animation speed: very slow changes less over the same time', () => {
  const changed = (speed: string) => {
    const p = withPrefs(['animationSpeed', speed])
    const a = holeLook(orbitLines(snap({ now: NOW }, p), 100)).split('\n')
    const b = holeLook(orbitLines(snap({ now: NOW + 4_000 }, p), 100)).split('\n')
    return a.filter((row, i) => row !== b[i]).length
  }
  expect(changed('veryslow')).toBeLessThan(changed('slow'))
})

test('a long task name gives way; the state and the time never do', () => {
  const long = 'Trace every call site of the pricing function across the whole monorepo and summarise the findings in detail'
  const s = snap({ agents: [agent('a1', 'nexus-grep', 1, long, 'running', 12, 25, 95_000), agent('a2', 'nexus-audit', 3, long, 'failed', 30, 30, 3_000)] })
  for (const w of [48, 56, 72, 100]) {
    const rows = text(orbitLines(s, w)).filter(l => /^│ [●◐✓✗◌] (grep#1|audit#3)/.test(l))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/running/)
    expect(rows[0]).toMatch(/1m 35s/)
    expect(rows[1]).toMatch(/failed/)
    expect(rows[1]).toMatch(/3s/)
    expect(rows.join('')).toMatch(/…/)
  }
})

test('failures and limits are always shown, whatever the preset, and never cut', () => {
  const s = snap({ agents: [agent('a1', 'nexus-audit', 1, 'x', 'failed', 3, 30, 5000)], usage: { ...snap().usage, percent: 93, limits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: null }] } }, withPrefs(['telemetry.preset', 'minimal']))
  expect(alerts(s).map(a => a.text).join('|')).toMatch(/audit#1 failed.*context 93%.*5h limit 95%/)
  for (const w of [40, 56, 100]) {
    const out = all(orbitLines(s, w))
    expect(out).toMatch(/audit#1 failed/)
    expect(out).toMatch(/context 93%/)
    expect(out).toMatch(/5h limit 95%/)
  }
})

test('amber warnings can be turned off; red alerts cannot', () => {
  const warm = { ...snap().usage, percent: 75 }
  const on = snap({ usage: warm })
  expect(alerts(on).some(a => /context 75%/.test(a.text))).toBe(true)
  const off = snap({ usage: warm }, withPrefs(['telemetry.warnings', 'off']))
  expect(alerts(off).some(a => /context 75%/.test(a.text))).toBe(false)
  const hot = snap({ usage: { ...snap().usage, percent: 96 } }, withPrefs(['telemetry.warnings', 'off']))
  expect(alerts(hot).some(a => /context 96%/.test(a.text))).toBe(true)
})

test('presets: Minimal hides numbers, Standard shows context and times, Full adds tokens and costs', () => {
  const at = (preset: string) => all(orbitLines(snap({}, withPrefs(['telemetry.preset', preset])), 100))
  const min = at('minimal')
  expect(min).toMatch(/Subagents/)
  expect(min).not.toMatch(/context|\$12\.99|tok|Activity|Jev · routing|Usage/)
  const std = at('standard')
  expect(std).toMatch(/ctx 425k\/1\.0M/)
  expect(std).toMatch(/context 425k/)
  expect(std).toMatch(/Jev · routing/)
  expect(std).toMatch(/Activity/)
  expect(std).toMatch(/4m 34s/)
  expect(std).not.toMatch(/\$12\.99/)
  expect(std).not.toMatch(/\d+k tok/)
  const full = at('full')
  expect(full).toMatch(/\$12\.99 est/)
  expect(full).toMatch(/API-priced, not a bill/)
  expect(full).toMatch(/\d+k tok/)
})

test('custom: each visibility choice works alone', () => {
  const only = (key: string) => all(orbitLines(snap({}, withPrefs(['telemetry.preset', 'minimal'], [key, 'on'])), 100))
  expect(only('telemetry.cost')).toMatch(/\$12\.99/)
  expect(only('telemetry.tokens')).toMatch(/tokens in 380k {2}out 21k/)
  expect(only('telemetry.tokens')).toMatch(/cache read 900k {2}write 40k/)
  expect(only('telemetry.times')).toMatch(/4m 34s/)
  expect(only('telemetry.activity')).toMatch(/Activity/)
  expect(only('telemetry.routing')).toMatch(/Jev · routing/)
  expect(only('telemetry.usage')).toMatch(/5h/)
})

test('nothing reported: N/A or an honest empty state, never zero and never invented', () => {
  const out = all(orbitLines(unreported(withPrefs(['telemetry.preset', 'full'])), 100))
  expect(out).toMatch(/context\s+N\/A/)
  expect(out).toMatch(/cost N\/A/)
  expect(out).toMatch(/plan windows N\/A/)
  expect(out).toMatch(/tokens N\/A/)
  expect(out).toMatch(/not yet consulted/)
  expect(out).not.toMatch(/\$0|\b0%|0k\b|0\.00/)
  expect(out).toMatch(/search\s+grep\s+audit\s+test/)
})

test('an agent that made no request reports its tokens as N/A, not 0', () => {
  const s = snap({ agents: [agent('a9', 'nexus-test', 1, 'tests', 'running', 0, 20, 1000)] }, withPrefs(['telemetry.preset', 'full']))
  expect(text(orbitLines(s, 100)).find(l => /test#1/.test(l))).toMatch(/N\/A tok/)
})

test('many agents: any number of instances of a role, the busiest first, the rest counted', () => {
  const list = [
    ...Array.from({ length: 9 }, (_, i) => agent(`d${i}`, 'nexus-grep', i + 1, `done ${i}`, 'done', 5, 25, 10_000)),
    agent('r1', 'nexus-audit', 1, 'a', 'running', 2, 30, 1000),
    agent('r2', 'nexus-audit', 2, 'b', 'running', 3, 30, 2000),
    agent('r3', 'nexus-test', 1, 'c', 'running', 1, 20, 500),
  ]
  const { shown, hidden } = agentRows(list, 6)
  expect(shown.slice(0, 3).map(a => a.status)).toEqual(['running', 'running', 'running'])
  expect(hidden).toBe(6)
  const out = all(orbitLines(snap({ agents: list }), 100))
  expect(out).toMatch(/audit#1/)
  expect(out).toMatch(/audit#2/)
  expect(out).toMatch(/test#1/)
  expect(out).toMatch(/\+6 more/)
  expect(out).toMatch(/3 running\s+12 total/)
})

test('Jev says whether it is only observing or acting, and Council its own state', () => {
  expect(all(orbitLines(snap(), 100))).toMatch(/observe only/)
  expect(all(orbitLines(snap(), 84))).toMatch(/agreed 116\/140  ·  abstained 0/)
  const s = snap()
  expect(all(orbitLines({ ...s, jev: { ...s.jev, routing: 'active' } }, 100))).toMatch(/active/)
  expect(all(orbitLines({ ...s, jev: { ...s.jev, status: 'off' } }, 100))).toMatch(/off · set in the plugin options/)
  const out = all(orbitLines(snap(), 100))
  expect(out).toMatch(/security\s+done · 2 findings/)
  expect(out).toMatch(/✓ 3\/3/)
  expect(all(orbitLines(snap({}, withPrefs(['council.activation', 'off'])), 100))).toMatch(/off · the single advisor reviews/)
})

test('the activity tape drops repeats and keeps its sources', () => {
  const dup = [
    { at: NOW - 3000, who: 'jev' as const, kind: 'jev' as const, text: 'route → which file', detail: '' },
    { at: NOW - 2500, who: 'jev' as const, kind: 'jev' as const, text: 'route → which file', detail: '' },
    { at: NOW, who: 'council' as const, kind: 'done' as const, text: 'security review · done', detail: '' },
  ]
  expect(tapeRows(dup)).toHaveLength(2)
  const out = all(orbitLines(snap({ log: dup }), 100))
  expect(out.match(/route → which file/g)).toHaveLength(1)
  expect(out).toMatch(/COUNCIL\s+security review · done/)
})

test('panel: corners and title survive a too-long tag; the bottom-right corner is clipped', () => {
  const p = panel({ title: 'Jev · routing', titleColor: O.jev, edge: O.edge.jev, width: 36, rows: [[{ t: 'row' }]], tag: [{ t: 'decisions 169  observe only and a very long tag' }], accent: true })
  const t = text(p)
  expect(t.every(l => [...l].length === 36)).toBe(true)
  expect(t[0]).toMatch(/^┌─ Jev · routing/)
  expect(t[0]).toMatch(/─┐$/)
  expect(t.at(-1)).toMatch(/^└─+╱$/)
  expect(t[1]).toMatch(/^│ row\s+│$/)
})

test('fitLine: the flexible field shrinks first, then the right end; padding fills', () => {
  expect(width(fitLine([{ t: 'ab' }], 6))).toBe(6)
  const l = fitLine([{ t: 'id ' }, { t: 'a long task name', flex: true }, { t: ' done 3s' }], 20)
  expect(width(l)).toBe(20)
  const s = l.map(x => x.t).join('')
  expect(s).toMatch(/^id a.*… done 3s$/)
})

test('keyboard hints are never what gets cut: the pane always ends on a hint line', () => {
  for (const w of [40, 56, 100]) {
    const last = text(orbitLines(snap(), w)).at(-1)!
    expect(last.length).toBeGreaterThan(0)
  }
})

test('fit to the pane: blank gap rows go first when the dashboard is taller than the pane, never a panel', () => {
  for (const w of [60, 80, 100, 120]) {
    const roomy = orbitLines(snap(), w)
    const blanks = (ls: Line[]) => text(ls).filter(l => l.trim() === '').length
    // Plenty of height: unchanged. Too little: the gaps are dropped, every panel is still there.
    expect(orbitLines(snap(), w, 400)).toEqual(roomy)
    const tight = orbitLines(snap(), w, 10)
    expect(tight.length).toBeLessThan(roomy.length)
    expect(blanks(tight)).toBeLessThan(blanks(roomy))
    for (const title of ['Lead session', 'Subagents', 'Activity', 'Usage']) expect(all(tight)).toContain(title)
    expect(all(tight)).toMatch(/audit#1/)
    for (const l of text(tight)) expect([...l].length).toBe(w)
  }
  // Compact density is already tight: asking for fewer rows changes nothing.
  const compact = snap({}, withPrefs(['density', 'compact']))
  expect(orbitLines(compact, 80, 10)).toEqual(orbitLines(compact, 80))
})

test('model text cannot break a row: control characters, bidi overrides and escape sequences become dots', () => {
  const nasty = 'run \u001b[2Jtests \u202eevil\u0007 \u009b31m done\u2028x'
  const s = snap({ agents: [agent('n1', 'nexus-test', 1, nasty, 'running', 3, 20, 9000)], log: [{ at: NOW, who: 'test', kind: 'info', text: nasty, detail: '' }] })
  for (const w of [60, 80, 100, 120]) {
    const out = all(orbitLines(s, w))
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
    for (const l of text(orbitLines(s, w))) expect(displayWidth(l)).toBe(w)
  }
})

test('double-width and zero-width characters in a task keep every row exactly as wide as the pane', () => {
  const tasks = ['修复购物车折扣计算并运行所有单元测试，然后报告结果', '🚀 deploy the 🎉 release 🔥 and run the tests', 'e\u0301cole nor\u0301male tests \u200dzwj', 'ｆｕｌｌｗｉｄｔｈ ｔｅｘｔ ｉｎ ａ ｔａｓｋ']
  for (const task of tasks) {
    const s = snap({ agents: [agent('w1', 'nexus-grep', 1, task, 'running', 3, 20, 9000), agent('w2', 'nexus-test', 1, task, 'done', 9, 20, 19000)] })
    for (const w of [60, 80, 100, 120]) for (const l of text(orbitLines(s, w))) expect(displayWidth(l)).toBe(w)
  }
  // The state and the time survive a wide task name.
  const s = snap({ agents: [agent('w1', 'nexus-grep', 1, tasks[0]!, 'running', 3, 20, 95_000)] })
  expect(text(orbitLines(s, 60)).find(l => l.includes('grep#1'))).toMatch(/running\s+1m 35s/)
})

test('side-by-side advisor and Council end on the same row, whatever each holds', () => {
  const s = snap()
  const lines = text(orbitLines(s, 84))
  const top = lines.findIndex(l => /┌─ opus 5\.5 advisor.*┌─ Council/.test(l))
  expect(top).toBeGreaterThan(0)
  const bottom = lines.findIndex((l, i) => i > top && /└─+╱ └─+╱$/.test(l))
  expect(bottom).toBeGreaterThan(top)
  // One bottom edge for both, and nothing but borders and blanks between the two panels' own rows.
  for (const l of lines.slice(top + 1, bottom)) expect(l).toMatch(/^│.*│ │.*│$/)
})

test('a long model label in the lead notes keeps the words intact: the picture gives way, not the words', () => {
  const s = snap({ lead: { ...snap().lead, requested: 'claude-opus-5-5', model: 'claude-sonnet-5-5' } })
  for (const w of [60, 80, 100, 120]) {
    const out = all(orbitLines(s, w))
    expect(out).toMatch(/asked opus 5\.5/)
    expect(out).toMatch(/answered by sonnet 5\.5/)
  }
  // The plan gives the widest word its room: a long word row takes the picture a size down.
  expect(leadPlan(60, 'comfortable', 'blackhole', 10).size).not.toBeNull()
  expect(leadPlan(70, 'comfortable', 'blackhole', 22).isBeside).toBe(true)
  expect(leadPlan(70, 'comfortable', 'blackhole', 40).isBeside).toBe(false)
})

test('the black hole is the same object each render when still (reduced motion draws it every time)', () => {
  expect(blackHole(null, 'medium')).toBe(blackHole(null, 'medium'))
  expect(blackHole(Number.NaN, 'large', 'slow', true)).toBe(blackHole(null, 'large', 'slow', true))
  expect(blackHole(null, 'medium')).not.toBe(blackHole(null, 'medium', 'slow', true))
})

test('run count of one black hole frame (how many text nodes the pane draws for it)', () => {
  // Per-cell colours rarely merge; this pins how many nodes a frame costs so a change that doubles it is noticed.
  for (const [size, max] of [['small', 130], ['medium', 330], ['large', 700]] as const) {
    const counts = frames(size).map(f => f.flat().length)
    expect(Math.max(...counts)).toBeLessThan(max)
  }
})

test('Council tokens are N/A when no review reported any, never zero', () => {
  const full = withPrefs(['telemetry.preset', 'full'])
  expect(all(orbitLines(snap({}, full), 100))).toMatch(/tokens N\/A/)
  expect(all(orbitLines(snap({}, full), 100))).not.toMatch(/tokens in 0/)
  const s = snap({}, full)
  s.council.reviewers.security = { ...s.council.reviewers.security, tokens: { input: 12_000, output: 800, cacheRead: 0, cacheWrite: 0 } }
  expect(all(orbitLines(s, 100))).toMatch(/tokens in 12k out 800/)
})

test('how wide a character is: fixed expectations, not a copy of the table', () => {
  const w = (s: string) => cells(s)
  expect(w('a')).toBe(1)
  expect(w('abc')).toBe(3)
  expect(w('修复')).toBe(4)
  expect(w('ｆ')).toBe(2)
  expect(w('🚀')).toBe(2)
  expect(w('🎉🔥')).toBe(4)
  expect(w('🀄')).toBe(2) // mahjong tile, U+1F004
  expect(w('☀️')).toBe(2) // a symbol with the emoji selector is drawn as an emoji
  expect(w('☀')).toBe(1) // without it, one cell
  expect(w('e\u0301')).toBe(1) // e + combining acute
  expect(w('a\u200db')).toBe(2) // the joiner takes no cell
  expect(w('▀▄█░')).toBe(4)
  expect(w('│┌─┐╱')).toBe(5)
  expect(w('·…')).toBe(2)
})

test('the left-to-right and right-to-left marks are cleaned too; plain text is untouched', () => {
  const s = snap({ agents: [agent('b1', 'nexus-test', 1, 'a\u200eb\u200fc\u061cd', 'running', 1, 20, 1000)] })
  expect(all(orbitLines(s, 100))).not.toMatch(/[\u200e\u200f\u061c]/)
  expect(all(orbitLines(s, 100))).toMatch(/a·b·c·d/)
  const plain = snap({ agents: [agent('b2', 'nexus-test', 1, 'run the tests, e.g. “quoted” – dash', 'running', 1, 20, 1000)] })
  expect(all(orbitLines(plain, 100))).toMatch(/run the tests, e\.g\. “quoted” – dash/)
})

test('trimming agrees with measuring: a row cut to a width is never wider, even through an emoji selector', () => {
  const flexSeg = (t: string) => [{ t, flex: true }]
  for (const [t, w] of [['ab☀️cd', 4], ['ab☀️cd', 5], ['☀️☀️☀️☀️', 5], ['修复🚀购物车', 7], ['a🎉b🎉c🎉d', 6], ['e\u0301e\u0301e\u0301', 2], ['⭐️⭐️⭐️', 3]] as const) {
    const line = fitLine(flexSeg(t), w)
    expect(width(line)).toBe(w)
  }
  expect(width(fitLine(flexSeg('ab☀️cd'), 4))).toBe(4)
  expect(cells('ab☀️')).toBe(4)
})
