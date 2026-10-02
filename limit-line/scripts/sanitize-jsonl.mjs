#!/usr/bin/env node
// Strips a Claude Code transcript down to structure and numbers, for test fixtures:
// node sanitize-jsonl.mjs <in.jsonl> <out.jsonl>
// Keeps ids, timestamps, types, model and usage; drops every message text,
// tool input and tool output, and replaces cwd with a placeholder project path.
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { homedir } from 'node:os'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: sanitize-jsonl.mjs <in.jsonl> <out.jsonl>')
  process.exit(2)
}

const KEEP = ['type', 'subtype', 'uuid', 'parentUuid', 'timestamp', 'sessionId', 'requestId', 'isSidechain', 'isCompactSummary', 'agentId', 'version']
const out = []
for (const line of readFileSync(input, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let o
  try {
    o = JSON.parse(line)
  } catch {
    continue
  }
  const kept = {}
  for (const k of KEEP) if (o[k] !== undefined) kept[k] = o[k]
  // The home directory's own name is the user's login: never kept.
  if (o.cwd) kept.cwd = o.cwd === homedir() ? '/home/user' : `/home/user/${basename(o.cwd)}`
  if (o.compactMetadata) kept.compactMetadata = o.compactMetadata
  const m = o.message
  if (m && typeof m === 'object') {
    const msg = {}
    for (const k of ['id', 'role', 'model', 'stop_reason', 'usage']) if (m[k] !== undefined) msg[k] = m[k]
    if (Array.isArray(m.content)) msg.content = m.content.map(c => ({ type: c.type }))
    kept.message = msg
  }
  out.push(JSON.stringify(kept))
}
writeFileSync(output, out.join('\n') + '\n')
console.log(JSON.stringify({ input: basename(input), lines: out.length }))
