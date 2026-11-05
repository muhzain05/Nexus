// The Orbit dashboard as lines of coloured text. Pure: a Snapshot and a width in, lines out.
//
// Every row is built for its width, so a panel's border always lines up and nothing that
// matters (a failure, an alert, a key hint) is the part that gets cut: when a row is too
// long, its one flexible field (a task, a message) shrinks and the rest stays.
//
// Only narrow glyphs are used (box drawing, half blocks, geometric shapes), so a cell is a column.
import type { LogRow, NexusAgent } from '../types'
import { DIMENSIONS, blackHole, sizeFor } from './blackhole'
import type { BhSize } from './blackhole'
import { councilTokens, ROLES, ROLE_LABEL } from './council'
import { clock, compact, elapsed, modelLabel } from './format'
import { agentFlow, agentMark, councilMarks, flowOf } from './flow'
import type { Mark } from './flow'
import { coreOrbit } from './orbit'
import { visibility } from './prefs'
import { freshness, limitLabel, orderLimits, resetLabel, tone as usageTone, usd } from './telemetry'
import type { Snapshot } from './views'
import { advisorLabel, haikuModel, isWorking, modeName } from './views'

export type Seg = { t: string; c?: string; bg?: string; b?: boolean; flex?: boolean }
export type Line = Seg[]

/** Orbit's palette: near-black, a warm orange for Sonnet, electric blue Haiku, muted lavender Opus, mint Jev. */
export const O = {
  bg: '#0a0b0f',
  fg: '#e6e7ec',
  soft: '#a3a7b5',
  dim: '#6b7080',
  faint: '#3b3e4b',
  sonnet: '#f29a4a',
  sonnetHi: '#ffbe7d',
  haiku: '#4d9bff',
  haikuHi: '#a6cbff',
  opus: '#b3a4ee',
  opusHi: '#d9d0ff',
  jev: '#7fd8a6',
  jevHi: '#baf2d2',
  amber: '#e6c07b',
  red: '#e5737a',
  green: '#7fd8a6',
  // Panel outlines: the role's colour, one step down so they stay thin and quiet.
  edge: { lead: '#a8652c', advisor: '#7d72ad', council: '#5f5883', jev: '#4f9a76', haiku: '#3a6db5', tape: '#4c4f63', usage: '#4a8d84' },
} as const

/** How many terminal cells a character takes: 0 for combining marks and joiners, 2 for wide (CJK, emoji), else 1. */
export function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}
/** The cells a character adds after `prev`: a symbol followed by the emoji selector (U+FE0F) is one two-cell emoji, so the selector adds the second cell. */
function step(cp: number, prev: number, prevWidth: number): number {
  if (cp === 0xfe0f) return prev >= 0x2190 && prev <= 0x2bff && prevWidth === 1 ? 1 : 0
  return charWidth(cp)
}
export const cells = (t: string) => {
  let n = 0
  let prev = 0
  let prevWidth = 0
  for (const ch of t) {
    const cp = ch.codePointAt(0)!
    const w = step(cp, prev, prevWidth)
    n += w
    prev = cp
    prevWidth = w
  }
  return n
}
/** Text from the model (a task, a log line) with control characters and bidi overrides replaced: nothing in it can move the cursor or reorder the row. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const UNSAFE_ALL = new RegExp(UNSAFE.source, 'g')
const clean = (t: string) => (UNSAFE.test(t) ? t.replace(UNSAFE_ALL, '·') : t)
export const width = (l: Line) => l.reduce((n, x) => n + cells(x.t), 0)
const seg = (t: string, c?: string, b?: boolean): Seg => ({ t, c, b })
const flex = (t: string, c?: string): Seg => ({ t, c, flex: true })
const cut = (t: string, n: number) => {
  if (n <= 0) return ''
  if (cells(t) <= n) return t
  if (n === 1) return '…'
  // Characters with the width each adds; an emoji selector joins its symbol so the pair is kept or dropped together.
  const items: { text: string; w: number }[] = []
  let prev = 0
  let prevWidth = 0
  for (const ch of t) {
    const cp = ch.codePointAt(0)!
    const w = step(cp, prev, prevWidth)
    if (cp === 0xfe0f && items.length) {
      items[items.length - 1]!.text += ch
      items[items.length - 1]!.w += w
    } else items.push({ text: ch, w })
    prev = cp
    prevWidth = w
  }
  let out = ''
  let used = 0
  for (const it of items) {
    if (used + it.w > n - 1) break
    out += it.text
    used += it.w
  }
  return `${out}…`
}

/** Pads or trims a row to exactly `w` cells; the flexible field gives way first, the right end last. */
export function fitLine(line: Line, w: number): Line {
  const out = line.map(x => ({ ...x, t: clean(x.t) }))
  let over = width(out) - w
  if (over > 0) {
    for (const x of out) {
      if (!x.flex || over <= 0) continue
      const keep = Math.max(1, cells(x.t) - over)
      over -= cells(x.t) - keep
      x.t = cut(x.t, keep)
    }
  }
  // Still too long (nothing flexible): cut from the right, never mid-structure.
  over = width(out) - w
  while (over > 0 && out.length) {
    const last = out[out.length - 1]!
    const n = cells(last.t)
    if (n <= over) {
      out.pop()
      over -= n
    } else {
      last.t = cut(last.t, n - over)
      over = 0
    }
  }
  const gap = w - width(out)
  if (gap > 0) out.push({ t: ' '.repeat(gap) })
  return out
}

/** `left` at the left, `right` at the right; the flexible part of `left` shrinks first. */
function lr(left: Line, right: Line, w: number): Line {
  const avail = w - width(right)
  if (avail < 2) return fitLine(right, w)
  // At least one blank between them; `left` gives way (its flexible field first).
  const l = fitLine(left, avail - 1)
  return [...l, { t: ' ' }, ...right]
}

