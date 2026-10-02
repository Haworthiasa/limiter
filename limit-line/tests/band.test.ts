import { describe, expect, test } from 'claude-code/testing'

import type { LastTurn, View } from '../types'
import { bandLine, cacheColor, deltaColor, deltaText, extrasOf, fmtTokens, sparkline, tpsColor, turnLine } from '../hooks/band'
import { width } from '../hooks/limits'

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)
const MIN = 60_000
const view: View = {
  now: T0,
  five: { pct: 13, resetsAt: T0 + 139 * MIN },
  week: { pct: 34, resetsAt: T0 + 3 * 24 * 60 * MIN },
  ctx: 7,
}
const last: LastTurn = {
  turnId: 't1',
  requests: 4,
  input: 2_000,
  output: 2_300,
  cacheRead: 55_000,
  cacheWrite: 4_000,
  model: 'claude-opus-5-5',
  ctxEnd: 61_000,
  delta: 18_000,
  window: 1_000_000,
}
const ex = { ...extrasOf(last, 142_000) }
const line = (cols: number) => bandLine(view, ex, cols, 420).map(s => s.text).join('')

describe('band line', () => {
  test('drops extras lowest priority first, then the limits tiers', async () => {
    const at160 = line(160)
    expect(at160).toBe('5h █░░░░░ 13% 2h19m | wk ██░░░░ 34% T2 10:00 | ctx ░░░░░░ 7% ▲+18k | cache 90% | dist -142k')
    expect(width(bandLine(view, ex, 160, 420))).toBeLessThanOrEqual(160)

    const at90 = line(90)
    expect(width(bandLine(view, ex, 90, 420))).toBeLessThanOrEqual(90)
    expect(at90).toContain('cache 90%')
    expect(at90).not.toContain('dist')

    const at70 = line(70)
    expect(at70).not.toContain('cache')
    expect(at70).not.toContain('▲')

    const at60 = line(60)
    expect(width(bandLine(view, ex, 60, 420))).toBeLessThanOrEqual(60)
    expect(at60).not.toContain('cache')

    // 120 keeps every extra.
    expect(line(120)).toContain('dist -142k')
  })

  test('no dist segment while nothing was distilled; extras alone before any limit', async () => {
    expect(bandLine(view, { ...ex, dist: 0 }, 200, 420).map(s => s.text).join('')).not.toContain('dist')
    const only = bandLine({ now: T0 }, ex, 200, 420).map(s => s.text).join('')
    expect(only).toContain('cache 90%')
    expect(bandLine({ now: T0 }, { dist: 0 }, 200, 420)[0]?.text).toContain('chờ lượt')
  })

  test('colours', async () => {
    expect(cacheColor(80)).toBe('green')
    expect(cacheColor(79)).toBe('yellow')
    expect(cacheColor(50)).toBe('yellow')
    expect(cacheColor(49)).toBe('red')
    expect(deltaColor(100_001, 1_000_000)).toBe('red')
    expect(deltaColor(100_000, 1_000_000)).toBe('yellow')
    expect(deltaColor(-150_000, 1_000_000)).toBe('red')
    const cache = bandLine(view, ex, 200, 420).find(s => s.text === '90%')
    expect(cache?.color).toBe('green')
  })

  test('numbers, deltas and the sparkline', async () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(2_300)).toBe('2.3k')
    expect(fmtTokens(2_000)).toBe('2k')
    expect(fmtTokens(61_400)).toBe('61k')
    expect(fmtTokens(1_900_000)).toBe('1.9M')
    expect(deltaText(18_000)).toBe('▲+18k')
    expect(deltaText(-120_000)).toBe('▼-120k')
    expect(sparkline([0, 50, 100])).toBe('▁▅█')
    expect(sparkline([])).toBe('')
  })
})

describe('turn line', () => {
  test('full, then trimmed to fit', async () => {
    const hist = [20_000, 30_000, 40_000, 61_000]
    const full = turnLine(last, hist, 0.42, 200).map(s => s.text).join('')
    expect(full).toBe('turn 4 req · in 61k (cache 55k · write 4k · new 2k) · out 2.3k · ~$0.42 · opus · ctx ▃▄▆█')
    for (const cols of [60, 90, 120]) {
      expect(width(turnLine(last, hist, 0.42, cols))).toBeLessThanOrEqual(cols)
    }
    const narrow = turnLine(last, hist, 0.42, 50).map(s => s.text).join('')
    expect(narrow).toContain('turn 4 req')
    expect(narrow).not.toContain('ctx')
  })
})

describe('speed on the band', () => {
  test('the last turn shows tok/s: extras and detail line', async () => {
    const fast: LastTurn = { ...last, genOut: 2_000, genMs: 20_000 }
    expect(extrasOf(fast, 0).tps).toBe(100)
    const text = bandLine(view, extrasOf(fast, 0), 200, 420).map(s => s.text).join('')
    expect(text).toContain('⚡ 100 tok/s')
    expect(turnLine(fast, [], undefined, 200).map(s => s.text).join('')).toContain('100 tok/s')
  })

  test('no timed answer, no tok/s', async () => {
    expect(extrasOf(last, 0).tps).toBeUndefined()
    expect(bandLine(view, extrasOf(last, 0), 200, 420).map(s => s.text).join('')).not.toContain('tok/s')
  })

  test('colors: green from 60, yellow from 30, red below', async () => {
    expect(tpsColor(60)).toBe('green')
    expect(tpsColor(59)).toBe('yellow')
    expect(tpsColor(30)).toBe('yellow')
    expect(tpsColor(29)).toBe('red')
  })
})
