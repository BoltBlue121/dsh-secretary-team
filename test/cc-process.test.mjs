import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { buildClaudeArgs, runClaudeProcess } from '../lib/cc-process.mjs'

const config = {
  executablePath: 'G:/fixture/claude.exe', model: 'claude-opus-5-5',
  timeoutMs: 1000, maxOutputBytes: 65536, maxBudgetUsd: 1.25, disposeGraceMs: 100,
}
const leaderMcp = { mcpServers: { dsh_workers: { command: 'node', args: ['worker-bridge.mjs'] } } }
const context = { role: 'leader', mcpConfig: leaderMcp, systemPrompt: 'trusted system instruction', runId: 'run-fixture' }
const value = (args, flag) => args[args.indexOf(flag) + 1]

test('leader argv limits native and MCP tools and disables external settings/hooks without bypass', async () => {
  const args = buildClaudeArgs(config, context)
  for (const flag of ['-p', '--verbose', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag), flag)
  assert.equal(value(args, '--output-format'), 'stream-json')
  assert.equal(value(args, '--permission-mode'), 'acceptEdits')
  assert.equal(value(args, '--model'), 'claude-opus-5-5')
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep,Edit,Write,Bash')
  assert.equal(value(args, '--allowedTools'), 'Read,Glob,Grep,Edit,Write,Bash,mcp__dsh_workers__dispatch_worker,mcp__dsh_workers__wait_worker,mcp__dsh_workers__worker_status,mcp__dsh_workers__cancel_worker')
  assert.equal(value(args, '--disallowedTools'), 'Agent,Task,AskUserQuestion')
  assert.equal(value(args, '--setting-sources'), '')
  assert.deepEqual(JSON.parse(value(args, '--settings')), { disableAllHooks: true })
  assert.deepEqual(JSON.parse(value(args, '--mcp-config')), leaderMcp)
  assert.equal(value(args, '--system-prompt'), 'trusted system instruction')
  assert.equal(value(args, '--max-budget-usd'), '1.25')
  assert.ok(!args.some(arg => /bypass|dangerously-skip/.test(arg)))
  assert.ok(!args.includes('run-fixture'), 'run identity is metadata, not an unsupported CLI argument')
})

test('worker discards supplied servers and cannot use leader member tools', async () => {
  const args = buildClaudeArgs(config, { ...context, role: 'worker' })
  assert.deepEqual(JSON.parse(value(args, '--mcp-config')), { mcpServers: {} })
  assert.equal(value(args, '--allowedTools'), 'Read,Glob,Grep,Edit,Write,Bash')
  assert.ok(!args.join(' ').includes('mcp__dsh_workers__'))
})

test('builder rejects invalid roles and nonpositive budgets instead of broadening permissions', async () => {
  assert.throws(() => buildClaudeArgs(config, { ...context, role: 'unknown' }), /INVALID_ROLE/)
  for (const maxBudgetUsd of [0, -1, NaN, Infinity, '1']) {
    assert.throws(() => buildClaudeArgs({ ...config, maxBudgetUsd }, context), /INVALID_CONFIG/)
  }
})

test('MCP env uses references only, so no credential literal enters config or argv', () => {
  const mcpConfig = { mcpServers: { dsh_workers: { ...leaderMcp.mcpServers.dsh_workers,
    env: { DSH_CC_WORKER_TOKEN: '${DSH_CC_WORKER_TOKEN}', DSH_CC_WORKER_URL: '${DSH_CC_WORKER_URL}' } } } }
  const args = buildClaudeArgs(config, { ...context, mcpConfig })
  assert.deepEqual(JSON.parse(value(args, '--mcp-config')), mcpConfig)
  const unsafe = { mcpServers: { dsh_workers: { ...leaderMcp.mcpServers.dsh_workers,
    env: { DSH_CC_WORKER_TOKEN: 'private-inline-token-secret' } } } }
  assert.throws(() => buildClaudeArgs(config, { ...context, mcpConfig: unsafe }), error => {
    assert.equal(error.message, 'INVALID_MCP_CONFIG')
    return true
  })
  assert.deepEqual(JSON.parse(value(buildClaudeArgs(config, { ...context, role: 'worker', mcpConfig: unsafe }), '--mcp-config')), { mcpServers: {} })
})

test('leader rejects additional MCP servers and malformed config rather than loading external capabilities', () => {
  for (const mcpConfig of [undefined, null, {}, { mcpServers: [] },
    { mcpServers: { unrelated: { command: 'private-external-command-secret' } } },
    { mcpServers: { dsh_workers: null } }]) {
    assert.throws(() => buildClaudeArgs(config, { ...context, mcpConfig }), /INVALID_MCP_CONFIG/)
  }
})