const centre = (line: Line, w: number): Line => {
  const gap = Math.max(0, w - width(line))
  const left = Math.floor(gap / 2)
  return fitLine([{ t: ' '.repeat(left) }, ...line], w)
}

const blank = (w: number): Line => [{ t: ' '.repeat(w) }]

// ---- panels ------------------------------------------------------------------------------
type PanelOpts = {
  title: string
  titleColor: string
  edge: string
  width: number
  rows: Line[]
  /** Short text at the right of the top edge: a count, a state. */
  tag?: Line
  /** Diagonal accent after the heading (the angled-edge treatment). */
  accent?: boolean
  minHeight?: number
}

/** A thin outline with the bottom-right corner clipped and an optional diagonal accent in the heading. */
export function panel(o: PanelOpts): Line[] {
  const w = Math.max(10, o.width)
  const inner = w - 4
  const e = (t: string): Seg => ({ t, c: o.edge })
  const title = cut(o.title, Math.max(3, inner - 6))
  // Top edge: `┌─ title ───── tag ╱╱╱─┐`. The corners and title always stay; the tag gives way, then the accent.
  const room = w - 3 - cells(title) - 1 - 2 - 1
  let tag: Line = o.tag ? [seg(' '), ...o.tag.map(x => ({ ...x })), seg(' ')] : []
  let hatch = o.accent && inner > 28 ? ' ╱╱╱' : ''
  if (width(tag) + cells(hatch) > room) hatch = ''
  if (width(tag) > room) tag = room > 4 ? fitLine(tag, room).slice(0, -1) : []
  const fill = Math.max(1, w - 3 - cells(title) - 1 - width(tag) - cells(hatch) - 2)
  const top: Line = [e('┌─ '), seg(title, o.titleColor, true), e(' '), e('─'.repeat(fill)), ...tag, e(hatch), e('─┐')]
  const rows = [...o.rows]
  while (o.minHeight !== undefined && rows.length < o.minHeight - 2) rows.push([])
  const body = rows.map(r => [e('│'), seg(' '), ...fitLine(r, inner), seg(' '), e('│')])
  const bottom: Line = [e('└'), e('─'.repeat(w - 2)), e('╱')]
  return [fitLine(top, w), ...body, bottom]
}

/** Two stacks of lines side by side, the shorter padded with blanks. */
function beside(a: Line[], wa: number, b: Line[], wb: number, gap = 1): Line[] {
  const n = Math.max(a.length, b.length)
  const out: Line[] = []
  for (let i = 0; i < n; i++) out.push([...(a[i] ?? blank(wa)), seg(' '.repeat(gap)), ...(b[i] ?? blank(wb))])
  return out
}

/** One mark as a coloured cell. `calm` and `bright` are the role's colours: settled, and while its event plays. */
function markSeg(m: Mark, calm: string, bright: string, isStill: boolean): Seg {
  switch (m.tone) {
    case 'none':
      return { t: ' ' }
    case 'idle':
      return { t: m.glyph, c: O.faint }
    case 'out':
      // Delegation: the signal starts at the lead (orange) and arrives at the worker (the role's colour). Without motion it is just the arrival.
      return { t: m.glyph, c: m.isPulse ? (!isStill && (m.t ?? 1) < 0.5 ? O.sonnetHi : bright) : calm, b: m.isPulse }
    case 'back':
      return { t: m.glyph, c: m.isPulse ? bright : calm, b: m.isPulse }
    case 'done':
      return { t: m.glyph, c: m.isPulse ? O.jevHi : O.green, b: m.isPulse }
    case 'fail':
      return { t: m.glyph, c: O.red, b: true }
    default:
      return { t: m.glyph, c: O.amber }
  }
}

/**
 * Two stacks side by side. Where `links` has a mark for a row, the left panel's right edge there becomes a tee
 * and the gap between the panels carries the mark: the lead's side of the connection, drawn only for a row that
 * has a relationship to show.
 */
function besideLinked(a: Line[], wa: number, b: Line[], wb: number, links: Map<number, Seg>): Line[] {
  const n = Math.max(a.length, b.length)
  const out: Line[] = []
  for (let i = 0; i < n; i++) {
    let left = a[i] ?? blank(wa)
    let mid: Seg = seg(' ')
    const link = links.get(i)
    const edge = left.at(-1)
    if (link && edge?.t === '│') {
      left = [...left.slice(0, -1), { ...edge, t: '├' }]
      mid = link
    }
    out.push([...left, mid, ...(b[i] ?? blank(wb))])
  }
  return out
}

/** The links from the lead to the advisor and the Council, by row of the right column. */
function sideLinks(s: Snapshot, advisorRows: number, gapRows: number, hasCouncil: boolean, isStill: boolean): Map<number, Seg> {
  const f = flowOf(s)
  const m = new Map<number, Seg>()
  // The advisor is one event (reported when it ends): lavender while it is fresh, a quiet line once it has been used.
  m.set(1, f.advisorPulse !== null ? { t: '─', c: O.opusHi, b: true } : { t: '─', c: f.advisorCalls > 0 ? O.edge.advisor : O.faint })
  if (!hasCouncil) return m
  const top = advisorRows + gapRows
  const marks = councilMarks(s)
  const isUsed = marks.some(x => x.tone !== 'idle')
  m.set(top, { t: '─', c: marks.some(x => x.isPulse) ? O.opusHi : isUsed ? O.edge.council : O.faint })
  if (s.prefs.council.activation !== 'off') marks.forEach((x, k) => m.set(top + 1 + k, markSeg(x, O.opus, O.opusHi, isStill)))
  return m
}

