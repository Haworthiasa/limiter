import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionContextUsage } from 'claude-code'

import type { CompactMark, DayAgg, DistillEvent, LastTurn, MeasureSnapshot, Reading, RequestRecord, TurnAcc, View, Win } from '../types'
import { bandLine, extrasOf, shortModel, turnLine } from './band'
import { buildDash, lastDates } from './dashdata'
import type { DashData } from './dashdata'
import { SUBTITLE, dashboardLines } from './dashboard'
import type { Tab } from './dashboard'
import { basename, byDay, shouldSnapshot, toRecord } from './ledger'
import { KINDS, addReading, fullAt, warnLevel } from './limits'
import type { Kind, Segment } from './limits'
import { OFF_KEY, registerDistiller } from './distiller'
import { costOf } from './metrics'
import { dataDir, dayKey, monthKey, TZ_OFFSET_MIN } from './paths'
import { addStep, pushHistory } from './turnstats'

const view = atom({ plugin: 'limit-line', key: 'view' } as const, { now: 0 } as View)
const isHidden = atom({ plugin: 'limit-line', key: 'isHidden' } as const, false)
const turnAcc = atom({ plugin: 'limit-line', key: 'turn' } as const, null as TurnAcc | null)
const lastTurn = atom({ plugin: 'limit-line', key: 'lastTurn' } as const, null as LastTurn | null)
const ctxHistory = atom({ plugin: 'limit-line', key: 'ctxHistory' } as const, [] as number[])
const distSession = atom({ plugin: 'limit-line', key: 'distSession' } as const, 0)
const expanded = atom({ plugin: 'limit-line', key: 'expanded' } as const, false)
const distillOn = atom({ plugin: 'limit-line', key: 'distillOn' } as const, true)
// Requests not yet written to the day's ledger file.
const ledgerBuf = atom({ plugin: 'limit-line', key: 'ledgerBuf' } as const, [] as RequestRecord[])
const lastSnap = atom({ plugin: 'limit-line', key: 'lastSnap' } as const, null as MeasureSnapshot | null)
// What /usage-plus last computed, and the tab it shows.
const dash = atom({ plugin: 'limit-line', key: 'dash' } as const, null as DashData | null)
const dashTab = atom({ plugin: 'limit-line', key: 'dashTab' } as const, 'week' as Tab)

const PANE_ID = 'usage-plus'
const TABS: { tab: Tab; key: string; label: string }[] = [
  { tab: 'session', key: '1', label: 'Session' },
  { tab: 'week', key: '2', label: 'Week' },
  { tab: 'month', key: '3', label: 'Month' },
]

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

// $ goes into functions of this file only (the engine follows it no further).
async function dataPath($: EngineInterface, rel: string): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  return `${dataDir(home)}/${rel}`
}

async function appendJson<T>($: EngineInterface, path: string, items: readonly T[]): Promise<void> {
  if (items.length === 0) return
  let list: T[] = []
  try {
    list = JSON.parse(await $.fs.read(path)) as T[]
  } catch {
    // A new file.
  }
  await $.fs.write(path, JSON.stringify([...list, ...items]))
}

async function readJsonFile<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return fallback
  }
}

/** Runs the indexer, reads what the mod and the indexer keep, and computes the dashboard. */
async function loadDash($: EngineInterface): Promise<DashData> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  const data = dataDir(home)
  const now = await $.clock.now()

  let indexer: { newLines: number; bad: number } | { error: string }
  try {
    const run = await $.process.run(['node', `${$.plugin.root}/scripts/indexer.mjs`, '--data', data], { timeoutMs: 120_000 })
    const last = run.stdout.trim().split('\n').pop() ?? ''
    indexer = run.exitCode === 0 ? (JSON.parse(last) as { newLines: number; bad: number }) : { error: run.stderr.trim().split('\n').pop() ?? `exit ${run.exitCode}` }
  } catch (err) {
    indexer = { error: String(err).slice(0, 160) }
  }

  const today = dayKey(now, TZ_OFFSET_MIN)
  const dates = lastDates(today, 35)
  const days: DayAgg[] = []
  for (const date of dates) {
    const d = await readJsonFile<DayAgg | null>($, `${data}/index/days/${date}.json`, null)
    if (d) days.push(d)
  }
  const ledger: RequestRecord[] = []
  for (const date of dates.slice(-2)) ledger.push(...(await readJsonFile<RequestRecord[]>($, `${data}/ledger/${date}.json`, [])))
  const months = [...new Set([monthKey(now - 35 * 86_400_000, TZ_OFFSET_MIN), monthKey(now, TZ_OFFSET_MIN)])]
  const marks: CompactMark[] = []
  const snaps: MeasureSnapshot[] = []
  const distill: DistillEvent[] = []
  for (const m of months) {
    marks.push(...(await readJsonFile<CompactMark[]>($, `${data}/compact/${m}.json`, [])))
    snaps.push(...(await readJsonFile<MeasureSnapshot[]>($, `${data}/measure/${m}.json`, [])))
    distill.push(...(await readJsonFile<DistillEvent[]>($, `${data}/distill/${m}.json`, [])))
  }
  return buildDash({ now, sessionId: await $.session.id(), days, ledger, marks, snaps, distill, shortModel, indexer })
}

