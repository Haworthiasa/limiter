// The live ledger's pure half: records from step usage, files by day, sparse snapshots.

import type { MeasureSnapshot, RequestRecord } from '../types'
import { dayKey, TZ_OFFSET_MIN } from './paths.ts'
import type { StepUsage } from './turnstats.ts'

export function toRecord(
  usage: StepUsage,
  at: { ts: number; sessionId: string; project: string; turnId: string; agentId?: string; ms?: number },
): RequestRecord {
  return {
    ts: at.ts,
    sessionId: at.sessionId,
    project: at.project,
    model: usage.model,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    turnId: at.turnId,
    ...(at.ms !== undefined ? { durationMs: at.ms } : {}),
    isSubagent: at.agentId !== undefined,
    source: 'live',
  }
}

/** Records grouped by the Bangkok day they belong to. */
export function byDay(records: readonly RequestRecord[]): Map<string, RequestRecord[]> {
  const out = new Map<string, RequestRecord[]>()
  for (const r of records) {
    const k = dayKey(r.ts, TZ_OFFSET_MIN)
    out.set(k, [...(out.get(k) ?? []), r])
  }
  return out
}

export const SNAPSHOT_EVERY_MS = 10 * 60_000

/** A reading is kept when a percentage moved or ten minutes passed since the last kept. */
export function shouldSnapshot(next: MeasureSnapshot, last: MeasureSnapshot | null): boolean {
  if (last === null) return true
  return (
    next.fiveHourPct !== last.fiveHourPct ||
    next.weekPct !== last.weekPct ||
    next.ts - last.ts >= SNAPSHOT_EVERY_MS
  )
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}
