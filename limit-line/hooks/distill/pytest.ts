// pytest: the summary, failures grouped by what failed, the first traceback of each group.
// Every FAILED/ERROR test is either named or counted in its group.

import { cut, shape } from './common.ts'

export type PytestOptions = { traceLines: number; examples: number }
export const PYTEST: PytestOptions = { traceLines: 25, examples: 5 }

type Entry = { status: 'FAILED' | 'ERROR'; nodeid: string; msg: string }
type Group = { status: string; signature: string; example: string; entries: Entry[]; trace: string[] }

const SUMMARY = /^(?:=+ )?(?:\d+ (?:failed|passed|errors?|skipped|deselected|xfailed|xpassed|warnings?|rerun)(?:, )?)+.* in [\d.]+s(?: \(.*\))?(?: =+)?$/
const SECTION = /^=+ (.+?) =+$/
const BLOCK = /^_{3,} (.+?) _{3,}$/
const ENTRY = /^(FAILED|ERROR) (\S+)(?: - (.*))?$/

/** The test a block header names: `test_x[1]` of `ERROR at setup of test_x[1]`. */
function blockTest(title: string): string {
  return title.replace(/^ERROR at (?:setup|teardown) of /, '')
}

function testOf(nodeid: string): string {
  const i = nodeid.lastIndexOf('::')
  return i < 0 ? nodeid : nodeid.slice(i + 2)
}

/** What failed, with numbers and quoted text blanked so like failures group together. */
function signatureOf(text: string): string {
  return shape(text.replace(/'[^']*'|"[^"]*"/g, '…'))
    .replace(/\s+/g, ' ')
    .trim()
}

export function pytest(text: string, limit: number, opts: PytestOptions = PYTEST): string {
  const lines = text.split('\n')
  const summary = [...lines].reverse().find(l => SUMMARY.test(l.trim()))

  // FAILURES / ERRORS blocks, by the test they name.
  const blocks = new Map<string, string[]>()
  let section = ''
  let current: string[] | undefined
  for (const line of lines) {
    const s = SECTION.exec(line)
    if (s) {
      section = s[1] as string
      current = undefined
      continue
    }
    if (section !== 'FAILURES' && section !== 'ERRORS') continue
    const b = BLOCK.exec(line)
    if (b) {
      current = []
      const name = blockTest(b[1] as string)
      if (!blocks.has(name)) blocks.set(name, current)
      continue
    }
    current?.push(line)
  }

  // The short summary names each failed test; without one, the block headers do.
  let entries: Entry[] = lines
    .map(l => ENTRY.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ status: m[1] as Entry['status'], nodeid: m[2] as string, msg: m[3] ?? '' }))
  if (entries.length === 0) {
    entries = [...blocks.keys()].map(name => ({ status: 'FAILED', nodeid: name, msg: '' }))
  }

  const groups = new Map<string, Group>()
  for (const entry of entries) {
    const block = blocks.get(testOf(entry.nodeid))
    const eLine = block?.find(l => l.startsWith('E '))?.slice(1).trim()
    const example = eLine ?? entry.msg
    const signature = signatureOf(example)
    const key = `${entry.status} ${signature}`
    let g = groups.get(key)
    if (!g) {
      const trace = (block ?? []).filter(l => l.trim() !== '' && !/^(_ )+_?$/.test(l.trim()))
      g = { status: entry.status, signature, example, entries: [], trace }
      groups.set(key, g)
    }
    g.entries.push(entry)
  }
  const ordered = [...groups.values()].sort((a, b) => b.entries.length - a.entries.length)

  const render = (traceLines: number, examples: number): string => {
    const out: string[] = []
    if (summary) out.push(summary.trim())
    const failed = entries.filter(e => e.status === 'FAILED').length
    const errors = entries.length - failed
    out.push(`[pytest] ${failed} failed, ${errors} error${errors === 1 ? '' : 's'} in ${ordered.length} group${ordered.length === 1 ? '' : 's'}`)
    for (const g of ordered) {
      out.push('', `## ${g.status} ×${g.entries.length}  ${cut(g.example || '(no message)', 200)}`)
      const shown = g.entries.slice(0, examples).map(e => `   ${e.nodeid}`)
      out.push(...shown)
      if (g.entries.length > examples) out.push(`   … +${g.entries.length - examples} more`)
      if (traceLines > 0 && g.trace.length > 0) {
        out.push(...g.trace.slice(-traceLines).map(l => `   | ${cut(l, 200)}`))
      }
    }
    return out.join('\n')
  }

  const tries: [number, number][] = [
    [opts.traceLines, opts.examples],
    [12, opts.examples],
    [6, 3],
    [3, 2],
    [0, 1],
  ]
  let out = ''
  for (const [t, ex] of tries) {
    out = render(t, ex)
    if (out.length <= limit) return out
  }
  return out
}