test('builder does not turn missing or option-shaped model names into CLI flags', () => {
  for (const model of [undefined, '', '  ', '--dangerously-skip-permissions', 'model\u0000']) {
    assert.throws(() => buildClaudeArgs({ ...config, model }, context), /INVALID_CONFIG/)
  }
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const success = extra => ({ type: 'result', subtype: 'success', is_error: false, result: '完成 ✓', ...extra })
const line = event => JSON.stringify(event) + '\n'

// Replace only the external managed process. Streams and their byte framing,
// backpressure, EOF, error delivery and Writable prompt input are real Node I/O.
function processFixture({ onStart, holdExit = false, autoTerminate = true, terminateError, waitError, waitFalse = false } = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough()
  const done = deferred(), exited = deferred(), terminated = deferred()
  const state = { specs: [], input: '', actions: [], exitConfirmed: false }
  const stdin = new Writable({ write(chunk, encoding, callback) { state.input += chunk.toString(); callback() } })
  function finish(exitCode = 0, signal = null) {
    stdout.end(); stderr.end(); done.resolve({ exitCode, signal })
    if (!holdExit) confirmExit()
  }
  function confirmExit() { state.exitConfirmed = true; exited.resolve(true) }
  const handle = {
    stdin, stdout, stderr, control: undefined, collected: {}, done: done.promise,
    terminate() {
      state.actions.push('terminate'); terminated.resolve()
      if (terminateError) throw terminateError
      if (autoTerminate) finish(1)
    },
    async waitForExit(signal) {
      state.actions.push('waitForExit')
      if (waitError) throw waitError
      if (waitFalse || signal?.aborted) return false
      let abort
      const cancelled = new Promise(resolve => {
        abort = () => resolve(false)
        signal?.addEventListener('abort', abort, { once: true })
      })
      try { return await Promise.race([exited.promise, cancelled]) }
      finally { signal?.removeEventListener('abort', abort) }
    },
  }
  return {
    state, stdout, stderr, stdin, handle, done, finish, confirmExit, terminated: terminated.promise,
    spawn(spec) {
      state.specs.push(spec)
      if (onStart) queueMicrotask(() => onStart({ stdout, stderr, finish, done, stdin }))
      return handle
    },
  }
}
async function run(fixture, extra = {}) {
  return runClaudeProcess({ config, cwd: 'G:/fixture', prompt: 'private user prompt',
    ...context, env: { PATH: 'G:/safe/bin', DSH_WORKER_TOKEN: 'private-env-secret' },
    spawn: fixture.spawn, ...extra })
}

test('invalid runtime limits or missing safe env refuse spawning with a fixed diagnostic', async () => {
  for (const extra of [
    { config: { ...config, timeoutMs: 2147483648 } },
    { config: { ...config, timeoutMs: 0 } },
    { config: { ...config, maxOutputBytes: 0 } },
    { config: { ...config, disposeGraceMs: -1 } },
    { config: { ...config, disposeGraceMs: 2147483648 } },
    { config: { ...config, executablePath: '' } },
    { cwd: '' }, { prompt: '' }, { env: undefined },
  ]) {
    const fixture = processFixture({ onStart({ stdout, finish }) { stdout.write(line(success())); finish() } })
    const result = await run(fixture, extra)
    assert.equal(result.stopReason, 'error')
    assert.equal(result.diagnostic, 'CLI_CONFIG_INVALID')
    assert.equal(fixture.state.specs.length, 0)
  }
})

test('zero termination grace is valid and safe env is forwarded without copying or mutation', async () => {
  const fixture = processFixture({ onStart({ stdout, finish }) { stdout.write(line(success())); finish() } })
  const env = Object.freeze({ DSH_CC_WORKER_TOKEN: 'private-frozen-env-secret' })
  const result = await run(fixture, { config: { ...config, disposeGraceMs: 0 }, env })
  assert.equal(result.stopReason, 'completed')
  assert.equal(fixture.state.specs[0].env, env)
})

test('success joins real streams, writes prompt through stdin and uses exact Host spawn spec', async () => {
  const fixture = processFixture({ onStart({ stdout, finish }) {
    const bytes = Buffer.from(line({ type: 'system', subtype: 'init' }) + line(success()))
    const split = bytes.indexOf(Buffer.from('成')) + 1
    stdout.write(bytes.subarray(0, split)); stdout.write(bytes.subarray(split)); finish()
  } })
  const result = await run(fixture)
  assert.deepEqual(result, { output: [{ type: 'text', text: '完成 ✓' }], stopReason: 'completed' })
  const [spec] = fixture.state.specs
  assert.equal(spec.argv[0], 'G:/fixture/claude.exe')
  assert.equal(spec.cwd, 'G:/fixture')
  assert.deepEqual(spec.stdio, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  assert.equal(spec.graceMs, 100)
  assert.equal(spec.env.DSH_WORKER_TOKEN, 'private-env-secret')
  assert.ok(!JSON.stringify(spec.argv).includes('private-env-secret'))
  assert.ok(!JSON.stringify(spec.argv).includes('private user prompt'))
  assert.equal(fixture.state.input, 'private user prompt')
  assert.ok(fixture.stdin.writableEnded)
  assert.ok(fixture.state.actions.includes('waitForExit'))
  assert.ok(fixture.state.exitConfirmed)
})

test('a successful result cannot pass after nonzero or signal-only process exit', async () => {
  for (const [exitCode, signal] of [[7, null], [null, 'SIGTERM'], [0, 'SIGTERM']]) {
    const fixture = processFixture({ onStart({ stdout, finish }) { stdout.write(line(success())); finish(exitCode, signal) } })
    const result = await run(fixture)
    assert.equal(result.stopReason, 'error')
    assert.equal(result.diagnostic, 'CLI_EXIT_FAILED')
    assert.deepEqual(result.output, [])
  }
})

test('error, missing, blank and unverified result payloads cannot pass on exit zero', async () => {
  for (const event of [
    success({ subtype: 'error_during_execution', result: 'sensitive-error-text' }),
    success({ is_error: true }), success({ is_error: undefined }),
    success({ result: '' }), success({ result: ' \n\t ' }), success({ result: 8 }),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'not a terminal result' }] } },
  ]) {
    const fixture = processFixture({ onStart({ stdout, finish }) { stdout.write(line(event)); finish() } })
    const result = await run(fixture)
    assert.equal(result.stopReason, 'error')
    assert.equal(result.diagnostic, 'CLI_RESULT_INVALID')
    assert.deepEqual(result.output, [])
  }
})

