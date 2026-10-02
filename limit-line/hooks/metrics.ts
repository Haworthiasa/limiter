// Token arithmetic shared by the band and the dashboard. Pure.

import { priceOf } from './pricing'

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
