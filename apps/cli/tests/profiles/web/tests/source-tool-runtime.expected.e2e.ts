/** Source CLI resolution must keep the Web tool runtime and agent loop in one module graph. */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from '../../../../src/process-shutdown.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

// The Windows profile does not ship Bash.
it.skipIf(process.platform === 'win32')('runs the first Bash call through the source Web CLI', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-web-tools-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions')
  await mkdir(sessions)
  const provider = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'],
    toolName: 'bash',
    toolArguments: JSON.stringify({
      command: 'printf SOURCE_WEB_TOOL_OK > result.txt; cat result.txt',
      description: 'Write and read the source Web tool marker',
    }),
    successText: 'DONE',
  })
  test.onTestFinished(() => provider.close())
  const patch = join(root, 'test.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-deepseek', config: { protocol: 'chat-completions', baseURL: provider.baseURL, thinking: 'disabled' } },
    { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
  ]) + '\n')
  // Source resolution is the subject: the shipped CLI uses the ESM-only tsx hook.
  const launch = resolveExampleLaunch({
    srcBin: join(repoRoot, 'apps/cli/src/bin.ts'),
    mode: 'src',
    sourceImport: 'tsx/esm',
    tsconfigPath: join(repoRoot, 'tsconfig.json'),
    configArgs: ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    env: {
      NODE_OPTIONS: undefined,
      NODE_PATH: undefined,
      DSH_HOME: join(root, 'home'),
      DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'keyless-source-web-tools',
      DEEPSEEK_BASE_URL: provider.baseURL,
    },
  })
  test.signal.throwIfAborted()
  const child = execa(launch.command, launch.args, {
    cwd: root,
    env: launch.env,
    input: '',
    reject: false,
  })
  let stdout = ''
  let stderr = ''
  let exited = false
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  void child.then(() => { exited = true })
  const diagnostics = (): string => `${stdout}\n${stderr}`
  test.onTestFinished(async () => {
    if (!exited) child.kill('SIGTERM')
    // Allow the CLI's graceful shutdown deadline and its process exit to settle.
    const kill = setTimeout(() => child.kill('SIGKILL'), PROCESS_SHUTDOWN_TIMEOUT_MS * 2)
    try {
      const result = await child
      expect(result.timedOut, diagnostics()).toBe(false)
      expect(result.signal, diagnostics()).toBeUndefined()
      expect(result.exitCode, diagnostics()).toBe(0)
    } finally {
      clearTimeout(kill)
    }
  })
  await expect.poll(() => {
    test.signal.throwIfAborted()
    if (exited) throw new Error(`Source Web CLI exited before readiness\n${diagnostics()}`)
    return /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)?.[1]
  }, { timeout: test.task.timeout }).toBeDefined()
  const url = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)![1]!
  const auth = await fetch(url, { redirect: 'manual', signal: test.signal })
  const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Web authentication did not return a cookie')
  async function remote<T>(endpoint: string, request: object): Promise<T> {
    const response = await fetch(new URL(`/api/${endpoint}`, url), {
      method: 'POST',
      signal: test.signal,
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method: endpoint, payload: { args: { request } } }),
    })
    expect(response.ok, await response.clone().text()).toBe(true)
    const body = await response.json() as {
      result: { ok: true; value: T } | { ok: false; error: { message: string } }
    }
    if (!body.result.ok) throw new Error(`${endpoint}: ${body.result.error.message}`)
    return body.result.value
  }
  const { sessionId } = await remote<{ sessionId: string }>('session/create', { cwd: root })
  await remote('session/prompt', {
    sessionId, requestId: 'source-web-tool-turn', mode: 'queue',
    content: [{ type: 'text', text: 'Write and read the source Web tool marker, then finish.' }],
  })
  let events: SessionEvent[] = []
  await expect.poll(async () => {
    test.signal.throwIfAborted()
    if (exited) throw new Error(`Source Web CLI exited during the turn\n${diagnostics()}`)
    const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'))
    events = (await Promise.all(files.map(file => readFile(join(sessions, file), 'utf8'))))
      .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as SessionEvent))
    return events.find(event => event.type === 'turn/end')
  }, { timeout: test.task.timeout }).toBeDefined()
  const turnEnd = events.find(event => event.type === 'turn/end')
  expect(turnEnd, `${diagnostics()}\n${JSON.stringify(turnEnd)}`)
    .toMatchObject({ data: { reason: { kind: 'completed' } } })
  expect(events.find(event => event.type === 'tool/result')).toMatchObject({ data: { message: { content: [{
    isError: false, content: [{ type: 'text', text: 'SOURCE_WEB_TOOL_OK' }],
  }] } } })
  expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('SOURCE_WEB_TOOL_OK')
  expect(provider.requests).toHaveLength(2)
})
