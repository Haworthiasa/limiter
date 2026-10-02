import { describe, expect, mock, test } from 'claude-code/testing'

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)
const SURFACES = ['terminal', 'desktop'] as const
const BAND = (surface: (typeof SURFACES)[number], bodyColumns = 160) =>
  ({
    plugin: 'limit-line',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns },
  }) as any

const usage = (input: number, output: number, read: number, write: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  model: 'claude-opus-5-5',
})

describe('band v2 in a session', () => {
  test('turn.complete moves cache and the context delta; [+] opens the turn line', async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    let ctxTokens = 40_000
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'limits' } }))
    on('session.usage', () => ({
      value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, tokens: ctxTokens } },
    }))
    // Beneath the plugin, each step answers with the usage the test queued.
    const queued: ReturnType<typeof usage>[] = []
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: queued.shift() ?? null } as any
    })
    on('turn.complete', () => ({ text: '' }))

    const step = async (turnId: string, index: number, u: ReturnType<typeof usage>, agentId?: string) => {
      queued.push(u)
      const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}) })
      for await (const _ of s) {
        // drain
      }
      await s.result
    }

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    // Turn 1: no delta yet (nothing to compare with).
    await step('t1', 0, usage(2_000, 500, 30_000, 8_000))
    await $.turn.complete({ turnId: 't1', answer: '', reason: 'answer', isAborted: false } as any)
    let ui = await $.ui.mount(BAND('terminal'))
    expect(await ui.find({ type: 'Text', text: /▲/ })).toBeUndefined()
    await ui.unmount()

    // Turn 2: two main steps and one subagent step; context grows by 21k.
    ctxTokens = 61_000
    await step('t2', 0, usage(1_000, 1_000, 50_000, 2_000))
    await step('t2', 1, usage(1_000, 1_300, 5_000, 2_000))
    await step('t2', 2, usage(999_999, 0, 0, 0), 'sub-1')
    await $.turn.complete({ turnId: 't2', answer: '', reason: 'answer', isAborted: false } as any)

    for (const surface of SURFACES) {
      ui = await $.ui.mount(BAND(surface))
      // 55k read of 61k total input.
      expect((await ui.find({ type: 'Text', text: '90%' }))?.props.color).toBe('green')
      expect((await ui.find({ type: 'Text', text: '▲+21k' }))?.props.color).toBe('yellow')
      expect(await ui.find({ type: 'Text', text: /turn/ })).toBeUndefined()

      await ui.press({ key: 'expand' } as any)
      expect(await ui.find({ type: 'Text', text: '2 req' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /cache 55k · write 4k · new 2k/ })).toBeDefined()
      await ui.press({ key: 'expand' } as any)
      expect(await ui.find({ type: 'Text', text: '2 req' })).toBeUndefined()
      await ui.unmount()
    }

    // /limits detail flips it too, and the choice is remembered in the store.
    const r = await $.command.run({ command: 'limits', args: 'detail' } as any)
    expect((r as any).text).toContain('bật')
    ui = await $.ui.mount(BAND('terminal'))
    expect(await ui.find({ type: 'Text', text: '2 req' })).toBeDefined()
    await ui.unmount()
  })

  test('a remembered expanded band opens expanded', async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on, { 'band.expanded': true })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'limits' } }))
    on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, tokens: 5_000 } } }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.complete({
      turnId: 't1', answer: '', reason: 'answer', isAborted: false,
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 4_995, model: 'claude-opus-5-5' },
    } as any)
    const ui = await $.ui.mount(BAND('terminal'))
    // No step was summed: the turn's own total stands in, as one request.
    expect(await ui.find({ type: 'Text', text: '1 req' })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: '−' } as any)).toBeDefined()
    await ui.unmount()
  })
})