/** In the blank row under the lead: a short line down into the advisor and into the Council. */
function connectorRow(s: Snapshot, aw: number, cw: number, w: number): Line {
  const f = flowOf(s)
  const marks = councilMarks(s)
  const ax = Math.floor(aw / 2)
  const cx = aw + 1 + Math.floor(cw / 2)
  // One event (the request and the reply are not reported apart), so it brightens and points nowhere.
  const adv: Seg = f.advisorPulse !== null ? { t: '┃', c: O.opusHi, b: true } : { t: '╎', c: f.advisorCalls > 0 ? O.edge.advisor : O.faint }
  const running = marks.some(x => x.tone === 'out')
  const back = marks.some(x => x.tone === 'back' && x.isPulse)
  const cou: Seg = running ? { t: '▾', c: O.opus } : back ? { t: '▴', c: O.opusHi, b: true } : { t: '╎', c: marks.some(x => x.tone !== 'idle') ? O.edge.council : O.faint }
  return fitLine([seg(' '.repeat(ax)), adv, seg(' '.repeat(cx - ax - 1)), cou], w)
}

// ---- small pieces ------------------------------------------------------------------------
/** A bar of `n` cells filled by `ratio`: `▰▰▰▱▱`. */
function meter(ratio: number, n: number): string {
  const full = Math.max(0, Math.min(n, Math.round(ratio * n)))
  return '▰'.repeat(full) + '▱'.repeat(n - full)
}

const STATUS_GLYPH: Record<NexusAgent['status'], string> = { running: '●', done: '✓', failed: '✗', cancelled: '◌' }
const SPIN = ['◐', '◓', '◑', '◒']

function spinner(s: Snapshot): string {
  return s.reduceMotion ? '●' : SPIN[Math.floor(s.now / 250) % SPIN.length]!
}

/** Rows of tone runs (the classic orbit's) as coloured lines. */
function spriteLines(sprite: { text: string; tone: string }[][], colour: Record<string, string>): Line[] {
  return sprite.map(r => r.map(x => ({ t: x.text, c: colour[x.tone] || undefined })))
}

/** The black hole's rows, each cell with its own pixel colours. */
function holeLines(rows: { text: string; fg?: string; bg?: string }[][]): Line[] {
  return rows.map(r => r.map(x => ({ t: x.text, c: x.fg, bg: x.bg })))
}

// ---- alerts: failures and limits, shown whatever the preset ------------------------------
export type Alert = { text: string; colour: string }

/** Things the person must not miss. Hiding numbers never hides these. */
export function alerts(s: Snapshot): Alert[] {
  const out: Alert[] = []
  const failed = s.agents.filter(a => a.status === 'failed')
  if (failed.length) out.push({ text: `${failed.length === 1 ? failed[0]!.label : `${failed.length} agents`} failed${failed.length === 1 && failed[0]!.reason ? `: ${failed[0]!.reason}` : ''}`, colour: O.red })
  const u = s.usage
  if (u.percent !== null && u.percent >= 90) out.push({ text: `context ${Math.round(u.percent)}% full`, colour: O.red })
  else if (u.percent !== null && u.percent >= 70 && visibility(s.prefs).warnings) out.push({ text: `context ${Math.round(u.percent)}% used`, colour: O.amber })
  for (const l of orderLimits(u.limits)) {
    const t = usageTone(l.percentUsed)
    if (t === 'alert') out.push({ text: `${limitLabel(l.kind)} limit ${Math.round(l.percentUsed)}% used`, colour: O.red })
    else if (t === 'warn' && visibility(s.prefs).warnings) out.push({ text: `${limitLabel(l.kind)} ${Math.round(l.percentUsed)}% used`, colour: O.amber })
  }
  if (s.jev.status === 'down') out.push({ text: `jev down${s.jev.reason ? ` (${s.jev.reason})` : ''}`, colour: O.amber })
  for (const r of ROLES) {
    const st = s.council.reviewers[r].status
    if (st === 'failed') out.push({ text: `council ${r} failed`, colour: O.red })
  }
  if (s.guard.status === 'ERROR') out.push({ text: 'cache guard error', colour: O.amber })
  return out
}

// ---- header --------------------------------------------------------------------------------
export function header(s: Snapshot, w: number): Line[] {
  const v = visibility(s.prefs)
  const state: Line = isWorking(s)
    ? s.lead.isWaiting
      ? [seg('◌ ', O.amber), seg('waiting for you', O.amber)]
      : [seg(`${spinner(s)} `, O.sonnet), seg('working ', O.sonnet), seg(elapsed(s.now - (s.lead.turnStartedAt ?? s.now)), O.soft)]
    : [seg('● ', O.dim), seg('idle', O.dim)]
  const left: Line = [seg('◦', O.opus), seg('•', O.haiku), seg('◦', O.jev), seg('● ', O.sonnet), seg('NEXUS', O.fg, true), seg('  '), seg(modeName(s), O.soft), seg('  ·  ', O.faint), seg('orbit', O.dim)]
  const marks: Line = []
  if (v.context && s.usage.tokens !== null && s.usage.window) marks.push(seg(`ctx ${compact(s.usage.tokens)}/${compact(s.usage.window)}`, O.dim), seg('  '))
  if (s.prefs.cacheGuard.enabled) marks.push(seg('cache ', O.dim), seg(s.guard.status.toLowerCase(), O.soft), seg('  '))
  return [lr(left, [...marks, ...state], w), [{ t: '─'.repeat(w), c: O.faint }]]
}

// ---- lead ----------------------------------------------------------------------------------
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']

/** Sonnet's words, as named parts, so the beside and the stacked layouts are built from the same pieces. */
type LeadText = { title: Line; role: Line; doing: Line; effort: Line; state: Line; notes: Line[] }

