import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { shouldSnapshot } from '../hooks/ledger'

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)
const MIN = 60_000
const DATA = '/home/u/.local/share/limit-line'

function session(on: On, files: Map<string, string>) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as any
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as any
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }) as any)
  on('session.cwd', () => ({ value: '/work/proj-a' }) as any)
  on('session.id', () => ({ value: 's1' }) as any)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, tokens: 9 } } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6, model: e.model },
    } as any
  })
  return clock
}

async function drain(s: any) {
  for await (const _ of s) {
    // forward
  }
  return s.result
}

describe('live ledger', () => {
  test('steps are buffered and written to the day file when the turn completes, subagents marked', async ($: any, on) => {
    const files = new Map<string, string>()
    session(on, files)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/proj-a' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2 }))
    await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 4, agentId: 'a1' }))
    expect(files.has(`${DATA}/ledger/2026-10-02.json`)).toBe(false)
    await $.turn.complete({ turnId: 't1', answer: '', reason: 'answer', isAborted: false })
    const ledger = JSON.parse(files.get(`${DATA}/ledger/2026-10-02.json`) as string)
    expect(ledger).toHaveLength(2)
    expect(ledger[0]).toMatchObject({ sessionId: 's1', project: 'proj-a', input: 3, output: 4, cacheRead: 5, cacheWrite: 6, isSubagent: false, source: 'live' })
    expect(ledger[1].isSubagent).toBe(true)
  })

  test('limit readings are kept sparsely; a compaction leaves a mark, a skipped one does not', async ($: any, on) => {
    const files = new Map<string, string>()
    const clock = session(on, files)
    let skip = false
    on('session.compact', ($, e) => (skip ? { skip: 'no' } : { messages: e.messages }) as any)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/proj-a' })
    const limits = (five: number) => [
      { kind: 'five_hour', percentUsed: five, resetsAt: new Date(T0 + 60 * MIN).toISOString() },
      { kind: 'seven_day', percentUsed: 20 },
    ]
    const ctx = { window: 1_000_000 }
    await $.session.measure({ context: ctx, rateLimits: limits(10), changed: ['rateLimits'] })
    await $.session.measure({ context: ctx, rateLimits: limits(10), changed: ['context'] })
    await $.session.measure({ context: ctx, rateLimits: limits(11), changed: ['rateLimits'] })
    await clock.advance(11 * MIN)
    await $.session.measure({ context: ctx, rateLimits: limits(11), changed: ['context'] })
    const snaps = JSON.parse(files.get(`${DATA}/measure/2026-10.json`) as string)
    expect(snaps.map((s: any) => s.fiveHourPct)).toEqual([10, 11, 11])
    expect(snaps[0].resetsAt5h).toBe(T0 + 60 * MIN)

    const messages = [{ role: 'user', text: 'hi', toolUses: [], toolResults: [] }] as any
    await $.session.compact({ trigger: 'manual', messages })
    await $.session.compact({ trigger: 'precompute', messages })
    skip = true
    await $.session.compact({ trigger: 'auto', messages })
    const marks = JSON.parse(files.get(`${DATA}/compact/2026-10.json`) as string)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ sessionId: 's1', trigger: 'manual' })
  })

  test('snapshot rule', async () => {
    const s = { ts: 0, fiveHourPct: 1, weekPct: 2 }
    expect(shouldSnapshot(s, null)).toBe(true)
    expect(shouldSnapshot({ ...s, ts: 9 * MIN }, s)).toBe(false)
    expect(shouldSnapshot({ ...s, ts: 10 * MIN }, s)).toBe(true)
    expect(shouldSnapshot({ ...s, weekPct: 3 }, s)).toBe(true)
  })
})
