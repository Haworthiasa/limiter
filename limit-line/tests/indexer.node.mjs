// The indexer against synthetic transcripts and the sanitized real ones:
//   node --test tests/indexer.node.mjs
// (A Node test: the indexer is a Node script, outside `claude plugin test`.)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname
const INDEXER = join(ROOT, 'scripts/indexer.mjs')

function run(projects, data, ...extra) {
  const out = execFileSync('node', [INDEXER, '--projects', projects, '--data', data, ...extra], { encoding: 'utf8' })
  return JSON.parse(out.trim().split('\n').pop())
}
const day = (data, date) => JSON.parse(readFileSync(join(data, 'index/days', `${date}.json`), 'utf8'))

let n = 0
function req(sessionId, iso, model, { input = 2, output = 10, read = 0, write = 0, w1h, id, sidechain = false, iterations } = {}) {
  n++
  const usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: write - (w1h ?? write), ephemeral_1h_input_tokens: w1h ?? write },
    ...(iterations ? { iterations } : {}),
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso,
    sessionId,
    requestId: `req_${id ?? n}`,
    isSidechain: sidechain,
    cwd: '/home/user/proj-a',
    message: { id: `msg_${id ?? n}`, model, usage },
  })
}
const compact = (sessionId, iso) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: iso, sessionId })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'll-idx-'))
  const projects = join(dir, 'projects')
  mkdirSync(join(projects, 'p'), { recursive: true })
  return { projects, data: join(dir, 'data'), file: s => join(projects, 'p', `${s}.jsonl`) }
}

test('dedupes by message id + request id, splits days at Bangkok midnight, counts the advisor', () => {
  const { projects, data, file } = setup()
  const line = req('s1', '2026-10-01T16:59:00Z', 'claude-opus-5-5', { id: 'dup', input: 100, output: 7 })
  writeFileSync(
    file('s1'),
    [
      line,
      line,
      line,
      req('s1', '2026-10-01T17:01:00Z', 'claude-opus-5-5', {
        input: 5,
        iterations: [
          { type: 'message', input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      }),
      'not json',
    ].join('\n') + '\n',
  )
  const s = run(projects, data)
  assert.equal(s.requests, 2)
  assert.equal(s.bad, 1)
  assert.deepEqual(s.days, ['2026-10-01', '2026-10-02'])
  assert.equal(day(data, '2026-10-01').total.input, 100)
  assert.equal(day(data, '2026-10-02').total.input, 1005)
  assert.equal(day(data, '2026-10-02').total.output, 60)
  assert.equal(day(data, '2026-10-02').byProject['proj-a'].input, 1005)
})

test('one bust per cause, and the cases that are not busts', () => {
  const { projects, data, file } = setup()
  const big = { input: 2, read: 0, write: 50_000 }
  const warm = { input: 2, read: 49_000, write: 1_000 }
  writeFileSync(
    file('all'),
    [
      // First request of a session: never a bust.
      req('first', '2026-10-02T01:00:00Z', 'claude-opus-5-5', big),
      // compact
      req('c', '2026-10-02T01:00:00Z', 'claude-opus-5-5', warm),
      compact('c', '2026-10-02T01:01:00Z'),
      req('c', '2026-10-02T01:02:00Z', 'claude-opus-5-5', big),
      // model switch
      req('m', '2026-10-02T01:00:00Z', 'claude-opus-5-5', warm),
      req('m', '2026-10-02T01:01:00Z', 'claude-sonnet-5-5', big),
      // ttl: a 5-minute write, then 10 minutes of quiet
      req('t', '2026-10-02T01:00:00Z', 'claude-opus-5-5', { input: 2, read: 0, write: 30_000, w1h: 0 }),
      req('t', '2026-10-02T01:10:00Z', 'claude-opus-5-5', big),
      // the same gap after a 1-hour write: no TTL, so unknown
      req('u', '2026-10-02T01:00:00Z', 'claude-opus-5-5', { input: 2, read: 0, write: 30_000 }),
      req('u', '2026-10-02T01:10:00Z', 'claude-opus-5-5', big),
      // a warm request is no bust; a subagent's cold one is not judged
      req('u', '2026-10-02T01:11:00Z', 'claude-opus-5-5', warm),
      req('u', '2026-10-02T01:12:00Z', 'claude-opus-5-5', { ...big, sidechain: true }),
      // small requests are never busts
      req('m', '2026-10-02T01:30:00Z', 'claude-opus-5-5', { input: 100, read: 0, write: 5_000 }),
    ].join('\n') + '\n',
  )
  run(projects, data)
  const d = day(data, '2026-10-02')
  const causes = Object.fromEntries(d.busts.map(b => [b.sessionId, b.cause]))
  assert.deepEqual(causes, { c: 'compact', m: 'model_switch', t: 'ttl', u: 'unknown' })
  assert.equal(d.subagentRequests, 1)
  for (const b of d.busts) assert.equal(b.ctx, 50_002)
})

test('reads incrementally, and a rebuild reads everything again', () => {
  const { projects, data, file } = setup()
  writeFileSync(file('s'), req('s', '2026-10-02T01:00:00Z', 'claude-opus-5-5', { input: 10 }) + '\n')
  assert.equal(run(projects, data).requests, 1)
  appendFileSync(file('s'), req('s', '2026-10-02T01:01:00Z', 'claude-opus-5-5', { input: 20 }) + '\n')
  // A half-written last line waits for the next run.
  appendFileSync(file('s'), req('s', '2026-10-02T01:02:00Z', 'claude-opus-5-5', { input: 40 }).slice(0, 30))
  const second = run(projects, data)
  assert.equal(second.requests, 1)
  assert.equal(day(data, '2026-10-02').total.input, 30)
  assert.equal(run(projects, data).requests, 0)
  assert.equal(run(projects, data, '--rebuild').requests, 1 + 1)
  assert.equal(day(data, '2026-10-02').total.input, 30)
})

test('the sanitized real transcripts index with no bad lines and deduped requests', () => {
  const { projects, data } = setup()
  cpSync(join(ROOT, 'tests/fixtures/jsonl'), join(projects, 'p'), { recursive: true })
  const s = run(projects, data)
  assert.equal(s.bad, 0)
  // 15 unique requests in the short session (35 lines); the long one adds its own.
  assert.ok(s.requests >= 15)
  const totals = s.days.map(d => day(data, d).requests).reduce((a, b) => a + b, 0)
  assert.equal(totals, s.requests)
})