function leadText(s: Snapshot): LeadText {
  const effort = s.lead.effort ?? 'N/A'
  const level = EFFORT.indexOf(effort) + 1
  const notes: Line[] = []
  const asked = s.lead.requested
  if (asked !== null && s.lead.model !== null && modelLabel(asked) !== modelLabel(s.lead.model)) notes.push([seg(`asked ${modelLabel(asked)}`, O.amber)], [seg(`answered by ${modelLabel(s.lead.model)}`, O.amber)])
  if (s.mode.relaunch) notes.push([seg('advisor change waits', O.amber)], [seg('for a relaunch', O.amber)])
  return {
    title: [seg(modelLabel(s.lead.model), O.sonnet, true)],
    role: [seg('main session', O.dim)],
    doing: [seg('edits + runs tests', O.soft)],
    effort: [seg('effort ', O.soft), seg('▮'.repeat(Math.max(0, level)), O.sonnet), seg('▯'.repeat(Math.max(0, 5 - level)), O.faint), seg(` ${effort}`, O.sonnet)],
    state:
      s.lead.turnStartedAt === null
        ? [seg(`idle · ${s.lead.steps} steps`, O.dim)]
        : s.lead.isWaiting
          ? [seg('◌ waiting for you', O.amber)]
          : [seg(`${spinner(s)} working ${elapsed(s.now - s.lead.turnStartedAt)}`, O.sonnet)],
    notes,
  }
}

/** The words beside the picture: one row each, a blank after the role, the notes last. */
const beside6 = (t: LeadText): Line[] => [t.title, t.role, [], t.doing, t.effort, t.state, ...t.notes]
/** The words under the picture: the same pieces, without the blank and the role. */
const under = (t: LeadText): Line[] => [t.title, t.doing, t.effort, t.state, ...t.notes]

/** Which composition the lead panel draws, and whether the words sit beside it, for `inner` columns. */
export function leadPlan(inner: number, density: 'comfortable' | 'compact', graphic: Snapshot['prefs']['centerpiece'], textWidth = 20): { size: BhSize | null; isBeside: boolean } {
  if (graphic !== 'blackhole') return { size: null, isBeside: false }
  const rowsOk = density === 'compact' ? 7 : 10
  // A composition beside the words needs its own width, a 3-cell gutter and the widest of the words (never cut).
  for (const size of ['large', 'medium', 'small'] as const) {
    if (density === 'compact' && size === 'large') continue
    if (DIMENSIONS[size].rows > Math.max(rowsOk, 7) + (size === 'large' ? 4 : 0)) continue
    if (inner >= DIMENSIONS[size].cols + 3 + textWidth && (size !== 'large' || inner >= 96)) return { size, isBeside: true }
  }
  // Too narrow to sit beside the words: the smallest composition above them, if it fits at all.
  return { size: inner >= DIMENSIONS.small.cols ? 'small' : null, isBeside: false }
}

export function leadPanel(s: Snapshot, w: number, isRoomy = s.prefs.density === 'comfortable'): Line[] {
  const inner = w - 4
  const comfortable = isRoomy
  const words = leadText(s)
  const plan = leadPlan(inner, s.prefs.density, s.prefs.centerpiece, Math.max(...beside6(words).map(width)))
  const rows: Line[] = []
  const ms = s.reduceMotion || s.prefs.animation === 'off' ? null : s.now
  const art: Line[] =
    plan.size !== null
      ? holeLines(blackHole(ms, plan.size, s.prefs.animationSpeed, s.isMono === true))
      : s.prefs.centerpiece === 'classic'
        ? spriteLines(coreOrbit(isWorking(s) && !s.reduceMotion ? s.now - (s.lead.turnStartedAt ?? s.now) : null), { core: O.sonnet, sat: O.sonnetHi, trail: O.sonnet, faint: O.faint })
        : []
  const text = beside6(words)
  if (plan.isBeside) {
    // The words sit in a column at the right of the picture, centred on it, and the pair is centred in the panel.
    const artW = DIMENSIONS[plan.size!].cols
    const textW = Math.max(...text.map(width))
    const group = artW + 3 + textW
    const left = Math.max(0, Math.floor((inner - group) / 2))
    const h = Math.max(art.length, text.length)
    const top = Math.floor((h - text.length) / 2)
    for (let i = 0; i < h; i++) {
      const a = art[i] ?? [{ t: ' '.repeat(artW) }]
      const t = text[i - top] ?? []
      rows.push([{ t: ' '.repeat(left) }, ...fitLine(a, artW), { t: '   ' }, ...t])
    }
  } else {
    // Narrow: the picture above, the words under it in a few centred lines.
    for (const l of art) rows.push(centre(l, inner))
    if (art.length) rows.push([])
    for (const l of under(words)) rows.push(centre(l, inner))
  }
  if (comfortable) {
    rows.unshift([])
    rows.push([])
  }
  return panel({ title: 'Lead session', titleColor: O.sonnet, edge: O.edge.lead, width: w, rows, accent: true, tag: [seg('▸ main', O.dim)] })
}

// ---- advisor and council ------------------------------------------------------------------
function advisorPanel(s: Snapshot, w: number, minHeight?: number): Line[] {
  const a = s.advisor
  const v = visibility(s.prefs)
  const rows: Line[] = []
  const lastLabel = a.lastAt === null ? 'not yet consulted' : `last ${elapsed(s.now - a.lastAt)} ago`
  rows.push([seg('↳ ', O.dim), seg(`calls ${a.calls}`, O.soft), seg('  ·  ', O.faint), flex(lastLabel, O.soft)])
  const c = s.prefs.council.activation
  rows.push([seg('↳ ', O.dim), seg('council ', O.soft), seg(c === 'off' ? 'off' : c === 'on' ? 'all three' : 'adaptive', c === 'on' ? O.amber : O.opus)])
  // What the last consultation read and how long it took, as Claude Code reported it; nothing when it never ran.
  if (a.calls > 0 && v.times) rows.push([seg('↳ ', O.dim), seg(`read ${compact(a.contextAtCall)} ctx`, O.soft), seg('  ·  ', O.faint), seg(a.lastMs === null ? 'time N/A' : `took ${elapsed(a.lastMs)}`, O.soft)])
  return panel({ title: `${advisorLabel(s)} advisor`, titleColor: O.opus, edge: O.edge.advisor, width: w, rows, accent: true, minHeight })
}

