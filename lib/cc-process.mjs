// Independent Claude CLI adapter. The caller owns executable verification,
// sandbox admission and safe environment construction; this module never does
// PATH lookup, shell execution, installation or model/API calls of its own.
import { StringDecoder } from 'node:string_decoder'
import { finished } from 'node:stream/promises'

const NATIVE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
const MEMBER_TOOLS = ['dispatch_worker', 'wait_worker', 'worker_status', 'cancel_worker']
  .map(name => `mcp__dsh_workers__${name}`)

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
function validateMcpConfig(config) {
  const invalid = () => { throw new Error('INVALID_MCP_CONFIG') }
  if (!object(config) || Object.keys(config).some(key => key !== 'mcpServers') || !object(config.mcpServers)) invalid()
  if (Object.keys(config.mcpServers).some(key => key !== 'dsh_workers')) invalid()
  for (const server of Object.values(config.mcpServers)) {
    if (!object(server) || Object.keys(server).some(key => !['type', 'command', 'args', 'env'].includes(key))) invalid()
    if (server.type !== undefined && server.type !== 'stdio') invalid()
    if (!nonempty(server.command) || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')))) invalid()
    // Claude expands these references from the supplied process env. Inline env
    // values would put the run capability/credential into --mcp-config argv.
    if (server.env !== undefined && (!object(server.env) || Object.values(server.env).some(value =>
      typeof value !== 'string' || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)))) invalid()
  }
  return config
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isSessionId = value => typeof value === 'string' && UUID.test(value)

/**
 * Build CLI arguments only (not the executable or user prompt). runId is metadata.
 * v2.6: `session` ({ id, resume }) is leader-only. Without it the run is
 * ephemeral (--no-session-persistence); with it the Claude session is persisted
 * under `id` (--session-id) or continued (--resume), so the secretary can keep
 * talking to the same leader after a turn ends.
 */
export function buildClaudeArgs(config, { role, mcpConfig, systemPrompt, runId, session }) {
  if (!['leader', 'worker', 'review'].includes(role)) throw new Error('INVALID_ROLE')
  if (!Number.isFinite(config?.maxBudgetUsd) || config.maxBudgetUsd <= 0 ||
    typeof config.model !== 'string' || !/^[^-\s\x00-\x1f][^\s\x00-\x1f]*$/.test(config.model)) throw new Error('INVALID_CONFIG')
  if (session !== undefined && (role !== 'leader' || !object(session) || !isSessionId(session.id) || typeof session.resume !== 'boolean')) throw new Error('INVALID_SESSION')
  const review = role === 'review'
  if (review && !/^claude-opus-/.test(config.model)) throw new Error('REVIEW_OPUS_REQUIRED')
  const tools = review ? ['Read', 'Glob', 'Grep'] : NATIVE_TOOLS
  const servers = role !== 'leader' ? { mcpServers: {} } : validateMcpConfig(mcpConfig)
  const persistence = session === undefined ? ['--no-session-persistence']
    : session.resume ? ['--resume', session.id] : ['--session-id', session.id]
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', ...persistence,
    '--permission-mode', review ? 'default' : 'acceptEdits', '--model', config.model,
    '--strict-mcp-config', '--mcp-config', JSON.stringify(servers),
    '--tools', tools.join(','),
    '--allowedTools', [...tools, ...(role === 'leader' ? MEMBER_TOOLS : [])].join(','),
    '--disallowedTools', review ? 'Bash,Edit,Write,Agent,Task,AskUserQuestion' : 'Agent,Task,AskUserQuestion',
    '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true }),
    '--max-budget-usd', String(config.maxBudgetUsd),
  ]
  if (systemPrompt) args.push('--system-prompt', systemPrompt)
  return args
}

const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
function resultMetadata(event) {
  const usage = {}
  for (const key of USAGE_FIELDS) {
    const value = event.usage?.[key]
    if (Number.isFinite(value) && value >= 0) usage[key] = value
  }
  return {
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0 ? { cost: event.total_cost_usd } : {}),
  }
}

/**
 * @param {object} options
 * @param {Function} options.spawn Bound ctx.subprocess.spawn(spec), NOT node spawn.
 * @param {string} options.prompt Written only to stdin, never to argv or records.
 * @param {object} options.env Already scrubbed by the Host wrapper; forwarded verbatim.
 * @returns {Promise<{output: Array<{type: 'text', text: string}>, stopReason: 'completed'|'aborted'|'error', diagnostic?: string}>}
 * Failure diagnostics are fixed codes, never exception messages or stderr.
 */
