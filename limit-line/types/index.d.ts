export type Reading = { at: number; pct: number }

/** One rate-limit window as the band draws it; times in epoch ms. */
export type Win = { pct: number; resetsAt?: number; fullAt?: number }

export type View = {
  now: number
  five?: Win
  week?: Win
  ctx?: number
}

/** The token counts of one main-loop turn, summed over its requests. */
export type TurnAcc = {
  turnId: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The model of the last request that counted. */
  model: string
}

/** A finished turn as the band's extras and detail line draw it. */
export type LastTurn = TurnAcc & {
  /** Context tokens after the turn, from `$.session.usage()`. */
  ctxEnd?: number
  /** ctxEnd minus the previous turn's; absent on the first turn. */
  delta?: number
  /** The context window the delta is judged against. */
  window?: number
}

/** One model request as the live ledger keeps it (PLAN §4). */
export type RequestRecord = {
  ts: number
  sessionId: string
  /** basename of the session's cwd */
  project: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  turnId?: string
  isSubagent: boolean
  source: 'live' | 'jsonl'
}

export type MeasureSnapshot = { ts: number; fiveHourPct: number; weekPct: number; resetsAt5h?: number; resetsAtWeek?: number }

/** A compaction that happened: where a later cold request's bust comes from. */
export type CompactMark = { ts: number; sessionId: string; trigger: string }

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }

export type BustEvent = {
  ts: number
  sessionId: string
  project: string
  model: string
  prevModel?: string
  gapMs?: number
  ctx: number
  cacheRead: number
  cause: 'compact' | 'ttl' | 'model_switch' | 'session_start' | 'unknown'
}

/** One Bangkok day, as scripts/indexer.mjs writes it. */
export type DayAgg = {
  date: string
  byModel: Record<string, Tokens>
  byProject: Record<string, Tokens>
  total: Tokens
  requests: number
  subagentRequests?: number
  serverCalls?: number
  busts: BustEvent[]
  bad?: number
}

export type DistillKind = 'pytest' | 'cuda' | 'docker' | 'train' | 'generic'

/** One distillation: sizes and where the whole output went, never the output itself. */
export type DistillEvent = {
  ts: number
  sessionId: string
  kind: DistillKind
  rawChars: number
  outChars: number
  logPath: string
  reread: boolean
}

// ── /usage-plus (computed by hooks/dashdata.ts) ──

export type DayRow = {
  date: string
  read: number
  write: number
  input: number
  output: number
  cost: number
  savings: number
  hit?: number
  requests: number
}
export type Share = { name: string; tokens: number; share: number }
export type TurnRow = { turnId: string; ts: number; requests: number; hit?: number; delta?: number; ctx: number; cost: number }
export type DistillSummary = { count: number; cut: number; reread: number; byKind: { kind: string; n: number; cut: number }[] }
export type LimitsHistory = {
  five: number[]
  fivePeak?: { pct: number; ts: number }
  week: (number | undefined)[]
  weekNow?: number
  weekForecast?: number
  elsewhere?: number
}
export type DashData = {
  builtAt: number
  sessionId: string
  /** Oldest first, one row per day, empty days included: the last 35. */
  days: DayRow[]
  week: { byModel: Share[]; byProject: Share[] }
  month: { byModel: Share[]; byProject: Share[] }
  busts: BustEvent[]
  session: { turns: TurnRow[]; busts: BustEvent[] }
  limits: LimitsHistory
  distillWeek: DistillSummary
  distillMonth: DistillSummary
  /** Unparsable JSONL lines over all lines read, when the indexer reported any. */
  badShare?: number
  indexerError?: string
}


declare module 'claude-code' {
  interface PluginState {
    'limit-line': {
      view: View
      isHidden: boolean
      turn: TurnAcc | null
      lastTurn: LastTurn | null
      ctxHistory: number[]
      distSession: number
      expanded: boolean
      distillOn: boolean
      distEvents: DistillEvent[]
      ledgerBuf: RequestRecord[]
      lastSnap: MeasureSnapshot | null
      dash: DashData | null
      dashTab: 'session' | 'week' | 'month'
    }
  }
}
