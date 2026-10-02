import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionContextUsage } from 'claude-code'

import type { LastTurn, Reading, TurnAcc, View, Win } from '../types'
import { bandLine, extrasOf, turnLine } from './band'
import { KINDS, addReading, fullAt, warnLevel } from './limits'
import type { Kind, Segment } from './limits'
import { costOf } from './metrics'
import { addStep, pushHistory } from './turnstats'

const view = atom({ plugin: 'limit-line', key: 'view' } as const, { now: 0 } as View)
const isHidden = atom({ plugin: 'limit-line', key: 'isHidden' } as const, false)
const turnAcc = atom({ plugin: 'limit-line', key: 'turn' } as const, null as TurnAcc | null)
const lastTurn = atom({ plugin: 'limit-line', key: 'lastTurn' } as const, null as LastTurn | null)
const ctxHistory = atom({ plugin: 'limit-line', key: 'ctxHistory' } as const, [] as number[])
const distSession = atom({ plugin: 'limit-line', key: 'distSession' } as const, 0)
const expanded = atom({ plugin: 'limit-line', key: 'expanded' } as const, false)

// Remembered across sessions; $.state holds the live value.
const EXPANDED_KEY = 'band.expanded'
// The [+]/[-] button and the space before it.
const BUTTON_COLUMNS = 4

// Kept in $.store so the pace survives a restart inside the same window.
type Readings = Partial<Record<Kind, Reading[]>>
type Warned = Partial<Record<Kind, { resetsAt?: number; level: number }>>

const LABEL: Record<Kind, string> = { five_hour: 'Hạn mức 5 giờ', seven_day: 'Hạn mức tuần' }

function isKind(kind: string): kind is Kind {
  return kind in KINDS
}

async function toggleExpanded($: EngineInterface): Promise<boolean> {
  const isExpanded = await update($, expanded, x => !x)
  await $.store.set(EXPANDED_KEY, isExpanded)
  return isExpanded
}

// Closes the turn: its sums, the context after it and the change since the last one.
async function finishTurn($: EngineInterface, turnId: string, usage: TurnAcc | null): Promise<void> {
  const acc = await read($, turnAcc)
  const turn = acc !== null && acc.turnId === turnId ? acc : usage
  await update($, turnAcc, () => null)
  if (turn === null) return
  const { context } = await $.session.usage()
  const prev = await read($, lastTurn)
  const ctxEnd = context.tokens
  const delta = ctxEnd !== undefined && prev?.ctxEnd !== undefined ? ctxEnd - prev.ctxEnd : undefined
  const done: LastTurn = { ...turn, window: context.window }
  if (ctxEnd !== undefined) done.ctxEnd = ctxEnd
  if (delta !== undefined) done.delta = delta
  await update($, lastTurn, () => done)
  if (ctxEnd !== undefined) await update($, ctxHistory, h => pushHistory(h, ctxEnd))
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
      if ((await $.store.get(EXPANDED_KEY)) === true) await update($, expanded, () => true)
    } catch {
      // Collapsed is the default.
    }
    try {
      await $.command.register({
        name: 'limits',
        description: 'Ẩn / hiện dòng hạn mức; /limits detail: bật/tắt dòng chi tiết turn',
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

  // One model request: its usage joins the turn's sums. Subagents' requests do not.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      await update($, turnAcc, acc => addStep(acc, { turnId: e.turnId, agentId: e.agentId, usage: result.usage }))
    } catch {
      // The band misses one request; the turn goes on.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      // When no step was summed (a hook above answered them), the turn's own total stands in.
      const u = e.usage
      const fallback: TurnAcc | null = u
        ? {
            turnId: e.turnId,
            requests: 1,
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
            model: u.model,
          }
        : null
      await finishTurn($, e.turnId, fallback)
    } catch {
      // The extras keep the last turn's figures.
    }
    return result
  })

  on('command.run', { command: 'limits' }, async ($, e) => {
    if (e.args.trim() === 'detail') {
      const isExpanded = await toggleExpanded($)
      return { text: isExpanded ? 'Đã bật dòng chi tiết turn.' : 'Đã tắt dòng chi tiết turn.' }
    }
    const hidden = await update($, isHidden, h => !h)
    return { text: hidden ? 'Đã ẩn dòng hạn mức. Gõ /limits để hiện lại.' : 'Đã hiện dòng hạn mức.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const current = await read($, view)
    const last = await read($, lastTurn)
    const isExpanded = await read($, expanded)
    const offsetMin = -new Date(current.now || Date.now()).getTimezoneOffset()
    const columns = e.props.bodyColumns - 2
    const extras = extrasOf(last, await read($, distSession))
    const line = bandLine(current, extras, columns - BUTTON_COLUMNS, offsetMin)
    const detail = isExpanded && last !== null
      ? turnLine(last, await read($, ctxHistory), costOf(last, last.model), columns)
      : undefined
    const { Box, Button, Text } = $.ui.resolve(e)
    const texts = (segments: Segment[], prefix: string) =>
      segments.map((s, i) => (
        <Text key={`${prefix}${i}`} color={s.color} dimColor={s.dim} wrap="truncate">
          {s.text}
        </Text>
      ))

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row">
          <Box flexDirection="row" flexGrow={1}>
            {texts(line, 's')}
          </Box>
          <Button
            key="expand"
            label={isExpanded ? '[-]' : '[+]'}
            plain
            dimColor
            onPress={() => void toggleExpanded($)}
          />
        </Box>
        {detail && <Box flexDirection="row">{texts(detail, 'd')}</Box>}
      </Box>
    )
  })
}
