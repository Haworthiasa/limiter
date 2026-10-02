// The distiller's wiring: Bash and Read hooks, the /distill command, the log files.
// The filtering itself is in distill/ and has no $ in it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { DistillEvent, DistillKind } from '../types'
import { ANNOTATION, DISTILL_MIN_CHARS, annotation, distillText, isBypassed, isWrapped } from './distill/index.ts'
import { dataDir, monthKey, stamp, TZ_OFFSET_MIN, wrapCommand } from './paths.ts'

// The same $.state values register.tsx declares; an atom is read where it is written.
const distSession = atom({ plugin: 'limit-line', key: 'distSession' } as const, 0)
const distillOn = atom({ plugin: 'limit-line', key: 'distillOn' } as const, true)
// This session's distillations, newest last: for /distill last and the re-read check.
const distEvents = atom({ plugin: 'limit-line', key: 'distEvents' } as const, [] as DistillEvent[])

export const OFF_KEY = 'distill.off'
// Parts a log is split into stay under $.fs's 4 MiB.
const PART_CHARS = 1_000_000
const IGNORE_LINE = '.claude/distill/'

// $ goes into functions of this file only (the engine follows it no further).
async function home($: EngineInterface): Promise<string> {
  const h = await $.env.get('HOME')
  if (!h) throw new Error('HOME is not set')
  return h
}

async function dataPath($: EngineInterface, rel: string): Promise<string> {
  return `${dataDir(await home($))}/${rel}`
}

async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return fallback
  }
}

/** Reads the array at `path`, adds `items`, writes it back. */
async function appendJson<T>($: EngineInterface, path: string, items: readonly T[]): Promise<void> {
  if (items.length === 0) return
  const list = await readJson<T[]>($, path, [])
  await $.fs.write(path, JSON.stringify([...list, ...items]))
}

type BashOut = { stdout: string; stderr: string; persistedOutputPath?: string; persistedOutputSize?: number }

async function logDir($: EngineInterface): Promise<string> {
  return `${await $.session.cwd()}/.claude/distill`
}

