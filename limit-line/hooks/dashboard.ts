// /usage-plus as lines of coloured segments, per tab and width. Pure: the render hook turns
// each segment into a Text and adds the tab buttons.

import type { BustEvent } from '../types'
import { cacheColor, fmtTokens, shortModel } from './band.ts'
import { columns, fit, hbar, spark, stacked } from './charts.ts'
import type { DashData, DayRow, DistillSummary, Share } from './dashdata.ts'
import { local } from './paths.ts'
import { TZ_OFFSET_MIN } from './paths.ts'
import type { Segment } from './limits.ts'
import { width } from './limits.ts'

export type Tab = 'session' | 'week' | 'month'
export type Line = Segment[]

export const COLORS = { read: 'green', write: 'yellow', input: 'blue', output: 'magenta' } as const
const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

const dim = (text: string): Segment => ({ text, dim: true })
const plain = (text: string): Segment => ({ text })
const blank: Line = []
const rule = (cols: number): Line => [dim('─'.repeat(Math.max(0, cols)))]

export function usd(n: number): string {
  const a = Math.abs(n)
  const s = a >= 100 ? a.toFixed(0) : a.toFixed(2)
  return `${n < 0 ? '-' : ''}$${s}`
}

function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, '0')}`
}

function clock(ts: number, withDay = true): string {
  const t = local(ts, TZ_OFFSET_MIN)
  const day = WEEKDAYS[new Date(ts + TZ_OFFSET_MIN * 60_000).getUTCDay()]
  return `${withDay ? `${day} ` : ''}${t.hh}:${t.mm}`
}

const totalOf = (r: DayRow) => r.read + r.write + r.input + r.output
const pct = (x: number) => `${Math.round(x * 100)}%`

function hitOf(rows: readonly DayRow[]): number | undefined {
  const read = rows.reduce((n, r) => n + r.read, 0)
  const ctx = rows.reduce((n, r) => n + r.read + r.write + r.input, 0)
  return ctx > 0 ? read / ctx : undefined
}

function legend(): Line {
  return [
    dim('Tokens / ngày   '),
    { text: '█', color: COLORS.read },
    dim(' cache read  '),
    { text: '█', color: COLORS.write },
    dim(' cache write  '),
    { text: '█', color: COLORS.input },
    dim(' input  '),
    { text: '█', color: COLORS.output },
    dim(' output'),
  ]
}

function barRows(rows: readonly { label: string; row: DayRow }[], cols: number): Line[] {
  const max = Math.max(1, ...rows.map(r => totalOf(r.row)))
  const labelW = Math.max(...rows.map(r => r.label.length))
  const cells = Math.max(4, cols - labelW - 11)
  return rows.map(({ label, row }) => {
    const n = totalOf(row)
    const bar = stacked(
      [
        { value: row.read, color: COLORS.read },
        { value: row.write, color: COLORS.write },
        { value: row.input, color: COLORS.input },
        { value: row.output, color: COLORS.output },
      ],
      Math.round((n / max) * cells),
    )
    if (n === 0) return [plain('  '), dim(label.padEnd(labelW + 2)), dim('·')]
    return [plain('  '), dim(label.padEnd(labelW + 2)), ...bar, plain(' '.repeat(cells - width(bar) + 1)), plain(fmtTokens(n).padStart(6))]
  })
}

function hitLine(rows: readonly DayRow[], label: string): Line {
  const hit = hitOf(rows)
  const saved = rows.reduce((n, r) => n + r.savings, 0)
  const line: Line = [dim('Cache hit  ')]
  if (hit !== undefined) line.push({ text: pct(hit), color: cacheColor(hit * 100) }, dim(` (${label})  `))
  line.push({ text: spark(rows.map(r => r.hit), 1), color: 'green' })
  if (saved !== 0) line.push(dim('   tiết kiệm ≈ '), { text: usd(saved), color: saved >= 0 ? 'green' : 'red' }, dim(' so với không cache'))
  return line
}

export function bustLabel(b: BustEvent): string {
  switch (b.cause) {
    case 'compact':
      return 'sau /compact'
    case 'ttl':
      return `nghỉ ${Math.round((b.gapMs ?? 0) / 60_000)} phút (TTL hết)`
    case 'model_switch':
      return `đổi model ${shortModel(b.prevModel ?? '?')} → ${shortModel(b.model)}`
    default:
      return 'không rõ (prompt/tool đổi?)'
  }
}

function bustColor(b: BustEvent): string | undefined {
  if (b.cause === 'compact' || b.cause === 'ttl') return 'red'
  if (b.cause === 'model_switch') return 'yellow'
  return undefined
}

function bustLines(busts: readonly BustEvent[], title: string, cols: number, withDay = true): Line[] {
  if (busts.length === 0) return [[dim(`${title}: không có`)]]
  const labelW = Math.max(16, cols - 32)
  const out: Line[] = [[dim(`${title.padEnd(labelW + 13)}  ctx  đọc cache`)]]
  for (const b of busts) {
    const color = bustColor(b)
    out.push([
      color ? { text: '●', color } : dim('●'),
      plain(` ${clock(b.ts, withDay).padEnd(withDay ? 9 : 5)}  `),
      ...fit([plain(bustLabel(b))], labelW),
      plain(fmtTokens(b.ctx).padStart(6)),
      plain(fmtTokens(b.cacheRead).padStart(10)),
    ])
  }
  return out
}

function shareLines(title: string, list: readonly Share[], w: number): Line[] {
  const out: Line[] = [[dim(title[0]!.toUpperCase() + title.slice(1))]]
  const nameW = Math.min(10, Math.max(4, ...list.map(s => s.name.length)))
  const cells = Math.max(3, Math.min(6, w - nameW - 7))
  for (const s of list) {
    out.push([plain(s.name.slice(0, nameW).padEnd(nameW + 1)), ...hbar(s.share * 100, cells, 'cyan'), plain(` ${pct(s.share).padStart(4)}`)])
  }
  if (list.length === 0) out.push([dim('chưa có dữ liệu')])
  return out
}

function limitLines(d: DashData): Line[] {
  const l = d.limits
  const out: Line[] = [[dim('Hạn mức (lịch sử)')]]
  if (l.five.length > 0) {
    const line: Line = [dim('5h '), { text: spark(l.five, 100), color: 'yellow' }]
    if (l.fivePeak) line.push(dim(` đỉnh ${Math.round(l.fivePeak.pct)}% ${clock(l.fivePeak.ts).split(' ')[0]}`))
    out.push(line)
  }
  if (l.week.some(v => v !== undefined)) {
    const line: Line = [dim('wk '), { text: spark(l.week, 100), color: 'yellow' }]
    if (l.weekNow !== undefined) line.push(plain(` ${Math.round(l.weekNow)}%`))
    if (l.weekForecast !== undefined) line.push(dim(' → dự báo '), { text: `${l.weekForecast}%`, color: l.weekForecast >= 100 ? 'red' : 'yellow' })
    out.push(line)
  }
  if (l.elsewhere !== undefined) out.push([dim('ngoài máy này ≈ '), plain(pct(l.elsewhere))])
  if (out.length === 1) out.push([dim('chưa có lần đọc nào')])
  return out
}

function distillLines(s: DistillSummary): Line[] {
  if (s.count === 0) return [[dim('Distiller  chưa chưng cất lần nào')]]
  return [
    [
      dim('Distiller  '),
      plain(`${s.count} lần · -${fmtTokens(s.cut)} ký tự · đọc lại ${s.reread}/${s.count} (${pct(s.reread / s.count)})`),
    ],
    s.byKind.flatMap((k, i) => [...(i > 0 ? [plain('  ')] : []), dim(`${k.kind} `), plain(`-${fmtTokens(k.cut)}`)]),
  ]
}

/** The three side columns, or stacked under 80 columns. */
function sideBySide(d: DashData, byModel: Share[], byProject: Share[], cols: number): Line[] {
  const a = shareLines('theo model', byModel, 20)
  const b = shareLines('theo project', byProject, 24)
  const c = limitLines(d)
  if (cols < 80) return [...a, blank, ...b, blank, ...c]
  const w = Math.floor((cols - 4) / 3)
  return columns([a, b, c], [w - 2, w + 1, cols - 4 - (w - 2) - (w + 1)])
}

function summaryOnly(rows: readonly DayRow[], label: string): Line[] {
  const n = rows.reduce((t, r) => t + totalOf(r), 0)
  const cost = rows.reduce((t, r) => t + r.cost, 0)
  const hit = hitOf(rows)
  return [
    [dim(`${label}: `), plain(`${fmtTokens(n)} token · ~${usd(cost)} API-equiv`)],
    hit === undefined ? [dim('cache hit: -')] : [dim('cache hit: '), { text: pct(hit), color: cacheColor(hit * 100) }],
  ]
}

function notices(d: DashData): Line[] {
  const out: Line[] = []
  if (d.indexerError) out.push([{ text: `! indexer: ${d.indexerError}`, color: 'yellow' }])
  if (d.badShare !== undefined && d.badShare > 0.01) out.push([{ text: `! JSONL: ${pct(d.badShare)} dòng không đọc được`, color: 'yellow' }])
  return out
}

function weekTab(d: DashData, cols: number): Line[] {
  const rows = d.days.slice(-7)
  if (cols < 60) return [...notices(d), ...summaryOnly(rows, '7 ngày')]
  return [
    ...notices(d),
    legend(),
    blank,
    ...barRows(rows.map(r => ({ label: weekdayOf(r.date), row: r })), cols),
    blank,
    hitLine(rows, 'tuần'),
    ...bustLines(d.busts, 'Cache bust gần đây', cols),
    blank,
    rule(cols),
    ...sideBySide(d, d.week.byModel, d.week.byProject, cols),
    blank,
    rule(cols),
    ...distillLines(d.distillWeek),
  ]
}

function monthTab(d: DashData, cols: number): Line[] {
  const rows = d.days.slice(-30)
  if (cols < 60) return [...notices(d), ...summaryOnly(rows, '30 ngày')]
  // Weeks of the month, Monday first; the first may be partial.
  const weeks: { label: string; row: DayRow }[] = []
  for (const r of rows) {
    const [y, m, dd] = r.date.split('-').map(Number) as [number, number, number]
    const isMonday = new Date(Date.UTC(y, m - 1, dd)).getUTCDay() === 1
    const last = weeks[weeks.length - 1]
    if (!last || isMonday) {
      weeks.push({ label: `từ ${String(dd).padStart(2, '0')}/${String(m).padStart(2, '0')}`, row: { ...r } })
    } else {
      const w = last.row
      last.row = {
        ...w,
        read: w.read + r.read,
        write: w.write + r.write,
        input: w.input + r.input,
        output: w.output + r.output,
        cost: w.cost + r.cost,
        savings: w.savings + r.savings,
        requests: w.requests + r.requests,
      }
    }
  }
  return [
    ...notices(d),
    legend(),
    blank,
    ...barRows(weeks, cols),
    blank,
    [dim('Theo ngày  '), { text: spark(rows.map(totalOf)), color: 'cyan' }],
    hitLine(rows, 'tháng'),
    blank,
    rule(cols),
    ...sideBySide(d, d.month.byModel, d.month.byProject, cols),
    blank,
    rule(cols),
    ...distillLines(d.distillMonth),
  ]
}

function sessionTab(d: DashData, cols: number): Line[] {
  const turns = d.session.turns
  if (turns.length === 0) return [[dim('Phiên này chưa có turn nào được ghi (ledger bắt đầu từ khi mod chạy).')]]
  const total = turns.reduce((n, t) => n + t.cost, 0)
  const head: Line = [dim(`phiên này · ${turns.length} turn · ~${usd(total)} API-equiv`)]
  if (cols < 60) return [head, ...summaryOnly(d.days.slice(-1), 'hôm nay')]
  const table: Line[] = [[dim('lúc    req  cache    Δctx   chi phí')]]
  for (const t of turns.slice(-10)) {
    table.push([
      plain(clock(t.ts, false).padEnd(6)),
      plain(String(t.requests).padStart(4)),
      t.hit === undefined ? plain('      -') : { text: pct(t.hit).padStart(7), color: cacheColor(t.hit * 100) },
      plain((t.delta === undefined ? '-' : `${t.delta >= 0 ? '+' : '-'}${fmtTokens(Math.abs(t.delta))}`).padStart(8)),
      plain(`~${usd(t.cost)}`.padStart(10)),
    ])
  }
  const top = [...turns].sort((a, b) => b.cost - a.cost).slice(0, 3)
  const topLine: Line = [dim('tốn nhất: '), plain(top.map(t => `${clock(t.ts, false)} ~${usd(t.cost)}`).join(' · '))]
  return [head, blank, ...table, blank, topLine, blank, ...bustLines(d.session.busts, 'Cache bust trong phiên', cols, false)]
}

/** Every line of a tab, none wider than `cols`. */
export function dashboardLines(d: DashData, tab: Tab, cols: number): Line[] {
  const lines = tab === 'session' ? sessionTab(d, cols) : tab === 'week' ? weekTab(d, cols) : monthTab(d, cols)
  return lines.map(l => (width(l) > cols ? fit(l, cols) : l))
}

export const SUBTITLE: Record<Tab, string> = {
  session: 'phiên hiện tại · tz +07',
  week: '7 ngày qua · tz +07',
  month: '30 ngày qua · tz +07',
}
