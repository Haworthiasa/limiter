import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { DayAgg, RequestRecord } from '../types'
import { buildDash, lastDates, sessionBusts, sessionTurns } from '../hooks/dashdata'
import { dashboardLines } from '../hooks/dashboard'
import type { Tab } from '../hooks/dashboard'
import { shortModel } from '../hooks/band'
import { stacked } from '../hooks/charts'
import { width } from '../hooks/limits'

const T0 = Date.UTC(2026, 9, 2, 7, 0, 0) // 14:00 in Bangkok, a Friday
const MIN = 60_000
const DATA = '/home/u/.local/share/limit-line'
const tok = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite, costUsd: (input * 4 + output * 20 + cacheRead * 0.2 + cacheWrite * 8) / 1e6 })

function day(date: string, scale: number): DayAgg {
  const opus = tok(2_000 * scale, 30_000 * scale, 900_000 * scale, 60_000 * scale)
  const sonnet = tok(1_000 * scale, 10_000 * scale, 300_000 * scale, 20_000 * scale)
  const total = { input: opus.input + sonnet.input, output: opus.output + sonnet.output, cacheRead: opus.cacheRead + sonnet.cacheRead, cacheWrite: opus.cacheWrite + sonnet.cacheWrite, costUsd: opus.costUsd + sonnet.costUsd }
  return {
    date,
    byModel: { 'claude-opus-5-5': opus, 'claude-sonnet-5-5': sonnet },
    byProject: { 'gs-slam': opus, 'sft-run': sonnet },
    total,
    requests: 40 * scale,
    busts: [
      { ts: Date.parse(`${date}T07:02:00Z`), sessionId: 'x', project: 'gs-slam', model: 'claude-opus-5-5', ctx: 142_000, cacheRead: 0, cause: 'compact' },
      { ts: Date.parse(`${date}T09:40:00Z`), sessionId: 'x', project: 'gs-slam', model: 'claude-opus-5-5', prevModel: 'claude-sonnet-5-5', gapMs: 2 * MIN, ctx: 61_000, cacheRead: 12_000, cause: 'model_switch' },
    ],
  }
}

const rec = (ts: number, turnId: string, read: number, write: number, extra: Partial<RequestRecord> = {}): RequestRecord => ({
  ts, sessionId: 's1', project: 'gs-slam', model: 'claude-opus-5-5', input: 2, output: 500, cacheRead: read, cacheWrite: write, turnId, isSubagent: false, source: 'live', ...extra,
})

const LEDGER: RequestRecord[] = [
  rec(T0 - 60 * MIN, 't1', 0, 40_000),
  rec(T0 - 59 * MIN, 't1', 40_000, 2_000),
  rec(T0 - 58 * MIN, 't1', 0, 30_000, { isSubagent: true }),
  rec(T0 - 40 * MIN, 't2', 42_000, 5_000),
  // 12 minutes later, a new model and nothing read: a bust.
  rec(T0 - 28 * MIN, 't3', 0, 50_000, { model: 'claude-sonnet-5-5' }),
]

const dates = lastDates('2026-10-02', 35)
const DAYS = dates.slice(-10).map((d, i) => day(d, 1 + (i % 4)))
const SNAPS = [0, 1, 2, 3].flatMap(w => [
  { ts: T0 - (20 - w * 5) * 3_600_000, fiveHourPct: 20 + w * 10, weekPct: 20 + w, resetsAt5h: T0 - (16 - w * 5) * 3_600_000, resetsAtWeek: T0 + 3 * 86_400_000 },
])
const DATA_SET = () =>
  buildDash({
    now: T0,
    sessionId: 's1',
    days: DAYS,
    ledger: LEDGER,
    marks: [],
    snaps: SNAPS,
    distill: [{ ts: T0 - MIN, sessionId: 's1', kind: 'pytest', rawChars: 80_000, outChars: 3_000, logPath: '/w/a.log', reread: true }],
    shortModel,
    indexer: { newLines: 100, bad: 3 },
  })

