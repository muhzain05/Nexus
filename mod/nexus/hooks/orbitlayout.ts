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
  hole: { blank: '#000000', faint: '#4a2a14', low: '#8a4f22', mid: '#d9823a', high: '#ffb55e' },
} as const

const cells = (t: string) => [...t].length
export const width = (l: Line) => l.reduce((n, x) => n + cells(x.t), 0)
const seg = (t: string, c?: string, b?: boolean): Seg => ({ t, c, b })
const flex = (t: string, c?: string): Seg => ({ t, c, flex: true })
const cut = (t: string, n: number) => (n <= 0 ? '' : cells(t) <= n ? t : n === 1 ? '…' : `${[...t].slice(0, n - 1).join('')}…`)

/** Pads or trims a row to exactly `w` cells; the flexible field gives way first, the right end last. */
export function fitLine(line: Line, w: number): Line {
  let over = width(line) - w
  const out = line.map(x => ({ ...x }))
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

/** Sonnet's words, as rows: who, what it does, effort, and the state with its clock. Never cut by width. */
function leadText(s: Snapshot): Line[] {
  const effort = s.lead.effort ?? 'N/A'
  const level = EFFORT.indexOf(effort) + 1
  const rows: Line[] = [
    [seg(modelLabel(s.lead.model), O.sonnet, true)],
    [seg('main session', O.dim)],
    [],
    [seg('edits + runs tests', O.soft)],
    [seg('effort ', O.soft), seg('▮'.repeat(Math.max(0, level)), O.sonnet), seg('▯'.repeat(Math.max(0, 5 - level)), O.faint), seg(` ${effort}`, O.sonnet)],
    s.lead.turnStartedAt === null
      ? [seg(`idle · ${s.lead.steps} steps`, O.dim)]
      : s.lead.isWaiting
        ? [seg('◌ waiting for you', O.amber)]
        : [seg(`${spinner(s)} working ${elapsed(s.now - s.lead.turnStartedAt)}`, O.sonnet)],
  ]
  const asked = s.lead.requested
  if (asked !== null && s.lead.model !== null && modelLabel(asked) !== modelLabel(s.lead.model)) rows.push([seg(`asked ${modelLabel(asked)}`, O.amber)], [seg(`answered by ${modelLabel(s.lead.model)}`, O.amber)])
  if (s.mode.relaunch) rows.push([seg('advisor change waits', O.amber)], [seg('for a relaunch', O.amber)])
  return rows
}

/** Which composition the lead panel draws, and whether the words sit beside it, for `inner` columns. */
export function leadPlan(inner: number, density: 'comfortable' | 'compact', graphic: Snapshot['prefs']['centerpiece']): { size: BhSize | null; isBeside: boolean } {
  if (graphic !== 'blackhole') return { size: null, isBeside: false }
  const rowsOk = density === 'compact' ? 7 : 10
  // Words are at most 20 cells; a composition beside them needs its own width plus a 3-cell gutter.
  for (const size of ['large', 'medium', 'small'] as const) {
    if (density === 'compact' && size === 'large') continue
    if (DIMENSIONS[size].rows > Math.max(rowsOk, 7) + (size === 'large' ? 4 : 0)) continue
    if (inner >= DIMENSIONS[size].cols + 3 + 20 && (size !== 'large' || inner >= 96)) return { size, isBeside: true }
  }
  // Too narrow to sit beside the words: the smallest composition above them, if it fits at all.
  return { size: inner >= DIMENSIONS.small.cols ? 'small' : null, isBeside: false }
}

export function leadPanel(s: Snapshot, w: number, isRoomy = s.prefs.density === 'comfortable'): Line[] {
  const inner = w - 4
  const comfortable = isRoomy
  const plan = leadPlan(inner, s.prefs.density, s.prefs.centerpiece)
  const rows: Line[] = []
  const ms = s.reduceMotion || s.prefs.animation === 'off' ? null : s.now
  const art: Line[] =
    plan.size !== null
      ? holeLines(blackHole(ms, plan.size, s.prefs.animationSpeed, s.isMono === true))
      : s.prefs.centerpiece === 'classic'
        ? spriteLines(coreOrbit(isWorking(s) && !s.reduceMotion ? s.now - (s.lead.turnStartedAt ?? s.now) : null), { core: O.sonnet, sat: O.sonnetHi, trail: O.sonnet, faint: O.faint })
        : []
  const text = leadText(s)
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
    for (const l of [text[0]!, text[3]!, text[4]!, text[5]!, ...text.slice(6)]) rows.push(centre(l, inner))
  }
  if (comfortable) {
    rows.unshift([])
    rows.push([])
  }
  return panel({ title: 'Lead session', titleColor: O.sonnet, edge: O.edge.lead, width: w, rows, accent: true, tag: [seg('▸ main', O.dim)] })
}