test('records allowlisted tool metadata and numeric usage but never secrets or raw text', async () => {
  const records = []
  const fixture = processFixture({ onStart({ stdout, stderr, finish }) {
    stderr.write('private-stderr-secret')
    stdout.write(line({ type: 'assistant', message: { content: [
      { type: 'text', text: 'private-assistant-secret' },
      { type: 'tool_use', id: 'private-id-secret', name: 'Bash', input: { command: 'private-command-secret', description: 'private-description-secret' } },
      { type: 'tool_use', name: 'Write', input: { file_path: 'src/output.mjs', content: 'private-file-content-secret' } },
    ] } }))
    stdout.write(line({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'private-id-secret', is_error: true, content: 'private-tool-result-secret' },
    ] } }))
    stdout.write(line(success({ result: 'private-final-secret', total_cost_usd: 0.012,
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3, text: 'private-usage-secret' } })))
    finish()
  } })
  const result = await run(fixture, { systemPrompt: 'private-system-secret', record: event => records.push(event) })
  assert.equal(result.stopReason, 'completed')
  assert.ok(records.some(event => event.kind === 'cli-tool' && event.tool === 'Bash'))
  assert.ok(records.some(event => event.kind === 'cli-tool' && event.tool === 'Write' && event.file_path === 'src/output.mjs'))
  assert.deepEqual(records.find(event => event.kind === 'cli-tool-result'), { runId: 'run-fixture', role: 'leader', kind: 'cli-tool-result', error: true })
  const terminal = records.find(event => event.kind === 'cli-result')
  assert.deepEqual(terminal.usage, { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 })
  assert.equal(terminal.cost, 0.012)
  assert.equal(records.at(-1).stopReason, 'completed')
  assert.ok(records.every(event => event.runId === 'run-fixture' && event.role === 'leader'))
  assert.doesNotMatch(JSON.stringify(records), /private-|argv|stdin|stderr|command|prompt|content|description/)
})

test('pre-aborted requests return aborted without spawning', async () => {
  const fixture = processFixture(), controller = new AbortController()
  controller.abort(new Error('private-abort-secret'))
  const result = await run(fixture, { signal: controller.signal })
  assert.equal(result.stopReason, 'aborted')
  assert.equal(result.diagnostic, 'CLI_ABORTED')
  assert.equal(fixture.state.specs.length, 0)
})

test('an abort raised by synchronous spawn never sends the private prompt to stdin', async () => {
  const fixture = processFixture(), controller = new AbortController()
  const result = await run(fixture, { signal: controller.signal, spawn(spec) {
    const handle = fixture.spawn(spec)
    controller.abort()
    return handle
  } })
  assert.equal(result.stopReason, 'aborted')
  assert.equal(fixture.state.input, '')
  assert.ok(fixture.state.exitConfirmed)
})

