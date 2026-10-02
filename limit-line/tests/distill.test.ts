import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ERROR_LINE, clean, foldRuns, shape } from '../hooks/distill/common.ts'
import { detect } from '../hooks/distill/detect.ts'
import { generic } from '../hooks/distill/generic.ts'
import { ANNOTATION, DISTILL_TARGET_CHARS, annotation, distillText, isBypassed, isWrapped } from '../hooks/distill/index.ts'
import { wrapCommand } from '../hooks/paths'

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)
import { LOGS } from './fixtures/logs.gen'

// Every real log fixture, keyed `<kind>/<file>`.
const FIXTURES = LOGS
const PYTEST = Object.keys(LOGS).filter(k => k.startsWith('pytest/'))
const fixture = async (_: unknown, name: string): Promise<string> => FIXTURES[name] as string

/** Every FAILED/ERROR nodeid of a pytest log. */
function failedIds(text: string): string[] {
  return clean(text)
    .split('\n')
    .map(l => /^(FAILED|ERROR) (\S+)/.exec(l)?.[2])
    .filter((x): x is string => x !== undefined)
}

describe('pytest filter on real fixtures', () => {
  test('≥80% smaller, under the limit, every failure named or counted, annotated', async ($: any, on) => {
    expect(PYTEST.length).toBeGreaterThan(0)
    for (const name of PYTEST) {
      const raw = await fixture($, name)
      const d = distillText(raw)
      expect(d.kind).toBe('pytest')
      expect(d.outChars).toBeLessThanOrEqual(DISTILL_TARGET_CHARS)
      expect(d.outChars).toBeLessThanOrEqual(raw.length * 0.2)
      // Counted: the group sizes add up to every failure; named: each shown id is a real one.
      const ids = failedIds(raw)
      const counted = [...d.out.matchAll(/^## (?:FAILED|ERROR) ×(\d+)/gm)].reduce((n, m) => n + Number(m[1]), 0)
      expect(counted).toBe(ids.length)
      for (const shown of d.out.split('\n').filter(l => /^ {3}tests\//.test(l))) {
        expect(ids.includes(shown.trim())).toBe(true)
      }
      // The summary line survives.
      expect(d.out).toMatch(/\d+ failed, \d+ passed, 1 error in/)
      const note = annotation(d, '/work/.claude/distill/x-pytest.log')
      expect(ANNOTATION.exec(`${d.out}\n${note}`)?.[4]).toBe('/work/.claude/distill/x-pytest.log')
    }
  })

  test('a 4 MiB log takes under 2 s', async ($: any, on) => {
    const raw = await fixture($, 'pytest/color-many-fail.log')
    const big = raw.repeat(Math.ceil((4 * 1024 * 1024) / raw.length))
    const t = performance.now()
    const d = distillText(big)
    expect(performance.now() - t).toBeLessThan(2000)
    expect(d.outChars).toBeLessThanOrEqual(DISTILL_TARGET_CHARS)
  })
})

describe('generic filter', () => {
  test('never loses an error or traceback line, on every fixture', async ($: any, on) => {
    for (const name of Object.keys(FIXTURES)) {
      const text = clean(await fixture($, name))
      const out = generic(text, DISTILL_TARGET_CHARS)
      for (const line of text.split('\n').filter(l => ERROR_LINE.test(l))) {
        expect(out.includes(line.slice(0, 150))).toBe(true)
      }
    }
  })

  test('head and tail of a plain log, folded repeats', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `step ${i} ok`)
    lines[1500] = 'Traceback (most recent call last):'
    const out = generic(lines.join('\n'), DISTILL_TARGET_CHARS)
    expect(out).toContain('step 0 ok')
    expect(out).toContain('Traceback (most recent call last):')
    expect(out).toContain('step 2999 ok')
    expect(out).toMatch(/… \(×\d+\)/)
    expect(out.length).toBeLessThanOrEqual(DISTILL_TARGET_CHARS)
  })
})

describe('pieces', () => {
  test('cleaning, shapes, detection, routing', async () => {
    expect(clean('\x1b[31mred\x1b[0m')).toBe('red')
    expect(clean('10%\r50%\r100%\ndone')).toBe('100%\ndone')
    expect(shape('2026-10-02T03:00:00Z step 12 0xdead')).toBe('<ts> step <n> <hex>')
    expect(foldRuns(['a 1', 'a 2', 'a 3', 'b'])).toEqual(['a 1', '… (×3)', 'a 3', 'b'])
    expect(foldRuns(['a 1', 'a 2'])).toEqual(['a 1', 'a 2'])
    expect(detect('===== test session starts =====\n')).toBe('pytest')
    expect(detect('hello')).toBe('generic')
    expect(isWrapped('cd x && python -m pytest -q')).toBe(true)
    expect(isWrapped('pytest tests/')).toBe(true)
    expect(isWrapped('uv pip install torch')).toBe(true)
    expect(isWrapped('ls -la')).toBe(false)
    expect(isBypassed('NO_DISTILL=1 pytest')).toBe(true)
    expect(isBypassed('cat .claude/distill/x.log')).toBe(true)
    const w = wrapCommand("echo 'hi'", "/w/it's.log", '/p/cli.ts')
    expect(w).toContain("echo 'hi'\n}")
    expect(w).toContain("'/w/it'\\''s.log'")
    expect(w.endsWith('exit $__ll_rc')).toBe(true)
  })
})

// An in-memory file system beneath the plugin.
function memfs(on: On, files: Map<string, string>, failWrites = false) {
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as any
  })
  on('fs.write', ($, e) => {
    if (failWrites) throw new Error('EACCES')
    files.set(e.path, e.text)
    return { value: undefined } as any
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }) as any)
}

