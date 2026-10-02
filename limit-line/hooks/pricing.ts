// API list prices in USD per million tokens. Change them here: nothing else holds a price.
//
// Source: the claude-api skill's model table (cached 2026-09-25). Not yet confirmed by
// the user. On a subscription these are "API-equivalent" figures, never a bill.

export type Price = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export const PRICES_UPDATED = '2026-09-25'
export const PRICES_CONFIRMED = false

// Cache writes are 1.25x input (5 min) and 2x input (1 h).
const priced = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
})

// Matched by prefix, longest first, so `claude-opus-5-5` never falls to `claude-opus-5`.
export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': priced(10, 50, 0.25),
  'claude-fable-5': priced(10, 50, 1),
  'claude-opus-5-5': priced(4, 20, 0.2),
  'claude-opus-5': priced(5, 25, 0.5),
  'claude-opus-4': priced(5, 25, 0.5),
  'claude-sonnet-5-5': priced(2, 10, 0.2),
  'claude-sonnet-5': priced(2, 10, 0.2),
  'claude-sonnet-4': priced(3, 15, 0.3),
  'claude-haiku-4-5': priced(1, 5, 0.1),
}

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length)

export function priceOf(model: string): Price | undefined {
  const key = KEYS.find(k => model.startsWith(k))
  return key === undefined ? undefined : PRICES[key]
}
