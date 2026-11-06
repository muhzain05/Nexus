// Exports sample-data screens (the test fixtures, drawn by the real layout code) as terminal snapshots that render.py
// can draw, so the "rendered from sample data" images use the current renderer. Nothing here is live:
// the docs label these images as sample data.
//
//   .github/scripts/capture/samples.sh <outdir> agent-failed telemetry-full hole-medium
//
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { drawBlackHole } from '../../../mod/nexus/hooks/blackhole'
import { orbitLines } from '../../../mod/nexus/hooks/orbitlayout'
import { FIXTURES } from '../../../mod/nexus/tests/fixtures'

const [out, ...names] = process.argv.slice(2)
if (!out || names.length === 0) throw new Error('usage: samples <outdir> <fixture name>...')
mkdirSync(out, { recursive: true })

for (const name of names) {
  if (name.startsWith('hole-')) {   // the black hole's resting picture, one composition: hole-small | hole-medium | hole-large
    const sprite = drawBlackHole(name.slice(5) as 'small' | 'medium' | 'large', null)
    const rows = sprite.map(r => r.map(g => [g.text, (g.fg ?? 'default').replace('#', ''), 'default', false, false]))
    const meta = { cols: Math.max(...sprite.map(r => r.reduce((n, g) => n + [...g.text].length, 0))), rows: sprite.length, source: name, steps_log: [] }
    writeFileSync(join(out, `${name}.jsonl`), `${JSON.stringify({ meta })}\n${JSON.stringify({ t: 0, cursor: [0, 0, false], rows })}\n`)
    console.log(`wrote ${name}: ${meta.cols} columns, ${meta.rows} rows`)
    continue
  }
  const f = FIXTURES.find(x => x.name === name)
  if (!f) throw new Error(`no fixture named ${name}`)
  const lines = orbitLines(f.state(), f.width)
  // A run is [text, fg, bg, bold, reverse], the same shape record.py writes.
  const rows = lines.map(l => l.map(g => [g.t, (g.c ?? 'default').replace('#', ''), (g.bg ?? 'default').replace('#', ''), !!g.b, false]))
  const meta = { cols: f.width, rows: lines.length, source: `fixture ${name}`, steps_log: [] }
  writeFileSync(join(out, `${name}.jsonl`), `${JSON.stringify({ meta })}\n${JSON.stringify({ t: 0, cursor: [0, 0, false], rows })}\n`)
  console.log(`wrote ${name}: ${f.width} columns, ${lines.length} rows`)
}
