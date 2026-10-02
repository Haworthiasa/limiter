// The wrapper's second half: `node cli.ts <log>` runs after the wrapped command wrote its
// whole output to <log>. Short output is printed as it was; long output is distilled, the
// log renamed to say its kind, and the annotation names it. Exit status is the wrapper's.

import { readFileSync, renameSync, rmSync } from 'node:fs'

import { DISTILL_MIN_CHARS, annotation, distillText } from './index.ts'

const log = process.argv[2]
if (!log) {
  console.error('usage: cli.ts <log>')
  process.exit(2)
}
const raw = readFileSync(log, 'utf8')
if (raw.length < DISTILL_MIN_CHARS) {
  process.stdout.write(raw)
  rmSync(log, { force: true })
} else {
  const d = distillText(raw)
  const named = log.replace(/\.log$/, `-${d.kind}.log`)
  renameSync(log, named)
  process.stdout.write(`${d.out}\n${annotation(d, named)}\n`)
}
