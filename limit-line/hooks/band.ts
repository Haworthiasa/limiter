// The band's two lines: limits plus the last turn's extras, and the turn detail line.
// Pure: built from values, measured in cells, trimmed to fit.

import type { LastTurn, View } from '../types'
import { lineFor, SEP, TIERS, width } from './limits'
import type { Tier } from './limits'
import type { Segment } from './limits'
import { cacheHit } from './metrics'

export type Extras = {
  /** Cache hit of the last turn, 0..1. */
  cacheHit?: number
  /** Context change over the last turn, tokens. */
  delta?: number
  /** The context window `delta` is judged against. */
  window?: number
  /** Characters the distiller cut this session. */
  dist: number
}

/** The extras of a finished turn; nothing before the first one. */
export function extrasOf(last: LastTurn | null, dist: number): Extras {
  if (last === null) return { dist }
  return { cacheHit: cacheHit(last), delta: last.delta, window: last.window, dist }
}

export function fmtTokens(n: number): string {
  const a = Math.abs(n)
  if (a < 1000) return `${Math.round(n)}`
  if (a < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (a < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Green from 80%, yellow from 50%, red below: a high cache hit is good. */
export function cacheColor(pct: number): string {
  if (pct >= 80) return 'green'
  if (pct >= 50) return 'yellow'
  return 'red'
}

/** Red when the turn moved the context by more than a tenth of the window. */
export function deltaColor(delta: number, window: number | undefined): string {
  return window !== undefined && Math.abs(delta) > window * 0.1 ? 'red' : 'yellow'
}

export function deltaText(delta: number): string {
  return delta < 0 ? `▼-${fmtTokens(-delta)}` : `▲+${fmtTokens(delta)}`
}

const LEVELS = '▁▂▃▄▅▆▇█'

/** One cell per value, scaled to the largest. */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values)
  return values.map(v => LEVELS[max > 0 ? Math.round((Math.max(0, v) / max) * 7) : 0]).join('')
}

export function shortModel(model: string): string {
  return /opus|sonnet|haiku|fable|mythos/.exec(model)?.[0] ?? model
}

type Extra = 'cache' | 'delta' | 'dist'
// Lowest priority last: dropped first.
const EXTRA_ORDER: Extra[] = ['cache', 'delta', 'dist']

function withExtras(base: Segment[], view: View, ex: Extras, keep: readonly Extra[]): Segment[] {
  const out = [...base]
  if (keep.includes('delta') && ex.delta !== undefined) {
    const seg = { text: deltaText(ex.delta), color: deltaColor(ex.delta, ex.window) }
    // Next to the ctx figure it changes; on its own when there is none.
    if (view.ctx !== undefined) out.push({ text: ' ' }, seg)
    else out.push(...(out.length > 0 ? [SEP] : []), { text: 'ctx ', dim: true }, seg)
  }
  if (keep.includes('cache') && ex.cacheHit !== undefined) {
    const pct = Math.round(ex.cacheHit * 100)
    out.push(...(out.length > 0 ? [SEP] : []), { text: 'cache ', dim: true }, { text: `${pct}%`, color: cacheColor(pct) })
  }
  if (keep.includes('dist') && ex.dist > 0) {
    out.push(...(out.length > 0 ? [SEP] : []), { text: 'dist ', dim: true }, { text: `-${fmtTokens(ex.dist)}` })
  }
  return out
}

/** The widest first line that fits `columns`: extras go lowest priority first, then the
 * limits drop detail tier by tier as before. */
export function bandLine(view: View, ex: Extras, columns: number, offsetMin: number): Segment[] {
  const hasLimits = view.five !== undefined || view.week !== undefined || view.ctx !== undefined
  const hasExtras = ex.cacheHit !== undefined || ex.delta !== undefined || ex.dist > 0
  if (!hasLimits && !hasExtras) return [{ text: 'limits: chờ lượt trả lời đầu tiên…', dim: true }]

  const [full, ...narrower] = TIERS as [Tier, ...Tier[]]
  let line: Segment[] = []
  for (let n = EXTRA_ORDER.length; n >= 0; n--) {
    line = withExtras(lineFor(view, full, offsetMin), view, ex, EXTRA_ORDER.slice(0, n))
    if (width(line) <= columns) return line
  }
  for (const tier of narrower) {
    line = lineFor(view, tier, offsetMin)
    if (width(line) <= columns) return line
  }
  return line
}

/** `turn 4 req · in 61k (cache 55k · write 4k · new 2k) · out 2.3k · ~$0.42 · opus · ctx ▂▃▄▆█`,
 * its least needed parts dropped until it fits. */
export function turnLine(t: LastTurn, history: readonly number[], cost: number | undefined, columns: number): Segment[] {
  const parts: { prio: number; segs: Segment[] }[] = [
    { prio: 1, segs: [{ text: 'turn ', dim: true }, { text: `${t.requests} req` }] },
    {
      prio: 1,
      segs: [{ text: 'in ', dim: true }, { text: fmtTokens(t.input + t.cacheRead + t.cacheWrite) }],
    },
    {
      prio: 3,
      segs: [
        {
          text: ` (cache ${fmtTokens(t.cacheRead)} · write ${fmtTokens(t.cacheWrite)} · new ${fmtTokens(t.input)})`,
          dim: true,
        },
      ],
    },
    { prio: 1, segs: [{ text: 'out ', dim: true }, { text: fmtTokens(t.output) }] },
  ]
  if (cost !== undefined) parts.push({ prio: 2, segs: [{ text: `~$${cost.toFixed(2)}` }] })
  if (t.model) parts.push({ prio: 4, segs: [{ text: shortModel(t.model), dim: true }] })
  if (history.length > 1) parts.push({ prio: 5, segs: [{ text: 'ctx ', dim: true }, { text: sparkline(history), color: 'cyan' }] })

  const DOT: Segment = { text: ' · ', dim: true }
  const build = (maxPrio: number): Segment[] => {
    const out: Segment[] = []
    for (const [i, p] of parts.entries()) {
      if (p.prio > maxPrio) continue
      // The breakdown hangs off `in`; every other part is its own.
      if (i !== 2 && out.length > 0) out.push(DOT)
      out.push(...p.segs)
    }
    return out
  }
  for (let maxPrio = 5; maxPrio > 1; maxPrio--) {
    const line = build(maxPrio)
    if (width(line) <= columns) return line
  }
  return build(1)
}