describe('dashboard data', () => {
  test('session turns, deltas and busts from the live ledger', async () => {
    const turns = sessionTurns(LEDGER)
    expect(turns.map(t => t.requests)).toEqual([2, 1, 1])
    expect(turns[1]?.delta).toBe(47_002 - 42_002)
    const busts = sessionBusts(LEDGER, [])
    expect(busts).toHaveLength(1)
    expect(busts[0]?.cause).toBe('model_switch')
    expect(sessionBusts(LEDGER, [{ ts: T0 - 30 * MIN, sessionId: 's1', trigger: 'manual' }])[0]?.cause).toBe('compact')
  })

  test('stacked bars fill exactly', async () => {
    const bar = stacked([{ value: 1, color: 'a' }, { value: 1, color: 'b' }, { value: 1, color: 'c' }], 10)
    expect(width(bar)).toBe(10)
  })
})

describe('dashboard lines', () => {
  test('every tab at 60/90/120 columns: nothing wider than the pane', async () => {
    const d = DATA_SET()
    for (const tab of ['session', 'week', 'month'] as Tab[]) {
      for (const cols of [50, 60, 90, 120]) {
        const lines = dashboardLines(d, tab, cols)
        expect(lines.length).toBeGreaterThan(1)
        for (const l of lines) expect(width(l)).toBeLessThanOrEqual(cols)
      }
    }
    const week = dashboardLines(d, 'week', 120).map(l => l.map(s => s.text).join(''))
    expect(week.some(l => l.includes('sau /compact'))).toBe(true)
    expect(week.some(l => l.includes('đổi model sonnet → opus'))).toBe(true)
    expect(week.some(l => l.includes('theo model') && l.includes('theo project') && l.includes('hạn mức'))).toBe(true)
    expect(week.some(l => l.includes('distiller') && l.includes('đọc lại 1/1'))).toBe(true)
    expect(week.some(l => l.includes('dòng không đọc được'))).toBe(true)
    // Under 80 columns the side columns stack.
    const w70 = dashboardLines(d, 'week', 70).map(l => l.map(s => s.text).join(''))
    expect(w70.some(l => l.includes('theo model') && l.includes('theo project'))).toBe(false)
    // Under 60, totals and cache hit only.
    const w50 = dashboardLines(d, 'week', 50).map(l => l.map(s => s.text).join(''))
    expect(w50.some(l => l.startsWith('cache hit'))).toBe(true)
    expect(w50.some(l => l.includes('bust'))).toBe(false)
  })
})

function engine(on: On, files: Map<string, string>) {
  mock.clock(on, { now: T0 })
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
  on('session.cwd', () => ({ value: '/work/gs-slam' }) as any)
  on('session.id', () => ({ value: 's1' }) as any)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000 } } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"newLines":10,"bad":0}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
}

const PANE = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
  ({
    plugin: 'limit-line',
    surface,
    component: 'Pane',
    requestId: 'usage-plus',
    props: { title: 'usage-plus', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40, contentRows: 40 }, view: {} },
  }) as any

describe('/usage-plus', () => {
  test('runs the indexer, opens the pane, and the hotkeys switch tabs', async ($: any, on) => {
    const files = new Map<string, string>()
    for (const d of DAYS) files.set(`${DATA}/index/days/${d.date}.json`, JSON.stringify(d))
    files.set(`${DATA}/ledger/2026-10-02.json`, JSON.stringify(LEDGER))
    engine(on, files)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/gs-slam' })
    const r = await $.command.run({ command: 'usage-plus', args: '' })
    expect(r.text).toBeUndefined()

    for (const surface of ['terminal', 'desktop'] as const) {
      for (const cols of [60, 90, 120]) {
        const ui = await $.ui.mount(PANE(surface, cols))
        expect(await ui.find({ type: 'Text', text: /tokens\/ngày/ })).toBeDefined()
        await ui.press({ key: 'tab-session' })
        expect(await ui.find({ type: 'Text', text: /phiên này · 3 turn/ })).toBeDefined()
        await ui.press({ key: 'tab-month' })
        expect(await ui.find({ type: 'Text', text: /theo ngày/ })).toBeDefined()
        await ui.press({ key: 'tab-week' })
        await ui.unmount()
      }
    }
  })
})
