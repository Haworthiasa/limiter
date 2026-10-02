// What /usage-plus shows, computed from the files the mod and the indexer keep. Pure.

import type { BustEvent, CompactMark, DashData, DayAgg, DayRow, DistillEvent, DistillSummary, LimitsHistory, MeasureSnapshot, RequestRecord, Share, Tokens, TurnRow } from '../types'

export type { DashData, DayRow, DistillSummary, LimitsHistory, Share, TurnRow }
import { bustCause, cacheHit, costOf, ctxOf, elsewhereShare, isBust, savings } from './metrics.ts'
import type { Prev } from './metrics.ts'
import { dayKey, TZ_OFFSET_MIN } from './paths.ts'

const DAY_MS = 86_400_000
const FIVE_H_MS = 5 * 3_600_000
const WEEK_MS = 7 * DAY_MS

export const totalOf = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  t.input + t.output + t.cacheRead + t.cacheWrite

/** `n` dates ending at `today`, oldest first. */
export function lastDates(today: string, n: number): string[] {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number]
  const base = Date.UTC(y, m - 1, d)
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10))
}

function sumModels(day: DayAgg, f: (t: Tokens, model: string) => number | undefined): number {
  return Object.entries(day.byModel).reduce((n, [model, t]) => n + (f(t, model) ?? 0), 0)
}

export function dayRows(days: readonly DayAgg[], dates: readonly string[]): DayRow[] {
  const byDate = new Map(days.map(d => [d.date, d]))
  return dates.map(date => {
    const d = byDate.get(date)
    if (!d) return { date, read: 0, write: 0, input: 0, output: 0, cost: 0, savings: 0, requests: 0 }
    const t = d.total
    const row: DayRow = {
      date,
      read: t.cacheRead,
      write: t.cacheWrite,
      input: t.input,
      output: t.output,
      cost: t.costUsd,
      savings: sumModels(d, (tok, model) => savings(tok, model)),
      requests: d.requests,
    }
    const hit = cacheHit(t)
    if (hit !== undefined) row.hit = hit
    return row
  })
}

export function shares(days: readonly DayAgg[], key: 'byModel' | 'byProject', top = 4, short = (s: string) => s): Share[] {
  const sums = new Map<string, number>()
  for (const d of days) {
    for (const [name, t] of Object.entries(d[key])) sums.set(short(name), (sums.get(short(name)) ?? 0) + totalOf(t))
  }
  const all = [...sums.values()].reduce((a, b) => a + b, 0)
  const sorted = [...sums.entries()].sort((a, b) => b[1] - a[1])
  const head = sorted.slice(0, top).map(([name, tokens]) => ({ name, tokens, share: all > 0 ? tokens / all : 0 }))
  const rest = sorted.slice(top).reduce((n, [, t]) => n + t, 0)
  if (rest > 0) head.push({ name: 'khác', tokens: rest, share: rest / all })
  return head
}

