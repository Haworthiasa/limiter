// Where the mod keeps its data and names its files. Pure, given HOME and a clock reading.

/** DATA_DIR: no per-plugin data folder exists in this build (NOTES.md). */
export function dataDir(home: string): string {
  return `${home}/.local/share/limit-line`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar fields of `ms` at UTC offset `offsetMin` (minutes east). */
export function local(ms: number, offsetMin: number) {
  const d = new Date(ms + offsetMin * 60_000)
  return {
    y: d.getUTCFullYear(),
    m: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    hh: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
  }
}

/** `2026-10-02` */
export function dayKey(ms: number, offsetMin: number): string {
  const t = local(ms, offsetMin)
  return `${t.y}-${t.m}-${t.d}`
}

/** `2026-10` */
export function monthKey(ms: number, offsetMin: number): string {
  const t = local(ms, offsetMin)
  return `${t.y}-${t.m}`
}

/** `20261002-101500` */
export function stamp(ms: number, offsetMin: number): string {
  const t = local(ms, offsetMin)
  return `${t.y}${t.m}${t.d}-${t.hh}${t.mm}${t.ss}`
}

/** One argument for sh, single-quoted. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The command run in place of `command`: its whole output to `log`, the CLI's distillation
 * printed, the original exit status kept. A missing node prints the log as it is.
 * A subshell, so an `exit` or `set -e` inside the command cannot skip the printing. */
export function wrapCommand(command: string, log: string, cli: string): string {
  const l = shQuote(log)
  return `( ${command}\n) > ${l} 2>&1; __ll_rc=$?; node ${shQuote(cli)} ${l} 2>/dev/null || cat ${l}; exit $__ll_rc`
}

/** Asia/Bangkok: the day boundary for ledgers and aggregates (PLAN §8). */
export const TZ_OFFSET_MIN = 7 * 60
