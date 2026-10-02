export type Reading = { at: number; pct: number }

/** One rate-limit window as the band draws it; times in epoch ms. */
export type Win = { pct: number; resetsAt?: number; fullAt?: number }

export type View = {
  now: number
  five?: Win
  week?: Win
  ctx?: number
}

declare module 'claude-code' {
  interface PluginState {
    'limit-line': { view: View; isHidden: boolean }
  }
}
