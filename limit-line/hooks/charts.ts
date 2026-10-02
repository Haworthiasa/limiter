// Character charts: one-cell glyphs only (PLAN §2.9). Pure.

import type { Segment } from './limits.ts'
import { width } from './limits.ts'

export type Part = { value: number; color: string }

/** A bar of `cells` cells split between the parts in proportion, by largest remainder. */
export function stacked(parts: readonly Part[], cells: number): Segment[] {
  const total = parts.reduce((n, p) => n + Math.max(0, p.value), 0)
  if (total <= 0 || cells <= 0) return []
  const exact = parts.map(p => (Math.max(0, p.value) / total) * cells)
  const floor = exact.map(Math.floor)
  let left = cells - floor.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    floor[i] = (floor[i] as number) + 1
    left--
  }
  return parts
    .map((p, i) => ({ text: '█'.repeat(floor[i] as number), color: p.color }))
    .filter(s => s.text.length > 0)
}

/** A one-colour bar of `pct` percent over `cells` cells. */
export function hbar(pct: number, cells: number, color: string): Segment[] {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cells)
  return [{ text: '█'.repeat(filled), color }, { text: '░'.repeat(cells - filled), dim: true }]
}

const LEVELS = '▁▂▃▄▅▆▇█'

/** One cell per value, on a fixed 0..max scale; undefined is a gap. */
export function spark(values: readonly (number | undefined)[], max?: number): string {
  const top = max ?? Math.max(0, ...values.filter((v): v is number => v !== undefined))
  return values
    .map(v => (v === undefined ? ' ' : LEVELS[top > 0 ? Math.min(7, Math.round((Math.max(0, v) / top) * 7)) : 0]))
    .join('')
}

/** Pads a line with spaces to `cells`, or clips it there. */
export function fit(line: Segment[], cells: number): Segment[] {
  const w = width(line)
  if (w === cells) return line
  if (w < cells) return [...line, { text: ' '.repeat(cells - w) }]
  const out: Segment[] = []
  let left = cells
  for (const s of line) {
    if (left <= 0) break
    const chars = [...s.text]
    if (chars.length <= left) {
      out.push(s)
      left -= chars.length
    } else {
      out.push({ ...s, text: chars.slice(0, Math.max(0, left - 1)).join('') + '…' })
      left = 0
    }
  }
  return out
}

/** Columns side by side, each padded to its width, `gap` spaces between. */
export function columns(cols: readonly Segment[][][], widths: readonly number[], gap = 2): Segment[][] {
  const rows = Math.max(0, ...cols.map(c => c.length))
  const out: Segment[][] = []
  for (let r = 0; r < rows; r++) {
    const line: Segment[] = []
    cols.forEach((c, i) => {
      if (i > 0) line.push({ text: ' '.repeat(gap) })
      line.push(...fit(c[r] ?? [], widths[i] as number))
    })
    out.push(line)
  }
  return out
}
