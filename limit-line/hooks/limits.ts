// Pure logic for limit-line: no engine calls, so it can be tested on its own.

import type { Reading, View, Win } from '../types'

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const KINDS = { five_hour: FIVE_HOUR_MS, seven_day: WEEK_MS } as const
export type Kind = keyof typeof KINDS

// A rate is only quoted once readings span 5% of the window: whole-percent
// readings are a step function, and a single tick over a short span lies.
const MIN_SPAN_SHARE = 0.05

export type Segment = { text: string; color?: string; dim?: boolean }

export function colorOf(pct: number): string {
  if (pct >= 80) return 'red'
  if (pct >= 50) return 'yellow'
  return 'green'
}

export function bar(pct: number, cells: number): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`
  return `${mins}m`
}

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

// Weekday and clock time of `ms` in the given UTC offset (minutes east).
export function dayTime(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${WEEKDAYS[d.getUTCDay()]} ${hh}:${mm}`
}

// Keeps the readings that still describe the current window.
export function addReading(list: Reading[], next: Reading, windowMs: number): Reading[] {
  const last = list[list.length - 1]
  // A drop of more than half a point means the window reset.
  const kept = last !== undefined && next.pct < last.pct - 0.5 ? [] : list
  return [...kept, next].filter(r => next.at - r.at <= windowMs).slice(-500)
}

// When the window fills at the recent pace, or undefined when it does not
// fill before it resets, the pace is flat, or there is too little to go on.
export function fullAt(
  list: Reading[],
  windowMs: number,
  resetsAt: number | undefined,
): number | undefined {
  const first = list[0]
  const last = list[list.length - 1]
  if (first === undefined || last === undefined) return undefined
  const span = last.at - first.at
  if (span < windowMs * MIN_SPAN_SHARE) return undefined
  const perMs = (last.pct - first.pct) / span
  if (perMs <= 0) return undefined
  const at = last.at + (100 - last.pct) / perMs
  if (resetsAt !== undefined && at >= resetsAt) return undefined
  return at
}

// The toast level a reading has reached: 0, 80 or 95.
export function warnLevel(pct: number): 0 | 80 | 95 {
  if (pct >= 95) return 95
  if (pct >= 80) return 80
  return 0
}

export type Tier = { cells: number; weekReset: boolean; eta: boolean }

export const TIERS: Tier[] = [
  { cells: 6, weekReset: true, eta: true },
  { cells: 4, weekReset: false, eta: true },
  { cells: 0, weekReset: false, eta: false },
]

export const SEP: Segment = { text: ' | ', dim: true }

function windowSegments(
  label: string,
  win: Win,
  now: number,
  tier: Tier,
  resetText: (at: number) => string,
  showReset: boolean,
): Segment[] {
  const color = colorOf(win.pct)
  const out: Segment[] = [{ text: `${label} `, dim: true }]
  if (tier.cells > 0) {
    out.push({ text: `${bar(win.pct, tier.cells)} `, color })
  }
  out.push({ text: `${Math.round(win.pct)}%`, color })
  if (showReset && win.resetsAt !== undefined) {
    out.push({ text: ` ${resetText(win.resetsAt)}`, dim: true })
  }
  if (tier.eta && win.fullAt !== undefined && win.fullAt > now) {
    out.push({ text: ` !${duration(win.fullAt - now)}`, color: 'red' })
  }
  return out
}

export function lineFor(view: View, tier: Tier, offsetMin: number): Segment[] {
  const parts: Segment[][] = []
  const now = view.now
  if (view.five) {
    parts.push(windowSegments('5h', view.five, now, tier, at => duration(at - now), true))
  }
  if (view.week) {
    parts.push(windowSegments('wk', view.week, now, tier, at => dayTime(at, offsetMin), tier.weekReset))
  }
  if (view.ctx !== undefined) {
    const ctxWin: Win = { pct: view.ctx }
    parts.push(windowSegments('ctx', ctxWin, now, { ...tier, eta: false }, () => '', false))
  }
  return parts.flatMap((p, i) => (i === 0 ? p : [SEP, ...p]))
}

export function width(segments: Segment[]): number {
  return segments.reduce((n, s) => n + [...s.text].length, 0)
}
