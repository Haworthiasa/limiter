// Cleaning shared by every filter. Pure and linear: no regex that can backtrack badly.

// CSI and OSC escape sequences.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Keeps what a carriage return left on screen: the text after the last `\r` of a line. */
export function collapseCR(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      const i = trimmed.lastIndexOf('\r')
      return i < 0 ? trimmed : trimmed.slice(i + 1)
    })
    .join('\n')
}

export function clean(text: string): string {
  return collapseCR(stripAnsi(text))
}

/** A line with its numbers, hex ids and timestamps blanked: lines equal under it repeat. */
export function shape(line: string): string {
  return line
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, '<ts>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
}

/** Folds runs of lines of one shape into the first, `… (×N)` and the last. Lines `keep`
 * holds are never folded away. */
export function foldRuns(lines: readonly string[], keep: (line: string) => boolean = () => false): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (keep(line)) {
      out.push(line)
      i++
      continue
    }
    const s = shape(line)
    let j = i + 1
    while (j < lines.length && !keep(lines[j] as string) && shape(lines[j] as string) === s) j++
    out.push(line)
    if (j - i > 2) out.push(`… (×${j - i})`)
    if (j - i > 1) out.push(lines[j - 1] as string)
    i = j
  }
  return out
}

export const ERROR_LINE = /error|fail|traceback|exception|fatal/i

/** Cuts one line to `max` characters. */
export function cut(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** Index ranges [from, to) merged where they touch. */
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** The lines inside the ranges, with `… (N lines)` for each gap. */
export function pick(lines: readonly string[], ranges: [number, number][]): string[] {
  const out: string[] = []
  let at = 0
  for (const [from, to] of mergeRanges(ranges)) {
    const a = Math.max(from, 0)
    const b = Math.min(to, lines.length)
    if (a > at) out.push(`… (${a - at} lines)`)
    out.push(...lines.slice(Math.max(a, at), b))
    at = Math.max(at, b)
  }
  if (at < lines.length) out.push(`… (${lines.length - at} lines)`)
  return out
}
