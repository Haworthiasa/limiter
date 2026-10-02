import { describe, expect, test } from 'claude-code/testing'

import { addStep, pushHistory } from '../hooks/turnstats'

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
    expect(acc).toEqual({ turnId: 'a', requests: 2, input: 15, output: 300, cacheRead: 2050, cacheWrite: 70, model: 'claude-opus-5-5', genOut: 0, genMs: 0 })

    // A new turn starts over; the last model wins.
    const next = addStep(acc, { turnId: 'b', usage: usage(1, 2, 3, 4, 'claude-sonnet-5-5') })
    expect(next).toEqual({ turnId: 'b', requests: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: 'claude-sonnet-5-5', genOut: 0, genMs: 0 })
  })

  test('times only the answers long enough, sums tokens and time apart', async () => {
    let acc = addStep(null, { turnId: 'a', usage: usage(1, 600, 0, 0), ms: 10_000 })
    // Too short to time: its tokens and its time stay out.
    acc = addStep(acc, { turnId: 'a', usage: usage(1, 10, 0, 0), ms: 3_000 })
    acc = addStep(acc, { turnId: 'a', usage: usage(1, 200, 0, 0), ms: 10_000 })
    // No clock reading: counted in the sums, not timed.
    acc = addStep(acc, { turnId: 'a', usage: usage(1, 400, 0, 0) })
    expect(acc?.output).toBe(1210)
    expect(acc?.genOut).toBe(800)
    expect(acc?.genMs).toBe(20_000)
  })

  test('history keeps the last twelve', async () => {
    let h: number[] = []
    for (let i = 0; i < 15; i++) h = pushHistory(h, i)
    expect(h).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })
})
