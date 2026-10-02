// Token arithmetic shared by the band and the dashboard. Pure.

import { priceOf } from './pricing.ts'

export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The part of cacheWrite written with the 1-hour TTL, when the source splits it. */
  cacheWrite1h?: number
}

// Live usage does not split 5m from 1h writes; every write seen on this account is 1h.
export const LIVE_WRITE_IS_1H = true

/** What the request was answered over: uncached, cache-written and cache-read input. */
export function ctxOf(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite
}

/** Share of the context served from cache, 0..1; undefined with no context. Sum token
 * counts before calling it: a rate of sums, never a mean of rates. */
export function cacheHit(u: Usage): number | undefined {
  const ctx = ctxOf(u)
  return ctx > 0 ? u.cacheRead / ctx : undefined
}

/** API-equivalent USD; undefined for a model with no price. */
export function costOf(u: Usage, model: string, writeIs1h = LIVE_WRITE_IS_1H): number | undefined {
  const p = priceOf(model)
  if (p === undefined) return undefined
  const w1h = u.cacheWrite1h ?? (writeIs1h ? u.cacheWrite : 0)
  const w5m = u.cacheWrite - w1h
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      w5m * p.cacheWrite5m +
      w1h * p.cacheWrite1h) /
    1_000_000
  )
}

// ── Cache busts (PLAN §5) ──────────────────────────────────────────────────────────

export const BUST_MIN_CTX = 20_000
export const BUST_READ_SHARE = 0.1
export const TTL_5M_MIN = 5
export const TTL_1H_MIN = 60
/** Live usage does not say 5m or 1h: assume 1h, as every JSONL write so far. */
export const TTL_LIVE_DEFAULT_MIN = 60

export type BustCause = 'compact' | 'ttl' | 'model_switch' | 'session_start' | 'unknown'

/** One request as bust detection sees it. */
export type Req = Usage & { ts: number; model: string }

/** What a session's previous request left behind. */
export type Prev = {
  ts: number
  model: string
  /** True: its cache entries live 1 h; false: 5 min; undefined: the source does not say. */
  ttl1h?: boolean
}

/** A big request that read almost nothing from cache, and was not the session's first. */
export function isBust(req: Usage, prev: Prev | undefined): boolean {
  const ctx = ctxOf(req)
  return prev !== undefined && ctx >= BUST_MIN_CTX && req.cacheRead < BUST_READ_SHARE * ctx
}

export function ttlMinutes(prev: Prev): number {
  if (prev.ttl1h === undefined) return TTL_LIVE_DEFAULT_MIN
  return prev.ttl1h ? TTL_1H_MIN : TTL_5M_MIN
}

/** The first matching cause, in PLAN order: compact, model switch, TTL, unknown. */
export function bustCause(req: Req, prev: Prev, compactBetween: boolean): BustCause {
  if (compactBetween) return 'compact'
  if (req.model !== prev.model) return 'model_switch'
  if (req.ts - prev.ts > ttlMinutes(prev) * 60_000) return 'ttl'
  return 'unknown'
}

/** The TTL a request leaves its session with: its own write's, else the one before. */
export function nextTtl1h(req: Usage, before: boolean | undefined): boolean | undefined {
  if (req.cacheWrite <= 0) return before
  if (req.cacheWrite1h === undefined) return before
  return req.cacheWrite1h > 0
}

// ── Savings ───────────────────────────────────────────────────────────────────────

/** What caching saved: the cost with every cached token billed as plain input, less the
 * real cost. Negative on a day of many writes. */
export function savings(u: Usage, model: string): number | undefined {
  const real = costOf(u, model)
  const plain = costOf({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output, cacheRead: 0, cacheWrite: 0 }, model)
  return real === undefined || plain === undefined ? undefined : plain - real
}

// ── Usage elsewhere (optional, PLAN §5) ─────────────────────────────────────────────

/** One finished 5-hour window: how far it moved and what this machine spent in it. */
export type WindowSample = { pctUsed: number; localCost: number }

/**
 * The share of the current window's use that did not come from this machine, 0..1, or
 * undefined until two full windows calibrate it. The calibration is the most local cost one
 * percent ever took: a window used from here alone.
 */
export function elsewhereShare(done: readonly WindowSample[], now: WindowSample): number | undefined {
  const rates = done.filter(w => w.pctUsed >= 1 && w.localCost > 0).map(w => w.localCost / w.pctUsed)
  if (rates.length < 2 || now.pctUsed <= 0) return undefined
  const perPct = Math.max(...rates)
  const localPct = now.localCost / perPct
  return Math.min(1, Math.max(0, 1 - localPct / now.pctUsed))
}
