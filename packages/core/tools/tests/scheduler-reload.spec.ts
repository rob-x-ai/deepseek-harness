/** The scheduler remains usable when its consumer reloads while its provider stays live. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineTool,
  getToolRuntimeScheduler,
  TOOL_RUNTIME_SCHEDULER,
  ToolRuntimeSchedulerUnavailableError,
} from '@deepseek-ai/dsh-tools'

async function provider() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('tool scheduler module identity', () => {
  it('dispatches through a live provider after the consumer module is evaluated again', async (test) => {
    const ctx = await provider()
    test.onTestFinished(() => ctx.fiber.dispose())
    const received: string[] = []
    ctx.tools.register(defineTool({
      name: 'record',
      description: 'record a supplied value',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute({ value }) {
        received.push(value)
        return value
      },
    }))
    const initial = getToolRuntimeScheduler(ctx.tools)
    vi.resetModules()
    const reloaded = await import('@deepseek-ai/dsh-tools')
    expect(reloaded.ToolRuntime).not.toBe(ToolRuntime)
    expect(reloaded.TOOL_RUNTIME_SCHEDULER).toBe(TOOL_RUNTIME_SCHEDULER)
    const scheduler = reloaded.getToolRuntimeScheduler(ctx.tools)
    expect(scheduler).toBe(initial)
    const prepared = await scheduler.prepare({
      callId: ToolCallId('after-reload'), name: 'record', arguments: { value: 'still live' },
      signal: new AbortController().signal,
    })
    expect(prepared.kind).toBe('dispatch')
    if (prepared.kind !== 'dispatch') throw new Error('registered tool was not dispatched')
    const dispatched = await scheduler.dispatch(prepared.exec)
    expect(dispatched.kind).toBe('post-result')
    const result = await scheduler.finalize(prepared.exec, dispatched.result)
    expect(result).toMatchObject({ isError: false, value: 'still live' })
    expect(received).toEqual(['still live'])
  })

  it('reports the consumer and provider packages when the scheduler is missing', async (test) => {
    const ctx = await provider()
    test.onTestFinished(() => ctx.fiber.dispose())
    Reflect.deleteProperty(ctx.tools, TOOL_RUNTIME_SCHEDULER)
    let failure: ToolRuntimeSchedulerUnavailableError | undefined
    try {
      getToolRuntimeScheduler(ctx.tools)
    } catch (error) {
      if (!(error instanceof ToolRuntimeSchedulerUnavailableError)) throw error
      failure = error
    }
    expect(failure).toBeInstanceOf(HarnessError)
    expect(failure?.code).toBe('TOOL_RUNTIME_SCHEDULER_UNAVAILABLE')
    expect(failure?.producer).toEqual(failure?.consumer)
    expect(failure?.consumer.moduleUrl).toContain('/tools/src/index.ts')
    expect(failure?.consumer.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(failure?.message).toContain(failure!.consumer.moduleUrl)
    expect(failure?.message).toContain(failure!.consumer.version)
    expect(failure?.message).toContain('Restart the Harness')
  })

  it('identifies an older service without scheduler metadata', () => {
    // A separately loaded older service may supply neither process-stable symbol.
    const unavailable = Object.create(null) as ToolRuntime
    expect(() => getToolRuntimeScheduler(unavailable)).toThrow(
      /provider: module metadata unavailable/u,
    )
  })
})