function councilState(s: Snapshot, r: (typeof ROLES)[number]): { text: string; colour: string } {
  const x = s.council.reviewers[r]
  switch (x.status) {
    case 'running':
      return { text: x.startedAt ? `running ${elapsed(s.now - x.startedAt)}` : 'running', colour: O.opusHi }
    case 'done':
      return { text: x.findings === null ? 'done' : `done · ${x.findings} finding${x.findings === 1 ? '' : 's'}`, colour: O.green }
    case 'queued':
      return { text: 'queued', colour: O.dim }
    case 'incomplete':
      return { text: 'incomplete', colour: O.amber }
    case 'failed':
      return { text: 'failed', colour: O.red }
    case 'stale':
      return { text: 'stale', colour: O.amber }
    default:
      return { text: 'idle', colour: O.dim }
  }
}

function councilPanel(s: Snapshot, w: number, minHeight?: number): Line[] {
  const v = visibility(s.prefs)
  const mode = s.prefs.council.activation
  const rows: Line[] = []
  if (mode === 'off') {
    rows.push([seg('off · the single advisor reviews', O.dim)])
    return panel({ title: 'Council', titleColor: O.opus, edge: O.edge.council, width: w, rows, minHeight })
  }
  const authorized = ROLES.filter(r => s.council.reviewers[r].status !== 'idle')
  const done = authorized.filter(r => s.council.reviewers[r].status === 'done').length
  for (const r of ROLES) {
    const st = councilState(s, r)
    const x = s.council.reviewers[r]
    const took = x.startedAt !== null && x.endedAt !== null && v.times ? ` ${elapsed(x.endedAt - x.startedAt)}` : ''
    const base: Line = [seg('↳ ', O.dim), seg(ROLE_LABEL[r].toLowerCase().padEnd(13), O.soft), seg(st.text, st.colour)]
    rows.push(width(base) + cells(took) <= w - 4 ? [...base, seg(took, O.dim)] : base)
  }
  if (v.tokens && s.council.reviews > 0) {
    const t = councilTokens(s.council)
    // Nothing reported is N/A, never a zero: a finished review always used some tokens.
    rows.push([seg(t.input + t.output + t.cacheRead + t.cacheWrite === 0 ? 'tokens N/A' : `tokens in ${compact(t.input)} out ${compact(t.output)}`, O.dim)])
  }
  const tag: Line = authorized.length ? [seg(done === authorized.length ? '✓ ' : '', O.green), seg(`${done}/${authorized.length}`, done === authorized.length ? O.green : O.soft)] : [seg(mode, O.dim)]
  return panel({ title: 'Council', titleColor: O.opus, edge: O.edge.council, width: w, rows, tag, minHeight })
}

// ---- jev -----------------------------------------------------------------------------------
const QUESTIONS = ['which file', 'which tool', 'retry or stop']

function jevPanel(s: Snapshot, w: number): Line[] {
  const j = s.jev
  const inner = w - 4
  const rows: Line[] = []
  const state = j.status === 'off' ? 'off' : j.status === 'down' ? `down${j.reason ? ` (${j.reason})` : ''}` : j.routing === 'active' ? 'active' : j.routing === 'calibrating' ? 'calibrating' : 'observe only'
  const stateColour = j.status === 'down' ? O.amber : j.routing === 'active' ? O.jevHi : O.dim
  // A choice Jev just made, drawn as an observation: the panel brightens and says so. Never an arrow, never a handoff.
  const fl = s.prefs.agentLinks ? flowOf(s) : null
  const seen = fl !== null && fl.jevPulse !== null && j.status !== 'off'
  const rowFor = (q: string, barW: number): Line => {
    const d = j.last.find(x => x.question === q)
    if (!d) return [seg(q.padEnd(14), O.soft), seg('▱'.repeat(barW), O.faint), seg('  N/A', O.dim)]
    const word = d.isSharp ? 'sharp' : 'split'
    return [seg(q.padEnd(14), O.soft), seg(meter(d.p, barW), d.isSharp ? O.jev : '#4f9a76'), seg(` ${d.p.toFixed(2)} `, O.fg), seg(word, d.isSharp ? O.jevHi : O.dim)]
  }
  const isTwo = inner >= 66
  const barW = isTwo ? 7 : inner >= 44 ? 8 : 5
  if (j.status === 'off') rows.push([seg('off · set in the plugin options', O.dim)])
  else if (isTwo) {
    const half = Math.floor((inner - 3) / 2)
    const q = QUESTIONS.map(x => rowFor(x, barW))
    rows.push([...fitLine(q[0]!, half), seg(' │ ', O.faint), ...fitLine(q[1]!, half)])
    rows.push([...fitLine(q[2]!, half), seg(' │ ', O.faint), ...fitLine(lastRouteLine(s), half)])
  } else {
    for (const x of QUESTIONS) rows.push(rowFor(x, barW))
  }
  const agreed = j.toolChecked > 0 ? `agreed ${j.toolAgreed}/${j.toolChecked}` : 'agreed N/A'
  const isRoomy = inner >= 56
  const shown = seen ? (fl!.isJevApplied ? 'applied' : 'observed') : state
  const shownColour = seen ? O.jevHi : stateColour
  const tag: Line = isRoomy ? [seg(`decisions ${j.decisions}`, O.soft), seg('  ', O.faint), seg(seen ? `◇ ${shown}` : shown, shownColour, seen)] : [seg(seen ? `◇ ${shown}` : shown, shownColour, seen)]
  if (!isRoomy) rows.push([seg(`decisions ${j.decisions}  ·  ${agreed}`, O.dim)])
  else if (j.status !== 'off') rows.push([seg(`sharp ≥ 0.85  ·  ${agreed}  ·  abstained ${j.fallbacks}`, O.dim)])
  return panel({ title: 'Jev · routing', titleColor: O.jev, edge: seen ? O.jev : O.edge.jev, width: w, rows, tag, accent: true })
}

