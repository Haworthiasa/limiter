// Sums the requests of one main-loop turn. Pure.

import type { TurnAcc } from '../types'
import { timeable } from './metrics.ts'

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export function emptyTurn(turnId: string): TurnAcc {
  return { turnId, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: '' }
}

/** Adds one step. A subagent's step (agentId set) or a step with no usage changes nothing;
 * a step of another turn starts the sum over. */
export function addStep(
  acc: TurnAcc | null,
  step: { turnId: string; agentId?: string; usage: StepUsage | null; ms?: number },
): TurnAcc | null {
  if (step.agentId !== undefined || step.usage === null) return acc
  const base = acc !== null && acc.turnId === step.turnId ? acc : emptyTurn(step.turnId)
  const u = step.usage
  const timed = timeable(u.output_tokens, step.ms)
  return {
    turnId: base.turnId,
    requests: base.requests + 1,
    input: base.input + u.input_tokens,
    output: base.output + u.output_tokens,
    cacheRead: base.cacheRead + u.cache_read_input_tokens,
    cacheWrite: base.cacheWrite + u.cache_creation_input_tokens,
    model: u.model,
    genOut: (base.genOut ?? 0) + (timed ? u.output_tokens : 0),
    genMs: (base.genMs ?? 0) + (timed ? (step.ms as number) : 0),
  }
}

/** Keeps the last `max` context readings. */
export function pushHistory(list: readonly number[], value: number, max = 12): number[] {
  return [...list, value].slice(-max)
}
