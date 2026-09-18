/** Inject scheduler failures for selected responses, restoring the runtime before recovery. */
export const name = 'scheduler-unavailable-fixture'
export const inject = ['tools', 'llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime.
 * @param {{ prompt: string, preparePrompt?: string }} config - Prompts selecting missing and throwing schedulers.
 */
export function apply(ctx, config) {
  const key = Symbol.for('@deepseek-ai/dsh-tools.scheduler')
  const scheduler = ctx.tools[key]
  let missingInjected = false
  let prepareInjected = false
  let changed = false
  ctx.effect(() => () => { ctx.tools[key] = scheduler })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== undefined) {
      yield* next()
      return
    }
    if (changed) {
      ctx.tools[key] = scheduler
      changed = false
    }
    const hasPrompt = prompt => options.messages.some(message =>
      message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === prompt),
    )
    if (!missingInjected && hasPrompt(config.prompt)) {
      ctx.tools[key] = undefined
      missingInjected = true
      changed = true
    } else if (!prepareInjected && hasPrompt(config.preparePrompt)) {
      ctx.tools[key] = {
        ...scheduler,
        async prepare() { throw new Error('Authored scheduler prepare failure') },
      }
      prepareInjected = true
      changed = true
    }
    yield* next()
  })
}