function lastRouteLine(s: Snapshot): Line {
  const j = s.jev
  return j.lastRoute ? [seg('last route ', O.dim), flex(j.lastRoute, O.soft)] : [seg('last route ', O.dim), seg('N/A', O.dim)]
}

// ---- haiku ---------------------------------------------------------------------------------
/** Running agents first, then the most recent; any number of instances of any role. */
export function agentRows(list: NexusAgent[], max: number): { shown: NexusAgent[]; hidden: number } {
  const running = list.filter(a => a.status === 'running')
  const rest = list.filter(a => a.status !== 'running').reverse()
  const all = [...running, ...rest]
  return { shown: all.slice(0, max), hidden: Math.max(0, all.length - max) }
}

function haikuPanel(s: Snapshot, w: number, maxRows: number): Line[] {
  const v = visibility(s.prefs)
  const isStill = s.reduceMotion || s.prefs.animation === 'off'
  const inner = w - 4
  const running = s.agents.filter(a => a.status === 'running').length
  const { shown, hidden } = agentRows(s.agents, maxRows)
  const rows: Line[] = []
  const labelW = Math.max(8, ...shown.map(a => cells(a.label))) + 1
  for (const a of shown) {
    const col = a.status === 'failed' ? O.red : a.status === 'running' ? O.haikuHi : a.status === 'done' ? O.haiku : O.dim
    const turns = a.maxTurns ? `${a.steps}/${a.maxTurns}` : `${a.steps}`
    const stateCol = a.status === 'failed' ? O.red : a.status === 'done' ? O.green : a.status === 'cancelled' ? O.amber : O.haikuHi
    const dur = v.times ? elapsed((a.endedAt ?? s.now) - a.startedAt) : ''
    const tok = v.tokens ? (a.steps === 0 ? 'N/A' : compact(a.tokens.input + a.tokens.output)) : ''
    const task = a.description || a.prompt || 'N/A'
    // Columns that line up from row to row: mark, name, task (the one that shrinks), turns, state, time, tokens.
    // With connections on, the first column says what the lead's link to this run is: ▸ given its task, ◂ result handed back, nothing when unproven.
    const m = s.prefs.agentLinks ? agentMark(agentFlow(s, a)) : null
    // Done, failed and cancelled are already said by the state glyph; the column adds only ▸ (given its task) and ◂ (result handed back).
    const link: Line = m ? [m.tone === 'out' || m.tone === 'back' ? markSeg(m, O.haiku, O.haikuHi, isStill) : seg(' '), seg(' ')] : []
    const isEnding = m !== null && m.tone === 'done' && m.isPulse
    const left: Line = [...link, seg(a.status === 'running' ? `${spinner(s)} ` : `${STATUS_GLYPH[a.status]} `, isEnding ? O.jevHi : col, isEnding), seg(a.label.padEnd(labelW), O.fg, true), flex(task, O.soft)]
    const right: Line = [seg(`${turns} turns`.padStart(10), O.soft), seg(`  ${a.status.padEnd(7)}`, stateCol)]
    if (dur) right.push(seg(`  ${dur.padStart(6)}`, O.soft))
    if (tok) right.push(seg(`  ${tok.padStart(5)} tok`, O.dim))
    rows.push(lr(left, right, inner))
  }
  if (hidden > 0) rows.push([seg(`+${hidden} more · ctrl+x tab, then 1-9 to inspect`, O.dim)])
  if (rows.length === 0) rows.push([seg('search  grep  audit  test', O.soft), seg('   idle · none started yet', O.dim)])
  const tag: Line = [seg(running > 0 ? `${running} running` : 'idle', running > 0 ? O.haikuHi : O.dim), seg(`  ${s.agents.length} total`, O.dim)]
  return panel({ title: `Subagents · ${haikuModel(s)}`, titleColor: O.haiku, edge: O.edge.haiku, width: w, rows, tag, accent: true })
}

// ---- activity tape --------------------------------------------------------------------------
const WHO: Record<LogRow['who'], { label: string; colour: string }> = {
  jev: { label: 'JEV', colour: O.jev },
  advisor: { label: 'OPUS', colour: O.opus },
  lead: { label: 'SONNET', colour: O.sonnet },
  search: { label: 'HAIKU', colour: O.haiku },
  grep: { label: 'HAIKU', colour: O.haiku },
  audit: { label: 'HAIKU', colour: O.haiku },
  test: { label: 'HAIKU', colour: O.haiku },
  haiku: { label: 'HAIKU', colour: O.haiku },
  mode: { label: 'MODE', colour: O.amber },
  council: { label: 'COUNCIL', colour: O.opus },
}
const KIND_COLOUR: Record<LogRow['kind'], string> = { start: O.soft, done: O.green, error: O.red, advisor: O.opus, mode: O.amber, jev: O.jev, info: O.dim }

/** The tape without repeats: the same line from the same source within two seconds is one line. */
export function tapeRows(log: LogRow[]): LogRow[] {
  const out: LogRow[] = []
  for (const r of log) {
    const prev = out.at(-1)
    if (prev && prev.who === r.who && prev.text === r.text && r.at - prev.at < 2000) continue
    out.push(r)
  }
  return out
}

