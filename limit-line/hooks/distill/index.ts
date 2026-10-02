// The distiller pipeline, pure: clean, detect, filter. The hook and the wrapper's CLI both
// call it; neither the file writes nor the annotation's path are made here.

import { clean, foldRuns } from './common.ts'
import { detect } from './detect.ts'
import type { Kind } from './detect.ts'
import { generic } from './generic.ts'
import { pytest } from './pytest.ts'

export type { Kind }

export const DISTILL_MIN_CHARS = 8000
export const DISTILL_TARGET_CHARS = 4000

export type Distilled = { kind: Kind; out: string; rawChars: number; outChars: number }

export function distillText(raw: string, target = DISTILL_TARGET_CHARS): Distilled {
  const text = clean(raw)
  const kind = detect(text)
  let out: string
  switch (kind) {
    case 'pytest':
      out = pytest(foldRuns(text.split('\n'), l => /^(FAILED|ERROR) /.test(l)).join('\n'), target)
      break
    default:
      out = generic(text, target)
  }
  return { kind: kind === 'pytest' ? 'pytest' : 'generic', out, rawChars: raw.length, outChars: out.length }
}

export function annotation(d: Distilled, logPath: string): string {
  return `[distilled ${d.kind} ${d.rawChars}→${d.outChars} · full log: ${logPath} · raw: rerun with NO_DISTILL=1]`
}

/** Matches the annotation line back into its parts (the hook reads the wrapper's). */
export const ANNOTATION = /\[distilled (\w+) (\d+)→(\d+) · full log: (.+?) · raw: rerun with NO_DISTILL=1\]\s*$/

/** Commands whose failing output is worth distilling: wrapped before they run. */
export const WRAP_ALLOWLIST: RegExp[] = [
  /(^|[\s;&|(])(python3?|uv run|poetry run)?\s*-m pytest\b/,
  /(^|[\s;&|(])pytest\b/,
  /(^|[\s;&|(])(python3?|torchrun|accelerate launch|deepspeed)\s+\S*train\S*/,
  /(^|[\s;&|(])docker(-compose| compose)? logs\b/,
  /(^|[\s;&|(])(pip3?|uv pip) install\b/,
  /(^|[\s;&|(])(make|ninja|cmake --build|cargo build|npm run build|pnpm build|yarn build)\b/,
  /(^|[\s;&|(])python3? setup\.py (build|install|develop)\b/,
]

export function isWrapped(command: string): boolean {
  return WRAP_ALLOWLIST.some(r => r.test(command))
}

/** Commands that pass through untouched. */
export function isBypassed(command: string): boolean {
  return /\bNO_DISTILL=1\b/.test(command) || command.includes('.claude/distill/')
}
