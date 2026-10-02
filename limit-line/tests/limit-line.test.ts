import { describe, expect, mock, test } from 'claude-code/testing'
import type { RenderElement, SessionRateLimit } from 'claude-code'

import { bandLine } from '../hooks/band'
import { addReading, bar, colorOf, dayTime, duration, fullAt, FIVE_HOUR_MS } from '../hooks/limits'

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0) // 10:00 in UTC+7, a Friday
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()
const SURFACES = ['terminal', 'desktop'] as const
const BAND = (surface: (typeof SURFACES)[number], bodyColumns = 120) =>
  ({
    plugin: 'limit-line',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns },
  }) as any

const limits = (five: number, week: number): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed: five, resetsAt: iso(T0 + 83 * MIN) },
  { kind: 'seven_day', percentUsed: week, resetsAt: iso(T0 + 3 * 24 * HOUR) },
]

describe('pure helpers', () => {
  test('bars, colours and durations', async () => {
    expect(bar(62, 10)).toBe('██████░░░░')
    expect(bar(0, 6)).toBe('░░░░░░')
    expect(colorOf(49)).toBe('green')
    expect(colorOf(50)).toBe('yellow')
    expect(colorOf(80)).toBe('red')
    expect(duration(83 * MIN)).toBe('1h23m')
    expect(duration(45 * MIN)).toBe('45m')
    expect(duration(52 * HOUR)).toBe('2d4h')
    expect(dayTime(T0 + 3 * 24 * HOUR, 7 * 60)).toBe('T2 10:00')
  })

  test('the forecast waits for enough span, then projects, and yields to a reset', async () => {
    let list = addReading([], { at: T0, pct: 10 }, FIVE_HOUR_MS)
    list = addReading(list, { at: T0 + 5 * MIN, pct: 12 }, FIVE_HOUR_MS)
    expect(fullAt(list, FIVE_HOUR_MS, T0 + 4 * HOUR)).toBeUndefined() // 5 min < 15 min
    list = addReading(list, { at: T0 + 30 * MIN, pct: 30 }, FIVE_HOUR_MS)
    // 20 points in 30 min: 70 left takes 105 min, before the reset in 4 h
    expect(fullAt(list, FIVE_HOUR_MS, T0 + 4 * HOUR)).toBe(T0 + 30 * MIN + 105 * MIN)
    expect(fullAt(list, FIVE_HOUR_MS, T0 + HOUR)).toBeUndefined() // resets first
    // a drop means the window reset: the old readings go
    expect(addReading(list, { at: T0 + 40 * MIN, pct: 2 }, FIVE_HOUR_MS)).toHaveLength(1)
  })

  test('the line drops detail as the width shrinks', async () => {
    const view = {
      now: T0,
      five: { pct: 62, resetsAt: T0 + 83 * MIN, fullAt: T0 + 125 * MIN },
      week: { pct: 18, resetsAt: T0 + 3 * 24 * HOUR },
      ctx: 41,
    }
    const text = (cols: number) => bandLine(view, { dist: 0 }, cols, 420).map(s => s.text).join('')
    const wide = text(200)
    expect(wide).toBe('5h ████░░ 62% 1h23m !2h05m | wk █░░░░░ 18% T2 10:00 | ctx ██░░░░ 41%')
    expect(wide.length).toBeLessThanOrEqual(75)
    const mid = text(60)
    expect(mid.length).toBeLessThanOrEqual(60)
    expect(mid).not.toContain('T2')
    expect(mid).toContain('5h ██░░ 62%')
    const narrow = text(45)
    expect(narrow).toBe('5h 62% 1h23m | wk 18% | ctx 41%')
  })
})

describe('in a session', () => {
  test('waits for a reading, then draws the line on every surface', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'limits' } }))
    on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } } }))
    on('session.measure', ($, e) => ({ changed: e.changed }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(BAND(surface))
      expect(await ui.find({ type: 'Text', text: /chờ lượt/ })).toBeDefined()
      await ui.unmount()
    }

    await $.session.measure({
      context: { window: 200_000, tokens: 82_000, percent: 41 },
      rateLimits: limits(62, 18),
      changed: ['context', 'rateLimits'],
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(BAND(surface))
      const five = await ui.find({ type: 'Text', text: '62%' })
      expect(five?.props.color).toBe('yellow')
      expect((await ui.find({ type: 'Text', text: '18%' }))?.props.color).toBe('green')
      expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1h23m/ })).toBeDefined()
      await ui.unmount()
    }

    // The countdown moves on its own.
    const ui = await $.ui.mount(BAND('terminal'))
    await clock.advance(10 * MIN)
    expect(await ui.find({ type: 'Text', text: /1h13m/ })).toBeDefined()
    await ui.unmount()
  })

  test('toasts once at 80% and once at 95%', async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'limits' } }))
    on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000 } } }))
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const ctx = { window: 200_000 }
    for (const pct of [70, 81, 85, 96, 97]) {
      await $.session.measure({ context: ctx, rateLimits: limits(pct, 10), changed: ['rateLimits'] })
    }
    expect(toasts).toHaveLength(2)
    expect(toasts[0]).toContain('81%')
    expect(toasts[1]).toContain('96%')
  })

  test('/limits hides and shows the line', async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'limits' } }))
    on('session.usage', () => ({ value: { startedAt: 0, rateLimits: limits(30, 5), context: { window: 200_000 } } }))
    // What the engine draws in the band when no plugin does: here, an empty Box.
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return h(Box, { key: 'engine' }) as RenderElement
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const shown = await $.ui.mount(BAND('desktop'))
    expect(await shown.find({ type: 'Text', text: '30%' })).toBeDefined()
    await shown.unmount()

    const r = await $.command.run({ command: 'limits', args: '' } as any)
    expect(JSON.stringify(r)).toContain('Đã ẩn')
    const hidden = await $.ui.mount(BAND('desktop'))
    expect(await hidden.find({ type: 'Text', text: '30%' })).toBeUndefined()
    await hidden.unmount()
  })
})
