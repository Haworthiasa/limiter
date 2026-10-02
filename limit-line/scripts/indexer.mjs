#!/usr/bin/env node
// Reads ~/.claude/projects/**/*.jsonl incrementally into one aggregate per day (DayAgg):
//   node indexer.mjs --data <DATA_DIR> [--since YYYY-MM-DD] [--projects <dir>] [--rebuild]
// Keeps per file {size, mtime, offset} in index/state.json and reads only what is new.
// Writes numbers and ids, never message text. Prints one JSON summary line.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { bustCause, costOf, ctxOf, isBust, nextTtl1h } from '../hooks/metrics.ts'
import { dayKey, TZ_OFFSET_MIN } from '../hooks/paths.ts'

const t0 = performance.now()
const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const DATA = opt('data') ?? join(homedir(), '.local/share/limit-line')
const PROJECTS = opt('projects') ?? join(homedir(), '.claude/projects')
const SINCE = opt('since')
const REBUILD = args.includes('--rebuild')
const MAX_BUSTS = 50
const KEEP_KEYS = 64

const stateFile = join(DATA, 'index/state.json')
const daysDir = join(DATA, 'index/days')
if (REBUILD) {
  rmSync(join(DATA, 'index'), { recursive: true, force: true })
}
mkdirSync(daysDir, { recursive: true })

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** { files: { path: { size, mtime, offset, keys[] } }, sessions: { seq: Prev & { compactAt? } } } */
const state = readJson(stateFile, { files: {}, sessions: {} })

function* jsonlFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* jsonlFiles(p)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p
  }
}

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })
const addTokens = (t, r, cost) => {
  t.input += r.input
  t.output += r.output
  t.cacheRead += r.cacheRead
  t.cacheWrite += r.cacheWrite
  t.costUsd += cost
}

const days = new Map()
const dayAgg = date => {
  let d = days.get(date)
  if (!d) {
    d = readJson(join(daysDir, `${date}.json`), null) ?? {
      date,
      byModel: {},
      byProject: {},
      total: emptyTokens(),
      requests: 0,
      subagentRequests: 0,
      busts: [],
      bad: 0,
    }
    days.set(date, d)
  }
  return d
}

let newLines = 0
let requests = 0
let bad = 0
let files = 0