const ROLE_NAME: Partial<Record<LogRow['who'], string>> = { search: 'SEARCH', grep: 'GREP', audit: 'AUDIT', test: 'TEST' }
const SYMBOL: Record<LogRow['kind'], string> = { start: '●', done: '✓', error: '✗', advisor: '◆', mode: '⇄', jev: '◇', info: '·' }

/**
 * The source of a tape row. With connections on, a delegation the lead made reads SONNET→TEST and its result
 * handed back SONNET←TEST; both only for a row the data confirmed (flow is set from the Agent call's id).
 */
export function tapeLabel(r: LogRow): { label: string; colour: string } {
  const who = WHO[r.who] ?? WHO.haiku
  const role = ROLE_NAME[r.who]
  if (r.flow && role) return { label: `SONNET${r.flow === 'out' ? '→' : '←'}${role}`, colour: who.colour }
  return { label: role ?? who.label, colour: who.colour }
}

export const TAPE_FILTERS = ['all', 'agents', 'advisor', 'council', 'jev', 'problems'] as const
export type TapeFilter = (typeof TAPE_FILTERS)[number]

/** The tape narrowed to one kind of event; anything unknown shows everything. */
export function filterTape(rows: LogRow[], filter: string | null): LogRow[] {
  switch (filter) {
    case 'agents':
      return rows.filter(r => r.who in ROLE_NAME || r.who === 'haiku')
    case 'advisor':
      return rows.filter(r => r.who === 'advisor')
    case 'council':
      return rows.filter(r => r.who === 'council')
    case 'jev':
      return rows.filter(r => r.who === 'jev')
    case 'problems':
      return rows.filter(r => r.kind === 'error')
    default:
      return rows
  }
}

/** What backs one tape row, in plain words, for the full tape. Empty when the row names nothing to check. */
export function evidenceOf(r: LogRow, list: NexusAgent[]): string {
  if (!r.ref) return ''
  const a = list.find(x => x.id === r.ref)
  if (!a) return 'the agent is no longer in the list'
  if (r.flow === 'out') return a.toolUseId ? `delegation confirmed: the Agent call ${a.toolUseId} started it` : 'started, but the Agent call that launched it was not reported'
  if (r.flow === 'back') return `result handed back to the lead at ${clock(a.returnedAt ?? r.at)} (whether the model read it is not reported)`
  return a.returnedAt ? `result handed back at ${clock(a.returnedAt)}` : 'its result has not been reported as handed back'
}

function tapePanel(s: Snapshot, w: number, n: number): Line[] {
  const links = s.prefs.agentLinks
  const shown = tapeRows(links ? s.log : s.log.filter(r => r.flow !== 'back')).slice(-n)
  const labels = shown.map(tapeLabel)
  const lw = links ? Math.min(16, Math.max(8, ...labels.map(l => cells(l.label) + 1))) : 8
  const rows: Line[] = shown.map((r, i) => {
    const who = WHO[r.who] ?? WHO.haiku
    if (!links) return [seg(clock(r.at), O.dim), seg('  '), seg(who.label.padEnd(8), who.colour, true), flex(r.text, KIND_COLOUR[r.kind])]
    const l = labels[i]!
    return [seg(clock(r.at), O.dim), seg('  '), seg(l.label + ' '.repeat(Math.max(0, lw - cells(l.label))), l.colour, true), seg(`${SYMBOL[r.kind]} `, KIND_COLOUR[r.kind]), flex(r.text, KIND_COLOUR[r.kind])]
  })
  if (rows.length === 0) rows.push([seg('nothing yet · events appear here as they happen', O.dim)])
  return panel({ title: 'Activity', titleColor: O.opus, edge: O.edge.tape, width: w, rows, tag: [seg(s.agents.some(a => a.status === 'running') || isWorking(s) ? 'live' : 'idle', O.dim)], accent: true })
}

// ---- usage ---------------------------------------------------------------------------------
/** Empty when the preset shows no usage figure: no panel for nothing. */
function usagePanel(s: Snapshot, w: number): Line[] {
  const v = visibility(s.prefs)
  const u = s.usage
  const inner = w - 4
  const parts: Line[][] = []
  if (v.usage) {
    const rows: Line[] = []
    const f = freshness(u.readAt, s.now)
    const limits = orderLimits(u.limits)
    if (limits.length === 0) rows.push([seg('plan windows ', O.soft), seg('N/A', O.dim)])
    for (const l of limits.slice(0, 3)) {
      const t = usageTone(l.percentUsed)
      const c = t === 'alert' ? O.red : t === 'warn' ? O.amber : O.jev
      rows.push([seg(limitLabel(l.kind).padEnd(4), O.soft), seg(meter(l.percentUsed / 100, 10), c), seg(` ${String(Math.round(l.percentUsed)).padStart(3)}%`, O.fg), flex(`  ${resetLabel(l.resetsAt, s.now)}${f.isStale ? ' · stale' : ''}`, O.dim)])
    }
    parts.push(rows)
  }
  const mid: Line[] = []
  if (v.context) mid.push([seg('context ', O.soft), seg(u.tokens === null ? 'N/A' : `${compact(u.tokens)} / ${compact(u.window)}`, O.fg)])
  if (v.context && u.percent !== null) mid.push([seg(meter(u.percent / 100, 10), u.percent >= 90 ? O.red : u.percent >= 70 ? O.amber : O.jev), seg(` ${Math.round(u.percent)}%`, O.fg)])
  if (v.cost) mid.push([seg('cost ', O.soft), seg(usd(u.costUsd), O.fg), seg(u.costUsd === null ? '' : ' est', O.dim)], [seg(v.cost ? 'API-priced, not a bill' : '', O.dim)])
  if (v.tokens) {
    // Summed from each request Claude Code reported, once each; nothing reported is N/A, never 0.
    const rows = Object.values(s.models)
    const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => rows.reduce((n, r) => n + r[k], 0)
    if (rows.length === 0) mid.push([seg('tokens ', O.soft), seg('N/A', O.fg)])
    else {
      mid.push([seg('tokens ', O.soft), seg(`in ${compact(sum('input'))}  out ${compact(sum('output'))}`, O.fg), seg(`  ${rows.length} model${rows.length === 1 ? '' : 's'}`, O.dim)])
      mid.push([seg('cache ', O.soft), seg(`read ${compact(sum('cacheRead'))}  write ${compact(sum('cacheWrite'))}`, O.fg)])
    }
  }
  if (mid.length) parts.push(mid)
  const rows: Line[] = []
  const high = Math.max(0, ...parts.map(p => p.length))
  if (parts.length === 0) return []
  if (inner >= 70 && parts.length === 2) {
    const wa = Math.floor(inner * 0.58)
    for (let i = 0; i < high; i++) rows.push([...fitLine(parts[0]![i] ?? [], wa), seg(' │ ', O.faint), ...fitLine(parts[1]![i] ?? [], inner - wa - 3)])
  } else for (const p of parts) rows.push(...p)
  return panel({ title: 'Usage', titleColor: O.jev, edge: O.edge.usage, width: w, rows, accent: true })
}