export async function runClaudeProcess({ config, cwd, prompt, role, mcpConfig, systemPrompt, runId, session, env, signal, spawn, record = () => {} }) {
  const emit = event => {
    try { Promise.resolve(record({ runId, role, ...event })).catch(() => {}) }
    catch { /* Optional metadata sink cannot change process ownership. */ }
  }
  const result = (diagnostic, text, sessionId) => {
    const stopReason = diagnostic ? diagnostic === 'CLI_ABORTED' ? 'aborted' : 'error' : 'completed'
    emit({ kind: 'cli-end', stopReason })
    return { output: diagnostic ? [] : [{ type: 'text', text }], stopReason, ...(diagnostic ? { diagnostic } : {}),
      ...(!diagnostic && isSessionId(sessionId) ? { sessionId } : {}) }
  }
  if (signal?.aborted) return result('CLI_ABORTED')
  let args
  try {
    args = buildClaudeArgs(config, { role, mcpConfig, systemPrompt, runId, session })
    for (const [key, minimum] of [['timeoutMs', 1], ['disposeGraceMs', 0]]) {
      if (!Number.isInteger(config[key]) || config[key] < minimum || config[key] > 2147483647) throw new Error('INVALID_CONFIG')
    }
    if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1 ||
      !nonempty(config.executablePath) || !nonempty(cwd) || !nonempty(prompt) || typeof spawn !== 'function' ||
      !object(env) || Object.values(env).some(value => typeof value !== 'string')) throw new Error('INVALID_CONFIG')
  } catch { return result('CLI_CONFIG_INVALID') }

  let handle
  try {
    // Own cancellation here, rather than also passing the caller's signal to the
    // provider: exactly one terminate request, followed by awaited quiescence.
    handle = spawn({ argv: [config.executablePath, ...args], cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: config.disposeGraceMs, env })
  } catch { return result('CLI_SPAWN_FAILED') }
  emit({ kind: 'cli-start' })

  let diagnostic, notifyStop, bytes = 0, terminal, exit
  const stopped = new Promise(resolve => { notifyStop = resolve })
  const naturalWait = new AbortController()
  function stop(code) {
    if (diagnostic) return
    diagnostic = code
    naturalWait.abort()
    notifyStop()
  }
  const onAbort = () => stop('CLI_ABORTED')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => stop('CLI_TIMEOUT'), config.timeoutMs)

  function parseLine(text) {
    if (diagnostic || !text.trim()) return
    let event
    try { event = JSON.parse(text) }
    catch { stop('CLI_PROTOCOL_ERROR'); return }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { stop('CLI_PROTOCOL_ERROR'); return }
    if (event.type === 'assistant' || event.type === 'user') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (event.type === 'assistant' && block?.type === 'tool_use') {
          const tool = [...NATIVE_TOOLS, ...MEMBER_TOOLS].includes(block.name) ? block.name : 'unknown'
          const path = block.input?.file_path
          emit({ kind: 'cli-tool', tool,
            ...(typeof path === 'string' && path.length <= 4096 && !/[\x00-\x1f]/.test(path) ? { file_path: path } : {}) })
        } else if (block?.type === 'tool_result') {
          emit({ kind: 'cli-tool-result', error: block.is_error === true })
        }
      }
    } else if (event.type === 'result') {
      if (terminal) { stop('CLI_PROTOCOL_ERROR'); return }
      terminal = { subtype: event.subtype, error: event.is_error, text: event.result,
        ...(isSessionId(event.session_id) ? { sessionId: event.session_id } : {}) }
      emit({ kind: 'cli-result', ...resultMetadata(event) })
    }
  }
  async function consume(stream, json) {
    const decoder = json ? new StringDecoder('utf8') : undefined
    let pending = ''
    try {
      for await (const chunk of stream) {
        if (diagnostic) continue
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        bytes += data.byteLength
        if (bytes > config.maxOutputBytes) { stop('CLI_OUTPUT_OVERFLOW'); continue }
        if (!json) continue // stderr is counted and discarded; never decoded or retained.
        pending += decoder.write(data)
        let newline
        while (!diagnostic && (newline = pending.indexOf('\n')) !== -1) {
          parseLine(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
        }
        if (diagnostic) pending = ''
      }
      if (json && !diagnostic) parseLine(pending + decoder.end())
    } catch { stop('CLI_STREAM_FAILED') }
  }
  // Attach all rejection handlers before yielding or writing prompt bytes.
  const done = Promise.resolve(handle.done).then(outcome => { exit = outcome }, () => stop('CLI_PROCESS_FAILED'))
  const stdout = consume(handle.stdout, true), stderr = consume(handle.stderr, false)
  let stdin
  try {
    stdin = finished(handle.stdin, { cleanup: true }).catch(() => stop('CLI_STDIN_FAILED'))
    handle.stdin.end(diagnostic ? undefined : prompt)
  } catch { stop('CLI_STDIN_FAILED'); stdin ??= Promise.resolve() }
  const io = Promise.all([done, stdout, stderr, stdin])
  const complete = io.then(async () => {
    if (diagnostic) return
    try {
      if (await handle.waitForExit(naturalWait.signal) !== true) stop('CLI_CLEANUP_FAILED')
    } catch { stop('CLI_CLEANUP_FAILED') }
  })
  try {
    await Promise.race([complete, stopped])
    if (diagnostic) {
      // Never reuse the aborted caller signal for teardown. Provider termination
      // failure still requires an exit-observation attempt, and is never PASS.
      let cleanupFailed = false, cleanupTimer
      const cleanup = new AbortController()
      const expired = new Promise(resolve => {
        cleanupTimer = setTimeout(() => { cleanup.abort(); resolve(false) }, config.disposeGraceMs)
      })
      try {
        try { handle.terminate() } catch { cleanupFailed = true }
        const quiescent = Promise.resolve().then(() => handle.waitForExit(cleanup.signal)).then(ok => ok === true, () => false)
        if (!await Promise.race([quiescent, expired])) cleanupFailed = true
        for (const stream of [handle.stdin, handle.stdout, handle.stderr]) {
          try { stream.destroy() } catch { cleanupFailed = true }
        }
        if (!await Promise.race([io.then(() => true), expired])) cleanupFailed = true
      } finally { clearTimeout(cleanupTimer); cleanup.abort() }
      return result(cleanupFailed ? 'CLI_CLEANUP_FAILED' : diagnostic)
    }
    if (exit?.exitCode !== 0 || exit.signal != null) return result('CLI_EXIT_FAILED')
    if (terminal?.subtype !== 'success' || terminal.error !== false || typeof terminal.text !== 'string' || !terminal.text.trim()) {
      return result('CLI_RESULT_INVALID')
    }
    return result(undefined, terminal.text, terminal.sessionId)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    naturalWait.abort()
  }
}
