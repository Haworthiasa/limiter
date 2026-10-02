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
    }
  }
}