// ---- advisor and council ------------------------------------------------------------------
function advisorPanel(s: Snapshot, w: number): Line[] {
  const a = s.advisor
  const v = visibility(s.prefs)
  const rows: Line[] = []
  const lastLabel = a.lastAt === null ? 'not yet consulted' : `last ${elapsed(s.now - a.lastAt)} ago`
  rows.push([seg('↳ ', O.dim), seg(`calls ${a.calls}`, O.soft), seg('  ·  ', O.faint), flex(lastLabel, O.soft)])
  const c = s.prefs.council.activation
  rows.push([seg('↳ ', O.dim), seg('council ', O.soft), seg(c === 'off' ? 'off' : c === 'on' ? 'all three' : 'adaptive', c === 'on' ? O.amber : O.opus)])
  // What the last consultation read and how long it took, as Claude Code reported it; nothing when it never ran.
  if (a.calls > 0 && v.times) rows.push([seg('↳ ', O.dim), seg(`read ${compact(a.contextAtCall)} ctx`, O.soft), seg('  ·  ', O.faint), seg(a.lastMs === null ? 'time N/A' : `took ${elapsed(a.lastMs)}`, O.soft)])
  return panel({ title: `${advisorLabel(s)} advisor`, titleColor: O.opus, edge: O.edge.advisor, width: w, rows, accent: true })
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

function councilPanel(s: Snapshot, w: number): Line[] {
  const v = visibility(s.prefs)
  const mode = s.prefs.council.activation
  const rows: Line[] = []
  if (mode === 'off') {
    rows.push([seg('off · the single advisor reviews', O.dim)])
    return panel({ title: 'Council', titleColor: O.opus, edge: O.edge.council, width: w, rows })
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
    rows.push([seg(`tokens in ${compact(t.input)} out ${compact(t.output)}`, O.dim)])
  }
  const tag: Line = authorized.length ? [seg(done === authorized.length ? '✓ ' : '', O.green), seg(`${done}/${authorized.length}`, done === authorized.length ? O.green : O.soft)] : [seg(mode, O.dim)]
  return panel({ title: 'Council', titleColor: O.opus, edge: O.edge.council, width: w, rows, tag })
}

// ---- jev -----------------------------------------------------------------------------------
const QUESTIONS = ['which file', 'which tool', 'retry or stop']

function jevPanel(s: Snapshot, w: number): Line[] {
  const j = s.jev
  const inner = w - 4
  const rows: Line[] = []
  const state = j.status === 'off' ? 'off' : j.status === 'down' ? `down${j.reason ? ` (${j.reason})` : ''}` : j.routing === 'active' ? 'active' : j.routing === 'calibrating' ? 'calibrating' : 'observe only'
  const stateColour = j.status === 'down' ? O.amber : j.routing === 'active' ? O.jevHi : O.dim
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
  const tag: Line = isRoomy ? [seg(`decisions ${j.decisions}`, O.soft), seg('  ', O.faint), seg(state, stateColour)] : [seg(state, stateColour)]
  if (!isRoomy) rows.push([seg(`decisions ${j.decisions}  ·  ${agreed}`, O.dim)])
  else if (j.status !== 'off') rows.push([seg(`sharp ≥ 0.85  ·  ${agreed}  ·  abstained ${j.fallbacks}`, O.dim)])
  return panel({ title: 'Jev · routing', titleColor: O.jev, edge: O.edge.jev, width: w, rows, tag, accent: true })
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
    const left: Line = [seg(a.status === 'running' ? `${spinner(s)} ` : `${STATUS_GLYPH[a.status]} `, col), seg(a.label.padEnd(labelW), O.fg, true), flex(task, O.soft)]
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

function tapePanel(s: Snapshot, w: number, n: number): Line[] {
  const shown = tapeRows(s.log).slice(-n)
  const rows: Line[] = shown.map(r => {
    const who = WHO[r.who] ?? WHO.haiku
    return [seg(clock(r.at), O.dim), seg('  '), seg(who.label.padEnd(8), who.colour, true), flex(r.text, KIND_COLOUR[r.kind])]
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
    out.push(...beside(leadPanel(s, leftW, isRoomy), leftW, right, rightW))
  } else {
    out.push(...leadPanel(s, w, isRoomy))
    if (mode === 'stacked' && w >= 76 && showCouncil) {
      // Advisor and Council side by side, the same width each, the same height.
      const aw = Math.floor((w - 1) / 2)
      const cw = w - aw - 1
      const adv = advisorPanel(s, aw)
      const cou = councilPanel(s, cw)
      out.push(...gap, ...beside(adv, aw, cou, cw))
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