/** Writes the buffered requests to their day files. */
async function flushLedger($: EngineInterface): Promise<void> {
  const buf = await read($, ledgerBuf)
  if (buf.length === 0) return
  await update($, ledgerBuf, () => [])
  for (const [day, records] of byDay(buf)) {
    await appendJson($, await dataPath($, `ledger/${day}.json`), records)
  }
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
  registerDistiller(on)

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
    try {
      await update($, distillOn, () => true)
      if ((await $.store.get(OFF_KEY)) === true) await update($, distillOn, () => false)
    } catch {
      // The distiller is on by default.
    }
    try {
      await $.command.register({ name: 'usage-plus', description: 'Bảng usage: phiên / tuần / tháng', immediate: true })
    } catch {
      try {
        await $.command.register({ name: 'usage-x', description: 'Bảng usage: phiên / tuần / tháng', immediate: true })
      } catch {
        // No dashboard command this session.
      }
    }
    try {
      await $.command.register({ name: 'distill', description: 'Distiller: /distill on | off | stats | last' })
    } catch {
      // A clash with another command's name: the fallback name (NOTES.md).
      try {
        await $.command.register({ name: 'distill-x', description: 'Distiller: on | off | stats | last' })
      } catch {
        // No command; the distiller still runs.
      }
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
    try {
      const five = e.rateLimits.find(r => r.kind === 'five_hour')
      const week = e.rateLimits.find(r => r.kind === 'seven_day')
      if (five || week) {
        const ts = await $.clock.now()
        const snap: MeasureSnapshot = { ts, fiveHourPct: five?.percentUsed ?? 0, weekPct: week?.percentUsed ?? 0 }
        const r5 = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
        const rw = week?.resetsAt ? Date.parse(week.resetsAt) : NaN
        if (!Number.isNaN(r5)) snap.resetsAt5h = r5
        if (!Number.isNaN(rw)) snap.resetsAtWeek = rw
        if (shouldSnapshot(snap, await read($, lastSnap))) {
          await update($, lastSnap, () => snap)
          await appendJson($, await dataPath($, `measure/${monthKey(ts, TZ_OFFSET_MIN)}.json`), [snap])
        }
      }
    } catch {
      // History misses one reading.
    }
    return result
  })

  // A compaction that went through marks the session, for the bust it causes.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.trigger !== 'precompute' && e.agentId === undefined && !('skip' in result && result.skip !== undefined)) {
        const ts = await $.clock.now()
        const mark: CompactMark = { ts, sessionId: await $.session.id(), trigger: e.trigger }
        await appendJson($, await dataPath($, `compact/${monthKey(ts, TZ_OFFSET_MIN)}.json`), [mark])
      }
    } catch {
      // The bust will read as unknown.
    }
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
    try {
      // The ledger keeps subagents' requests too, marked.
      const usage = result.usage
      if (usage !== null) {
        const record = toRecord(usage, {
          ts: await $.clock.now(),
          sessionId: await $.session.id(),
          project: basename(await $.session.cwd()),
          turnId: e.turnId,
          ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
        })
        await update($, ledgerBuf, buf => [...buf, record])
      }
    } catch {
      // The ledger misses one request; the indexer still has it from the transcript.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      await flushLedger($)
    } catch {
      // The buffer waits for the next turn.
    }
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

  on('command.run', { command: /^usage-(plus|x)$/ }, async $ => {
    try {
      // The ledger's buffer first, so the session tab has this turn's requests.
      await flushLedger($)
    } catch {
      // The session tab is a turn behind.
    }
    const computed = await loadDash($)
    await update($, dash, () => computed)
    const opened = await $.ui.open({ id: PANE_ID, title: 'usage-plus', focus: true, closeOnEscape: true })
    if (!opened.isPlaced) return { text: `usage-plus: ${opened.reason}` }
    // A redraw for a pane that was already open.
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const d = await read($, dash)
    const tab = await read($, dashTab)
    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const lines = d === null ? [[{ text: 'Gõ /usage-plus để tính lại.', dim: true }]] : dashboardLines(d, tab, cols)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {TABS.map(t => (
            <Button
              key={`tab-${t.tab}`}
              label={tab === t.tab ? `[${t.key} ${t.label}]` : ` ${t.key} ${t.label} `}
              hotkey={t.key}
              plain
              dimColor={tab !== t.tab}
              onPress={() => void update($, dashTab, () => t.tab)}
            />
          ))}
          <Box flexGrow={1} />
          {cols >= 60 && <Text dimColor>{SUBTITLE[tab]} </Text>}
          <Button key="close" label="[x]" hotkey="x" plain role="dismiss" onPress={() => void $.ui.close({ id: PANE_ID })} />
        </Box>
        <Text> </Text>
        {lines.map((line, i) => (
          <Box key={`l${i}`} flexDirection="row">
            {line.length === 0 ? (
              <Text> </Text>
            ) : (
              line.map((s, j) => (
                <Text key={`l${i}s${j}`} color={s.color} dimColor={s.dim} wrap="truncate">
                  {s.text}
                </Text>
              ))
            )}
          </Box>
        ))}
      </Box>
    )
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