for (const path of jsonlFiles(PROJECTS)) {
  const st = statSync(path)
  const prev = state.files[path] ?? { size: 0, mtime: 0, offset: 0, keys: [] }
  // A file that shrank was rewritten: read it again from the start.
  if (st.size < prev.offset) prev.offset = 0
  if (st.size === prev.offset) continue
  files++

  const fd = openSync(path, 'r')
  const length = st.size - prev.offset
  const buf = Buffer.alloc(length)
  readSync(fd, buf, 0, length, prev.offset)
  closeSync(fd)
  const end = buf.lastIndexOf(0x0a)
  if (end < 0) continue
  const text = buf.subarray(0, end + 1).toString('utf8')
  const keys = new Set(prev.keys)
  const isSubagentFile = path.includes('/subagents/')

  for (const line of text.split('\n')) {
    if (!line) continue
    newLines++
    let o
    try {
      o = JSON.parse(line)
    } catch {
      bad++
      continue
    }
    const ts = Date.parse(o.timestamp ?? '')
    const sessionId = o.sessionId ?? basename(path, '.jsonl')
    const isSidechain = o.isSidechain === true || isSubagentFile
    const seq = isSidechain ? `${sessionId}:${o.agentId ?? basename(path)}` : sessionId

    // Compaction marks the session: the next request's bust is the compaction's.
    if ((o.type === 'system' && o.subtype === 'compact_boundary') || o.isCompactSummary === true) {
      state.sessions[seq] = { ...(state.sessions[seq] ?? {}), compactAt: Number.isNaN(ts) ? Date.now() : ts }
      continue
    }
    const m = o.message
    if (o.type !== 'assistant' || !m || typeof m !== 'object' || !m.usage) continue
    if (Number.isNaN(ts)) {
      bad++
      continue
    }
    const key = `${m.id}:${o.requestId}`
    if (keys.has(key)) continue
    keys.add(key)

    const u = m.usage
    const split = u.cache_creation
    const r = {
      ts,
      model: m.model ?? 'unknown',
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      ...(split ? { cacheWrite1h: split.ephemeral_1h_input_tokens ?? 0 } : {}),
    }
    if (r.model === '<synthetic>') continue
    const date = dayKey(ts, TZ_OFFSET_MIN)
    if (SINCE && date < SINCE) continue
    requests++
    const d = dayAgg(date)
    const project = basename(o.cwd ?? dirname(path))
    const cost = costOf(r, r.model) ?? 0
    addTokens(d.total, r, cost)
    addTokens((d.byModel[r.model] ??= emptyTokens()), r, cost)
    addTokens((d.byProject[project] ??= emptyTokens()), r, cost)
    d.requests++
    if (isSidechain) d.subagentRequests++

    const before = state.sessions[seq]
    const prevReq = before?.ts !== undefined ? before : undefined
    if (!isSidechain && isBust(r, prevReq)) {
      const compactBetween = before?.compactAt !== undefined && before.compactAt >= (before.ts ?? 0)
      const cause = bustCause(r, prevReq, compactBetween)
      if (d.busts.length < MAX_BUSTS) {
        d.busts.push({ ts, sessionId, project, model: r.model, prevModel: prevReq.model, gapMs: ts - prevReq.ts, ctx: ctxOf(r), cacheRead: r.cacheRead, cause })
      }
    }
    state.sessions[seq] = { ts, model: r.model, ttl1h: nextTtl1h(r, before?.ttl1h) }

    // A server-side sub-call (the advisor) is billed in `iterations` and left out of the
    // top-level usage: it counts toward the day, never toward busts.
    for (const it of u.iterations ?? []) {
      if (it.type === 'message') continue
      const sub = {
        ts,
        model: it.model ?? r.model,
        input: it.input_tokens ?? 0,
        output: it.output_tokens ?? 0,
        cacheRead: it.cache_read_input_tokens ?? 0,
        cacheWrite: it.cache_creation_input_tokens ?? 0,
        ...(it.cache_creation ? { cacheWrite1h: it.cache_creation.ephemeral_1h_input_tokens ?? 0 } : {}),
      }
      const subCost = costOf(sub, sub.model) ?? 0
      addTokens(d.total, sub, subCost)
      addTokens((d.byModel[sub.model] ??= emptyTokens()), sub, subCost)
      addTokens((d.byProject[project] ??= emptyTokens()), sub, subCost)
      d.serverCalls = (d.serverCalls ?? 0) + 1
    }
  }
  state.files[path] = { size: st.size, mtime: st.mtimeMs, offset: prev.offset + end + 1, keys: [...keys].slice(-KEEP_KEYS) }
}

// Sessions quiet for a week no longer matter for busts.
const cutoff = Date.now() - 7 * 24 * 3600_000
for (const [seq, s] of Object.entries(state.sessions)) {
  if ((s.ts ?? s.compactAt ?? 0) < cutoff) delete state.sessions[seq]
}

for (const [date, d] of days) {
  writeFileSync(join(daysDir, `${date}.json`), JSON.stringify(d))
}
if (bad > 0) {
  // Unparsable lines are counted on the day the run happened.
  const today = dayAgg(dayKey(Date.now(), TZ_OFFSET_MIN))
  today.bad += bad
  writeFileSync(join(daysDir, `${today.date}.json`), JSON.stringify(today))
}
writeFileSync(stateFile, JSON.stringify(state))

console.log(
  JSON.stringify({ files, newLines, requests, bad, days: [...days.keys()].sort(), ms: Math.round(performance.now() - t0) }),
)