function session(on: On, files: Map<string, string>, failWrites = false) {
  mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  memfs(on, files, failWrites)
  on('session.cwd', () => ({ value: '/work' }) as any)
  on('session.id', () => ({ value: 's1' }) as any)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000 } } }))
}

describe('the Bash hook', () => {
  test('distills a long successful output, keeps the log, ignores it in git, counts it', async ($: any, on) => {
    const files = new Map<string, string>([['/work/.git', ''], ['/work/.gitignore', 'node_modules/\n']])
    session(on, files)
    const raw = Array.from({ length: 2000 }, (_, i) => `line ${i} fine`).join('\n') + '\nfatal: it broke\n'
    on('tool.call', () => ({ result: { stdout: raw, stderr: '', interrupted: false } }) as any)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const r = await $.tool.call({ tool: 'Bash', command: 'seq 2000' })
    expect(r.isError).toBeUndefined()
    const out = r.result.stdout as string
    expect(out.length).toBeLessThan(raw.length * 0.2)
    expect(out).toContain('fatal: it broke')
    const m = ANNOTATION.exec(out)
    expect(m?.[1]).toBe('generic')
    const log = m?.[4] as string
    expect(log.startsWith('/work/.claude/distill/')).toBe(true)
    expect(files.get(log)).toBe(raw)
    expect(files.get('/work/.gitignore')).toBe('node_modules/\n.claude/distill/\n')
    const month = JSON.parse(files.get('/home/u/.local/share/limit-line/distill/2026-10.json') as string)
    expect(month).toHaveLength(1)
    expect(month[0].rawChars).toBe(raw.length)

    // Reading the log afterwards marks it re-read; the read itself passes untouched.
    await $.tool.call({ tool: 'Bash', command: `cat ${log}` })
    const again = JSON.parse(files.get('/home/u/.local/share/limit-line/distill/2026-10.json') as string)
    expect(again[0].reread).toBe(true)
  })

  test('short output, NO_DISTILL=1, /distill off and errors pass through unchanged', async ($: any, on) => {
    const files = new Map<string, string>()
    session(on, files)
    const long = 'x\n'.repeat(10_000)
    on('tool.call', ($, e: any) =>
      e.command.includes('fail')
        ? ({ isError: true, result: 'Error: Exit code 1\n' + long, text: 'Exit code 1\n' + long } as any)
        : ({ result: { stdout: e.command.includes('short') ? 'ok' : long, stderr: '', interrupted: false } } as any),
    )
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    expect((await $.tool.call({ tool: 'Bash', command: 'echo short' })).result.stdout).toBe('ok')
    expect((await $.tool.call({ tool: 'Bash', command: 'NO_DISTILL=1 seq 9' })).result.stdout).toBe(long)
    const failed = await $.tool.call({ tool: 'Bash', command: 'run fail' })
    expect(failed.isError).toBe(true)
    expect(failed.text).toBe('Exit code 1\n' + long)

    await $.command.run({ command: 'distill', args: 'off' })
    expect((await $.tool.call({ tool: 'Bash', command: 'seq 9' })).result.stdout).toBe(long)
    await $.command.run({ command: 'distill', args: 'on' })
    expect((await $.tool.call({ tool: 'Bash', command: 'seq 9' })).result.stdout).not.toBe(long)
  })

  test('a failing write leaves the original result', async ($: any, on) => {
    const files = new Map<string, string>()
    session(on, files, true)
    const long = 'y\n'.repeat(10_000)
    on('tool.call', () => ({ result: { stdout: long, stderr: '', interrupted: false } }) as any)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect((await $.tool.call({ tool: 'Bash', command: 'seq 9' })).result.stdout).toBe(long)
  })

  test('an allowlisted command runs wrapped, and its annotation is counted', async ($: any, on) => {
    const files = new Map<string, string>()
    session(on, files)
    const seen: string[] = []
    on('tool.call', ($, e: any) => {
      seen.push(e.command)
      return {
        isError: true,
        result: 'Error: Exit code 1\nshort\n[distilled pytest 50000→900 · full log: /work/.claude/distill/a-pytest.log · raw: rerun with NO_DISTILL=1]',
        text: 'Exit code 1\nshort\n[distilled pytest 50000→900 · full log: /work/.claude/distill/a-pytest.log · raw: rerun with NO_DISTILL=1]',
      } as any
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const r = await $.tool.call({ tool: 'Bash', command: 'python -m pytest -q' })
    expect(r.isError).toBe(true)
    expect(seen[0]).toContain('{ python -m pytest -q\n}')
    expect(seen[0]).toContain('/hooks/distill/cli.ts')
    const month = JSON.parse(files.get('/home/u/.local/share/limit-line/distill/2026-10.json') as string)
    expect(month[0]).toMatchObject({ kind: 'pytest', rawChars: 50000, outChars: 900 })
  })
})
