import { describe, expect, test } from 'claude-code/testing'

import { bustCause, cacheHit, costOf, ctxOf, elsewhereShare, isBust, nextTtl1h, savings, timeable, tokPerSec, ttlMinutes } from '../hooks/metrics'
import { priceOf } from '../hooks/pricing'

// Floating point sums: equal to 1e-9.
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9
const MIN = 60_000

describe('metrics', () => {
  test('cache hit is a ratio of sums', async () => {
    const u = { input: 2_000, output: 0, cacheRead: 55_000, cacheWrite: 4_000 }
    expect(ctxOf(u)).toBe(61_000)
    expect(near(cacheHit(u), 55_000 / 61_000)).toBe(true)
    expect(cacheHit({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
  })

  test('cost: live writes priced as 1h, JSONL splits respected, unknown models unpriced', async () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
    // opus 5.5: 4 + 20 + 0.2 + 8 (1h write)
    expect(near(costOf(u, 'claude-opus-5-5'), 32.2)).toBe(true)
    // half the writes 5m: 4 + 20 + 0.2 + 2.5 + 4
    expect(near(costOf({ ...u, cacheWrite1h: 500_000 }, 'claude-opus-5-5'), 30.7)).toBe(true)
    // opus 5 is not opus 5.5
    expect(near(costOf(u, 'claude-opus-5'), 5 + 25 + 0.5 + 10)).toBe(true)
    expect(costOf(u, 'gpt-9')).toBeUndefined()
  })
  test('prices match by the longest prefix', async () => {
    expect(priceOf('claude-opus-5-5')?.input).toBe(4)
    expect(priceOf('claude-opus-5')?.input).toBe(5)
    expect(priceOf('claude-opus-4-8')?.output).toBe(25)
    expect(priceOf('claude-fable-5-1')?.cacheRead).toBe(0.25)
  })

  test('busts: big, cold, and not first', async () => {
    const cold = { input: 2, output: 0, cacheRead: 1_000, cacheWrite: 40_000 }
    const prev = { ts: 0, model: 'claude-opus-5-5', ttl1h: true }
    expect(isBust(cold, prev)).toBe(true)
    expect(isBust(cold, undefined)).toBe(false)
    expect(isBust({ ...cold, cacheWrite: 10_000 }, prev)).toBe(false) // ctx under 20k
    expect(isBust({ ...cold, cacheRead: 5_000 }, prev)).toBe(false) // read ≥ 10% of ctx
  })

  test('bust causes in order, TTL per request', async () => {
    const r = { ts: 10 * MIN, model: 'claude-opus-5-5', input: 2, output: 0, cacheRead: 0, cacheWrite: 40_000 }
    expect(bustCause(r, { ts: 0, model: 'claude-sonnet-5-5', ttl1h: false }, true)).toBe('compact')
    expect(bustCause(r, { ts: 0, model: 'claude-sonnet-5-5', ttl1h: false }, false)).toBe('model_switch')
    expect(bustCause(r, { ts: 0, model: 'claude-opus-5-5', ttl1h: false }, false)).toBe('ttl')
    expect(bustCause(r, { ts: 0, model: 'claude-opus-5-5', ttl1h: true }, false)).toBe('unknown')
    expect(bustCause({ ...r, ts: 61 * MIN }, { ts: 0, model: 'claude-opus-5-5', ttl1h: true }, false)).toBe('ttl')
    // Live data: no split, 60 minutes.
    expect(ttlMinutes({ ts: 0, model: 'x' })).toBe(60)
    expect(ttlMinutes({ ts: 0, model: 'x', ttl1h: false })).toBe(5)
    // A request without a write keeps the TTL it found.
    expect(nextTtl1h({ input: 1, output: 1, cacheRead: 9, cacheWrite: 0 }, false)).toBe(false)
    expect(nextTtl1h({ input: 1, output: 1, cacheRead: 9, cacheWrite: 5, cacheWrite1h: 5 }, false)).toBe(true)
    expect(nextTtl1h({ input: 1, output: 1, cacheRead: 9, cacheWrite: 5, cacheWrite1h: 0 }, true)).toBe(false)
  })

  test('savings can be negative on a day of writes', async () => {
    // Reads only: 1M at 0.2 instead of 4.
    expect(near(savings({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, 'claude-opus-5-5'), 3.8)).toBe(true)
    // Writes only (1h, 2x): 8 instead of 4.
    expect(near(savings({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, 'claude-opus-5-5'), -4)).toBe(true)
  })

  test('usage elsewhere needs two calibrated windows', async () => {
    expect(elsewhereShare([{ pctUsed: 10, localCost: 5 }], { pctUsed: 10, localCost: 2 })).toBeUndefined()
    const done = [
      { pctUsed: 10, localCost: 5 },
      { pctUsed: 20, localCost: 8 },
    ]
    // 0.5 $/% at best; 2 $ local is 4%, of 10% used: 60% elsewhere.
    expect(near(elsewhereShare(done, { pctUsed: 10, localCost: 2 }), 0.6)).toBe(true)
    expect(elsewhereShare(done, { pctUsed: 10, localCost: 6 })).toBe(0)
  })
})

describe('speed', () => {
  test('tok/s is output over seconds, undefined with nothing to divide', async () => {
    expect(tokPerSec(600, 10_000)).toBe(60)
    expect(tokPerSec(0, 10_000)).toBeUndefined()
    expect(tokPerSec(600, 0)).toBeUndefined()
    expect(tokPerSec(undefined, 10_000)).toBeUndefined()
    expect(tokPerSec(600, undefined)).toBeUndefined()
  })

  test('short answers and untimed requests are not timeable', async () => {
    expect(timeable(50, 1000)).toBe(true)
    expect(timeable(49, 1000)).toBe(false)
    expect(timeable(500, undefined)).toBe(false)
    expect(timeable(500, 0)).toBe(false)
  })
})
