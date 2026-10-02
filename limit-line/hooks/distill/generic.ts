// Any log: its head and tail, and every line that reads as an error with two lines around it.
// No error line is ever dropped, even past the size target.

import { ERROR_LINE, cut, foldRuns, pick } from './common.ts'

export type GenericOptions = { head: number; tail: number; context: number; maxLine: number }
export const GENERIC: GenericOptions = { head: 40, tail: 80, context: 2, maxLine: 400 }

export function generic(text: string, limit: number, opts: GenericOptions = GENERIC): string {
  const lines = foldRuns(text.split('\n'), line => ERROR_LINE.test(line))
  const errors: number[] = []
  lines.forEach((line, i) => {
    if (ERROR_LINE.test(line)) errors.push(i)
  })
  // Narrow the frame step by step; the error lines stay in every step.
  const steps: GenericOptions[] = [
    opts,
    { ...opts, head: 20, tail: 40 },
    { ...opts, head: 10, tail: 20, context: 1 },
    { ...opts, head: 5, tail: 10, context: 0 },
    { ...opts, head: 0, tail: 5, context: 0, maxLine: 200 },
  ]
  let out = ''
  for (const o of steps) {
    const ranges: [number, number][] = [
      [0, o.head],
      [lines.length - o.tail, lines.length],
      ...errors.map((i): [number, number] => [i - o.context, i + o.context + 1]),
    ]
    out = pick(lines, ranges)
      .map(l => cut(l, o.maxLine))
      .join('\n')
    if (out.length <= limit) return out
  }
  return out
}