/** The session's main-loop turns, oldest first. */
export function sessionTurns(records: readonly RequestRecord[]): TurnRow[] {
  const rows: TurnRow[] = []
  const byTurn = new Map<string, RequestRecord[]>()
  for (const r of records) {
    if (r.isSubagent) continue
    const id = r.turnId ?? `@${r.ts}`
    if (!byTurn.has(id)) byTurn.set(id, [])
    byTurn.get(id)?.push(r)
  }
  let prevCtx: number | undefined
  for (const [turnId, rs] of byTurn) {
    const sum = rs.reduce(
      (t, r) => ({ input: t.input + r.input, output: t.output + r.output, cacheRead: t.cacheRead + r.cacheRead, cacheWrite: t.cacheWrite + r.cacheWrite }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    )
    const last = rs[rs.length - 1] as RequestRecord
    const ctx = ctxOf(last)
    const row: TurnRow = {
      turnId,
      ts: (rs[0] as RequestRecord).ts,
      requests: rs.length,
      ctx,
      cost: rs.reduce((n, r) => n + (costOf(r, r.model) ?? 0), 0),
    }
    const hit = cacheHit(sum)
    if (hit !== undefined) row.hit = hit
    if (prevCtx !== undefined) row.delta = ctx - prevCtx
    prevCtx = ctx
    rows.push(row)
  }
  return rows
}

/** Busts among a session's live requests (no 5m/1h split: the live TTL default). */
export function sessionBusts(records: readonly RequestRecord[], marks: readonly CompactMark[]): BustEvent[] {
  const out: BustEvent[] = []
  let prev: (Prev & { ts: number }) | undefined
  for (const r of records) {
    if (r.isSubagent) continue
    if (prev && isBust(r, prev)) {
      const p = prev
      const compactBetween = marks.some(m => m.sessionId === r.sessionId && m.ts >= p.ts && m.ts <= r.ts)
      out.push({
        ts: r.ts,
        sessionId: r.sessionId,
        project: r.project,
        model: r.model,
        prevModel: p.model,
        gapMs: r.ts - p.ts,
        ctx: ctxOf(r),
        cacheRead: r.cacheRead,
        cause: bustCause(r, p, compactBetween),
      })
    }
    prev = { ts: r.ts, model: r.model }
  }
  return out
}

function windowsOf(snaps: readonly MeasureSnapshot[]): Map<number, MeasureSnapshot[]> {
  const out = new Map<number, MeasureSnapshot[]>()
  for (const s of snaps) {
    if (s.resetsAt5h === undefined) continue
    const key = Math.round(s.resetsAt5h / 60_000) * 60_000
    if (!out.has(key)) out.set(key, [])
    out.get(key)?.push(s)
  }
  return out
}

export function limitsHistory(snaps: readonly MeasureSnapshot[], records: readonly RequestRecord[], now: number, dates: readonly string[]): LimitsHistory {
  const out: LimitsHistory = { five: [], week: [] }
  const windows = [...windowsOf(snaps).entries()].sort((a, b) => a[0] - b[0])
  const peaks = windows.map(([reset, ss]) => {
    const top = ss.reduce((a, b) => (b.fiveHourPct > a.fiveHourPct ? b : a))
    return { reset, pct: top.fiveHourPct, ts: top.ts }
  })
  out.five = peaks.slice(-7).map(p => p.pct)
  const peak = peaks.slice(-7).reduce<(typeof peaks)[number] | undefined>((a, b) => (a === undefined || b.pct > a.pct ? b : a), undefined)
  if (peak) out.fivePeak = { pct: peak.pct, ts: peak.ts }

  out.week = dates.map(date => {
    const ss = snaps.filter(s => dayKey(s.ts, TZ_OFFSET_MIN) === date)
    return ss.length > 0 ? Math.max(...ss.map(s => s.weekPct)) : undefined
  })
  const last = snaps[snaps.length - 1]
  if (last) {
    out.weekNow = last.weekPct
    if (last.resetsAtWeek !== undefined) {
      const elapsed = last.ts - (last.resetsAtWeek - WEEK_MS)
      if (elapsed > 6 * 3_600_000) out.weekForecast = Math.round((last.weekPct / elapsed) * WEEK_MS)
    }
  }

  // Usage elsewhere: each 5-hour window's peak against what this machine spent in it.
  const costIn = (from: number, to: number) =>
    records.filter(r => r.ts >= from && r.ts < to).reduce((n, r) => n + (costOf(r, r.model) ?? 0), 0)
  const done = peaks.filter(p => p.reset <= now).map(p => ({ pctUsed: p.pct, localCost: costIn(p.reset - FIVE_H_MS, p.reset) }))
  const current = peaks.find(p => p.reset > now)
  if (current) {
    const share = elsewhereShare(done, { pctUsed: current.pct, localCost: costIn(current.reset - FIVE_H_MS, now) })
    if (share !== undefined) out.elsewhere = share
  }
  return out
}

export function distillSummary(events: readonly DistillEvent[]): DistillSummary {
  const byKind = new Map<string, { kind: string; n: number; cut: number }>()
  let cut = 0
  let reread = 0
  for (const e of events) {
    const c = Math.max(0, e.rawChars - e.outChars)
    cut += c
    if (e.reread) reread++
    const k = byKind.get(e.kind) ?? { kind: e.kind, n: 0, cut: 0 }
    k.n++
    k.cut += c
    byKind.set(e.kind, k)
  }
  return { count: events.length, cut, reread, byKind: [...byKind.values()].sort((a, b) => b.cut - a.cut) }
}

export type DashInput = {
  now: number
  sessionId: string
  days: DayAgg[]
  ledger: RequestRecord[]
  marks: CompactMark[]
  snaps: MeasureSnapshot[]
  distill: DistillEvent[]
  shortModel: (m: string) => string
  indexer?: { newLines: number; bad: number } | { error: string }
}

export function buildDash(i: DashInput): DashData {
  const today = dayKey(i.now, TZ_OFFSET_MIN)
  const dates35 = lastDates(today, 35)
  const week = new Set(dates35.slice(-7))
  const month = new Set(dates35.slice(-30))
  const weekDays = i.days.filter(d => week.has(d.date))
  const monthDays = i.days.filter(d => month.has(d.date))
  const mine = i.ledger.filter(r => r.sessionId === i.sessionId).sort((a, b) => a.ts - b.ts)
  const inWeek = (ts: number) => week.has(dayKey(ts, TZ_OFFSET_MIN))
  const inMonth = (ts: number) => month.has(dayKey(ts, TZ_OFFSET_MIN))

  const data: DashData = {
    builtAt: i.now,
    sessionId: i.sessionId,
    days: dayRows(i.days, dates35),
    week: { byModel: shares(weekDays, 'byModel', 3, i.shortModel), byProject: shares(weekDays, 'byProject', 3) },
    month: { byModel: shares(monthDays, 'byModel', 3, i.shortModel), byProject: shares(monthDays, 'byProject', 3) },
    busts: weekDays
      .flatMap(d => d.busts)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5),
    session: { turns: sessionTurns(mine), busts: sessionBusts(mine, i.marks) },
    limits: limitsHistory(i.snaps, i.ledger, i.now, dates35.slice(-7)),
    distillWeek: distillSummary(i.distill.filter(e => inWeek(e.ts))),
    distillMonth: distillSummary(i.distill.filter(e => inMonth(e.ts))),
  }
  if (i.indexer && 'error' in i.indexer) data.indexerError = i.indexer.error
  else if (i.indexer && i.indexer.newLines > 0) data.badShare = i.indexer.bad / i.indexer.newLines
  return data
}