export function keysLine(s: Snapshot, w: number, isFocused: boolean): Line {
  const k = (key: string, label: string): Line => [seg(`[${key}]`, O.opus), seg(` ${label}`, O.soft), seg('   ')]
  const line = isFocused
    ? [...k('s', 'settings'), ...k('a', 'activity'), ...k('1-9', 'inspect'), ...k('b', 'back')]
    : [seg('ctrl+x tab', O.opus), seg(' focus   ', O.soft), seg('/nexus', O.opus), seg(' commands   ', O.soft), seg('/nexus settings', O.opus)]
  return fitLine(line, w)
}

// ---- the whole dashboard ------------------------------------------------------------------
export type Mode = 'wide' | 'stacked' | 'narrow'

/**
 * wide: the lead beside the advisor and Council; stacked: one column, the advisor and Council side
 * by side below the lead; narrow: one column, everything trimmed. Wide starts at 112 columns so the
 * lead keeps room for the medium picture and its words (about 68 columns).
 */
export function orbitMode(w: number, layout: 'auto' | 'full' | 'compact' | 'minimal'): Mode {
  if (layout === 'compact') return w >= 72 ? 'stacked' : 'narrow'
  if (w >= 112) return 'wide'
  return w >= 68 ? 'stacked' : 'narrow'
}

/**
 * The dashboard for a pane `w` wide and, when known, `rows` tall. It draws with one blank row between
 * groups; if that does not fit the pane's height it draws again without them (and without the
 * lead's padding), so the bottom of the dashboard is never what is cut off.
 */
export function orbitLines(s: Snapshot, w: number, rows?: number): Line[] {
  const roomy = build(s, w, s.prefs.density === 'comfortable')
  if (rows === undefined || roomy.length <= rows || s.prefs.density !== 'comfortable') return roomy
  return build(s, w, false)
}

function build(s: Snapshot, w: number, isRoomy: boolean): Line[] {
  const v = visibility(s.prefs)
  const mode = orbitMode(w, s.prefs.layout)
  // One blank row between groups (none when tight): always the same, never more.
  const gap = isRoomy ? [blank(w)] : []
  const out: Line[] = [...header(s, w)]
  const warn = alerts(s)
  for (const a of warn) out.push(fitLine([seg('! ', a.colour, true), flex(a.text, a.colour)], w))
  out.push(...gap)

  const hasJev = v.routing && s.prefs.jev !== 'hidden'
  const showCouncil = v.routing
  if (mode === 'wide') {
    // The lead at the left, the advisor over the Council at the right, one blank row between. The
    // right column is exactly as tall as it needs to be: if the lead is taller the rest is blank.
    const rightW = Math.max(40, Math.floor(w * 0.36))
    const leftW = w - rightW - 1
    const right: Line[] = [...advisorPanel(s, rightW)]
    if (showCouncil) right.push(...gap.map(() => blank(rightW)), ...councilPanel(s, rightW))
    const lead = leadPanel(s, leftW, isRoomy)
    if (s.prefs.agentLinks) out.push(...besideLinked(lead, leftW, right, rightW, sideLinks(s, advisorPanel(s, rightW).length, gap.length, showCouncil, s.reduceMotion || s.prefs.animation === 'off')))
    else out.push(...beside(lead, leftW, right, rightW))
  } else {
    out.push(...leadPanel(s, w, isRoomy))
    if (mode === 'stacked' && w >= 76 && showCouncil) {
      // Advisor and Council side by side, the same width each, the same height.
      const aw = Math.floor((w - 1) / 2)
      const cw = w - aw - 1
      // Siblings in one row share a height: the shorter one gets blank rows inside its border, so the bottoms line up.
      const h = Math.max(advisorPanel(s, aw).length, councilPanel(s, cw).length)
      out.push(...(s.prefs.agentLinks && isRoomy ? [connectorRow(s, aw, cw, w)] : gap), ...beside(advisorPanel(s, aw, h), aw, councilPanel(s, cw, h), cw))
    } else {
      out.push(...gap, ...advisorPanel(s, w))
      if (showCouncil) out.push(...gap, ...councilPanel(s, w))
    }
  }
  out.push(...gap)
  if (hasJev) out.push(...jevPanel(s, w), ...gap)
  out.push(...haikuPanel(s, w, mode === 'narrow' ? 4 : 6))
  const n = Math.min(s.prefs.logRows, v.activity ? 6 : 0)
  if (v.activity && n > 0) out.push(...gap, ...tapePanel(s, w, n))
  const usage = usagePanel(s, w)
  if (usage.length) out.push(...gap, ...usage)
  return out
}

export const ORBIT_BG = O.bg
