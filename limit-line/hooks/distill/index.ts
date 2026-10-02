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

/** Commands whose failing output is worth distilling: wrapped before they run. Each pattern
 * is matched at the start of a command segment (see `segments`), never inside an argument. */
export const WRAP_ALLOWLIST: RegExp[] = [
  /^(python3? -m |uv run |poetry run )?pytest\b/,
  /^(python3?|torchrun|accelerate launch|deepspeed)\s+\S*train\S*/,
  /^docker(-compose| compose)? logs\b/,
  /^(pip3?|uv pip) install\b/,
  /^(make|ninja|cmake --build|cargo build|npm run build|pnpm( run)? build|yarn build)\b/,
  /^python3? setup\.py (build|install|develop)\b/,
]

/** The commands of a shell line: split at `;`, `&&`, `||`, `|`, `(` and newlines, quoted text
 * removed first, leading `VAR=value` assignments dropped. */
export function segments(command: string): string[] {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
  return unquoted
    .split(/;|&&|\|\||\||\(|\n/)
    .map(seg => seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
    .filter(seg => seg.length > 0)
}

export function isWrapped(command: string): boolean {
  return segments(command).some(seg => WRAP_ALLOWLIST.some(r => r.test(seg)))
}

/** Commands that pass through untouched. */
export function isBypassed(command: string): boolean {
  return /\bNO_DISTILL=1\b/.test(command) || command.includes('.claude/distill/')
}