test('abort terminates once and does not settle until managed-range exit is confirmed', async () => {
  const fixture = processFixture({ autoTerminate: false, holdExit: true }), controller = new AbortController()
  let settled = false
  const pending = run(fixture, { signal: controller.signal }).then(result => { settled = true; return result })
  await nextTurn()
  controller.abort(new Error('private-abort-secret'))
  await fixture.terminated
  fixture.finish(0)
  await nextTurn()
  assert.equal(settled, false, 'done alone does not prove managed-range quiescence')
  fixture.confirmExit()
  const result = await pending
  assert.equal(result.stopReason, 'aborted')
  assert.equal(result.diagnostic, 'CLI_ABORTED')
  assert.deepEqual(result.output, [])
  assert.equal(fixture.state.actions.filter(action => action === 'terminate').length, 1)
})

test('timeout stops the process and awaits exit rather than reporting partial success', async () => {
  const fixture = processFixture({ autoTerminate: false })
  const pending = run(fixture, { config: { ...config, timeoutMs: 15 } })
  await fixture.terminated
  fixture.stdout.write(line(success()))
  fixture.finish()
  const result = await pending
  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'CLI_TIMEOUT')
  assert.deepEqual(result.output, [])
  assert.ok(fixture.state.exitConfirmed)
})

test('output overflow counts bytes from both streams and stops even an unterminated line', async () => {
  for (const chunks of [['中中中', ''], ['aaaa', 'bbbbb'], ['', 'x'.repeat(9)]]) {
    const fixture = processFixture({ onStart({ stdout, stderr }) { stdout.write(chunks[0]); stderr.write(chunks[1]) } })
    const result = await run(fixture, { config: { ...config, maxOutputBytes: 8 } })
    assert.equal(result.stopReason, 'error')
    assert.equal(result.diagnostic, 'CLI_OUTPUT_OVERFLOW')
    assert.deepEqual(result.output, [])
    assert.ok(fixture.state.actions.includes('terminate'))
    assert.ok(fixture.state.exitConfirmed)
  }
})

test('malformed JSON is a safe protocol failure and triggers cleanup', async () => {
  const fixture = processFixture({ onStart({ stdout }) { stdout.write('private-invalid-json-secret\n') } })
  const result = await run(fixture)
  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'CLI_PROTOCOL_ERROR')
  assert.deepEqual(result.output, [])
  assert.ok(fixture.state.actions.includes('terminate'))
})

test('final unterminated JSON line is parsed without needing a trailing newline', async () => {
  const fixture = processFixture({ onStart({ stdout, finish }) { stdout.write(JSON.stringify(success())); finish() } })
  assert.equal((await run(fixture)).stopReason, 'completed')
})

test('spawn and done failures never expose raw provider errors', async () => {
  const records = []
  const fixture = processFixture()
  const thrown = await run(fixture, { spawn() { throw new Error('private-spawn-secret') }, record: event => records.push(event) })
  assert.equal(thrown.stopReason, 'error')
  assert.equal(thrown.diagnostic, 'CLI_SPAWN_FAILED')
  const failed = processFixture({ onStart({ done }) { done.reject(new Error('private-provider-secret')) } })
  const result = await run(failed, { record: event => records.push(event) })
  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'CLI_PROCESS_FAILED')
  assert.ok(failed.state.actions.includes('terminate'))
  assert.doesNotMatch(JSON.stringify([thrown, result, records]), /private-/)
})

test('termination failure is not swallowed, and exit observation is still attempted', async () => {
  const fixture = processFixture({ terminateError: new Error('private-cleanup-secret') }), controller = new AbortController()
  const pending = run(fixture, { signal: controller.signal })
  await nextTurn(); controller.abort(); await fixture.terminated
  fixture.finish(1)
  const result = await pending
  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'CLI_CLEANUP_FAILED')
  assert.ok(fixture.state.actions.includes('waitForExit'))
  assert.doesNotMatch(JSON.stringify(result), /private-/)
})

test('false, rejected or overdue exit confirmation is an explicit cleanup failure', async () => {
  for (const options of [{ waitFalse: true }, { waitError: new Error('private-wait-secret') }, { holdExit: true }]) {
    const fixture = processFixture(options), controller = new AbortController()
    const pending = run(fixture, { signal: controller.signal, config: { ...config, disposeGraceMs: 20 } })
    await nextTurn(); controller.abort()
    const result = await pending
    assert.equal(result.stopReason, 'error')
    assert.equal(result.diagnostic, 'CLI_CLEANUP_FAILED')
    assert.deepEqual(result.output, [])
    assert.doesNotMatch(JSON.stringify(result), /private-/)
  }
})
