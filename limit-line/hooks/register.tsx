import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionContextUsage } from 'claude-code'

import type { Reading, View, Win } from '../types'
import { KINDS, addReading, fullAt, layout, warnLevel } from './limits'
import type { Kind } from './limits'

const view = atom({ plugin: 'limit-line', key: 'view' } as const, { now: 0 } as View)
const isHidden = atom({ plugin: 'limit-line', key: 'isHidden' } as const, false)

// Kept in $.store so the pace survives a restart inside the same window.
type Readings = Partial<Record<Kind, Reading[]>>
type Warned = Partial<Record<Kind, { resetsAt?: number; level: number }>>

const LABEL: Record<Kind, string> = { five_hour: 'Hạn mức 5 giờ', seven_day: 'Hạn mức tuần' }

function isKind(kind: string): kind is Kind {
  return kind in KINDS
}

async function measure(
  $: EngineInterface,
  rateLimits: readonly SessionRateLimit[],
  context: SessionContextUsage,
): Promise<void> {
  const now = await $.clock.now()
  const readings = ((await $.store.get('readings')) ?? {}) as Readings
  const warned = ((await $.store.get('warned')) ?? {}) as Warned
  const next: View = { now }

  for (const limit of rateLimits) {
    if (!isKind(limit.kind)) continue
    const windowMs = KINDS[limit.kind]
    const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : undefined
    const list = addReading(readings[limit.kind] ?? [], { at: now, pct: limit.percentUsed }, windowMs)
    readings[limit.kind] = list
    const win: Win = { pct: limit.percentUsed }
    if (resetsAt !== undefined && !Number.isNaN(resetsAt)) win.resetsAt = resetsAt
    const eta = fullAt(list, windowMs, win.resetsAt)
    if (eta !== undefined) win.fullAt = eta
    if (limit.kind === 'five_hour') next.five = win
    else next.week = win

    // Toast once per threshold per window; a new window starts over.
    const level = warnLevel(limit.percentUsed)
    const seen = warned[limit.kind]
    const seenLevel = seen && seen.resetsAt === win.resetsAt ? seen.level : 0
    if (level > seenLevel) {
      $.ui.toast(`⚠ ${LABEL[limit.kind]} đã dùng ${Math.round(limit.percentUsed)}%`, { timeoutMs: 8000 })
    }
    warned[limit.kind] = { resetsAt: win.resetsAt, level: Math.max(level, seenLevel) }
  }

  if (context.percent !== undefined) next.ctx = context.percent

  await $.store.set('readings', readings)
  await $.store.set('warned', warned)
  await update($, view, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // The readout first: a failure registering the command must not cost it.
    try {
      const usage = await $.session.usage()
      await measure($, usage.rateLimits, usage.context)
    } catch {
      // No reading yet; session.measure brings the first one.
    }
    try {
      await $.command.register({
        name: 'limits',
        description: 'Ẩn / hiện dòng hạn mức (5h, tuần, context)',
        immediate: true,
      })
    } catch {
      // The line still draws; only the toggle is missing.
    }
    // Keep the countdowns moving while nobody types.
    $.clock.every(60_000, () => {
      void $.clock.now().then(now => update($, view, v => ({ ...v, now })))
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await measure($, e.rateLimits, e.context)
    return result
  })

  on('command.run', { command: 'limits' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    return { text: hidden ? 'Đã ẩn dòng hạn mức. Gõ /limits để hiện lại.' : 'Đã hiện dòng hạn mức.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const current = await read($, view)
    const offsetMin = -new Date(current.now || Date.now()).getTimezoneOffset()
    const segments = layout(current, e.props.bodyColumns - 2, offsetMin)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" paddingX={1}>
        {segments.map((s, i) => (
          <Text key={`s${i}`} color={s.color} dimColor={s.dim} wrap="truncate">
            {s.text}
          </Text>
        ))}
      </Box>
    )
  })
}