/** Adds `.claude/distill/` to the project's .gitignore, in a git project, once. */
async function ensureIgnored($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const path = `${cwd}/.gitignore`
  let text = ''
  try {
    text = await $.fs.read(path)
  } catch {
    if (!(await $.fs.exists(`${cwd}/.git`))) return
  }
  if (text.split('\n').some(l => l.trim() === IGNORE_LINE || l.trim() === '.claude/distill')) return
  await $.fs.write(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${IGNORE_LINE}\n`)
}

async function record($: EngineInterface, kind: DistillKind, rawChars: number, outChars: number, logPath: string) {
  const ts = await $.clock.now()
  const event: DistillEvent = { ts, sessionId: await $.session.id(), kind, rawChars, outChars, logPath, reread: false }
  await update($, distEvents, list => [...list, event].slice(-200))
  await update($, distSession, n => n + Math.max(0, rawChars - outChars))
  await appendJson($, await dataPath($, `distill/${monthKey(ts, TZ_OFFSET_MIN)}.json`), [event])
}

/** A later command or Read that touches an earlier log marks that distillation re-read. */
async function noteReread($: EngineInterface, text: string): Promise<void> {
  const events = await read($, distEvents)
  const hit = events.filter(ev => !ev.reread && text.includes(ev.logPath))
  if (hit.length === 0) return
  const paths = new Set(hit.map(h => h.logPath))
  await update($, distEvents, list => list.map(ev => (paths.has(ev.logPath) ? { ...ev, reread: true } : ev)))
  // The month file keeps the flag for the dashboard.
  for (const ev of hit) {
    const file = await dataPath($, `distill/${monthKey(ev.ts, TZ_OFFSET_MIN)}.json`)
    const list = await readJson<DistillEvent[]>($, file, [])
    await $.fs.write(file, JSON.stringify(list.map(x => (x.logPath === ev.logPath ? { ...x, reread: true } : x))))
  }
}

/** A successful result, distilled in place; the original when it is short or anything fails. */
async function distillResult($: EngineInterface, out: BashOut): Promise<BashOut | undefined> {
  const raw = out.persistedOutputPath
    ? await $.fs.read(out.persistedOutputPath)
    : out.stderr
      ? `${out.stdout}\n${out.stderr}`
      : out.stdout
  if (raw.length < DISTILL_MIN_CHARS) return undefined
  const d = distillText(raw)
  const dir = await logDir($)
  const base = `${dir}/${stamp(await $.clock.now(), TZ_OFFSET_MIN)}-${d.kind}`
  let logPath = `${base}.log`
  if (raw.length <= PART_CHARS) {
    await $.fs.write(logPath, raw)
  } else {
    for (let i = 0; i * PART_CHARS < raw.length; i++) {
      await $.fs.write(`${base}.part${i + 1}.log`, raw.slice(i * PART_CHARS, (i + 1) * PART_CHARS))
    }
    logPath = `${base}.part1.log`
  }
  await ensureIgnored($)
  await record($, d.kind, d.rawChars, d.outChars, logPath)
  const copy: BashOut = { ...out, stdout: `${d.out}\n${annotation(d, logPath)}`, stderr: '' }
  delete copy.persistedOutputPath
  delete copy.persistedOutputSize
  return copy
}

export function registerDistiller(on: On): void {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    try {
      await noteReread($, e.file_path)
    } catch {
      // Observation only.
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      await noteReread($, e.command)
    } catch {
      // Observation only.
    }
    let isOn = true
    try {
      isOn = await read($, distillOn)
    } catch {
      // On by default.
    }
    if (!isOn || isBypassed(e.command) || e.run_in_background) return next(e)

    if (isWrapped(e.command)) {
      // Failing output cannot be shortened once it ran (NOTES.md): the command is wrapped.
      let command: string
      try {
        const dir = await logDir($)
        await ensureIgnored($)
        const log = `${dir}/${stamp(await $.clock.now(), TZ_OFFSET_MIN)}.log`
        await $.fs.write(log, '')
        command = wrapCommand(e.command, log, `${$.plugin.root}/hooks/distill/cli.ts`)
      } catch {
        return next(e)
      }
      const ran = await next({ ...e, command })
      try {
        const m = ran.deny === undefined && ran.text !== undefined ? ANNOTATION.exec(ran.text) : null
        if (m) await record($, m[1] as DistillKind, Number(m[2]), Number(m[3]), m[4] as string)
      } catch {
        // The output is already distilled; only the statistics miss it.
      }
      return ran
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    try {
      const copy = await distillResult($, ran.result as BashOut)
      return copy ? { result: copy as typeof ran.result } : ran
    } catch {
      return ran
    }
  })

  on('command.run', { command: /^distill(-x)?$/ }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') {
      await update($, distillOn, () => arg === 'on')
      await $.store.set(OFF_KEY, arg === 'off')
      return { text: arg === 'on' ? 'Distiller: bật.' : 'Distiller: tắt.' }
    }
    const events = await read($, distEvents)
    if (arg === 'last') {
      const last = events[events.length - 1]
      return { text: last ? `Lần gần nhất (${last.kind}): ${last.logPath}` : 'Phiên này chưa chưng cất lần nào.' }
    }
    if (arg === 'stats' || arg === '') {
      const ts = await $.clock.now()
      const month = await readJson<DistillEvent[]>($, await dataPath($, `distill/${monthKey(ts, TZ_OFFSET_MIN)}.json`), [])
      const lines = [`Distiller: ${(await read($, distillOn)) ? 'bật' : 'tắt'}. Phiên này ${events.length} lần, tháng này ${month.length} lần.`]
      const byKind = new Map<string, { n: number; cut: number; reread: number }>()
      for (const ev of month) {
        const k = byKind.get(ev.kind) ?? { n: 0, cut: 0, reread: 0 }
        k.n++
        k.cut += Math.max(0, ev.rawChars - ev.outChars)
        if (ev.reread) k.reread++
        byKind.set(ev.kind, k)
      }
      for (const [kind, k] of byKind) {
        lines.push(`  ${kind}: ${k.n} lần, cắt ${k.cut} ký tự, đọc lại ${k.reread}/${k.n} (${Math.round((k.reread / k.n) * 100)}%)`)
      }
      return { text: lines.join('\n') }
    }
    return { text: 'Dùng: /distill on | off | stats | last' }
  })
}
