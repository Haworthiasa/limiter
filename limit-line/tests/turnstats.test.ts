import { describe, expect, test } from 'claude-code/testing'

import { addStep, pushHistory } from '../hooks/turnstats'
import { cacheHit, costOf, ctxOf } from '../hooks/metrics'

// Floating point sums: equal to 1e-9.
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9

const usage = (input: number, output: number, read: number, write: number, model = 'claude-opus-5-5') => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  model,
})

describe('turn sums', () => {
  test('adds the main loop steps of one turn and skips subagents', async () => {
    let acc = addStep(null, { turnId: 'a', usage: usage(10, 100, 1000, 50) })
    acc = addStep(acc, { turnId: 'a', usage: usage(5, 200, 1050, 20) })
    acc = addStep(acc, { turnId: 'a', agentId: 'sub-1', usage: usage(999, 999, 999, 999) })
    acc = addStep(acc, { turnId: 'a', usage: null })
    expect(acc).toEqual({ turnId: 'a', requests: 2, input: 15, output: 300, cacheRead: 2050, cacheWrite: 70, model: 'claude-opus-5-5' })

    // A new turn starts over; the last model wins.
    const next = addStep(acc, { turnId: 'b', usage: usage(1, 2, 3, 4, 'claude-sonnet-5-5') })
    expect(next).toEqual({ turnId: 'b', requests: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: 'claude-sonnet-5-5' })
  })

  test('history keeps the last twelve', async () => {
    let h: number[] = []
    for (let i = 0; i < 15; i++) h = pushHistory(h, i)
    expect(h).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })
})

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
})
