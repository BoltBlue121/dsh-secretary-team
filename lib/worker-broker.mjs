// Pure run-owned worker admission. The injected start is the only DSH side effect.
// File scopes are coordination constraints, NOT an OS/filesystem security sandbox.
// v2.5: the same roster as the native team-leader (preset/delegation.mjs
// workerTools): five implementers on the run's worker preset, plus the three
// read-only roles on their own presets. A read-only route never takes the
// implementer preset, so the verifier keeps its read-only composition.
const ROUTES = Object.freeze({
  fast: { provider: 'spawn', agentOptions: { provider:'deepseek-account', model:'deepseek-flash', reasoningEffort:'low' } },
  stable: { provider: 'spawn', agentOptions: { provider:'banology-gemini', model:'gpt-6.1-sol' } },
  backend: { provider: 'spawn', agentOptions: { provider:'banology-gemini', model:'gpt-6-astra' } },
  writing: { provider: 'spawn', agentOptions: { provider:'banology-gemini', model:'gemini-4-argon' } },
  frontend: { provider: 'secretary-cc-worker' },
  review: { provider: 'secretary-cc-review', readOnly: true },
  // Banology Sol acceptance keeps its independent read-only role preset.
  verify: { provider: 'spawn', agentPreset: 'team-verifier', readOnly: true, agentOptions: { provider:'banology-gemini', model:'gpt-6.1-sol' } },
  research: { provider: 'spawn', agentPreset: 'team-researcher', readOnly: true, agentOptions: { provider:'banology-gemini', model:'gemini-4-argon' } },
  plan: { provider: 'spawn', agentPreset: 'team-planner', readOnly: true, agentOptions: { provider:'banology-gemini', model:'gpt-6-astra' } },
})
export const ROUTE_NAMES = Object.freeze(Object.keys(ROUTES))
/** Fixed member preset per route for a run whose implementers use `workerPreset`. */
export function routePreset(route, workerPreset) {
  const entry = ROUTES[route]
  if (!entry || entry.provider !== 'spawn') return undefined
  return entry.agentPreset ?? workerPreset
}
const fail = code => { throw new Error(code) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const running = row => row.state === 'starting' || row.state === 'running' || row.state === 'finishing'
const keyFor = s => s.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase()
function keys(args, allowed) {
  if (!plain(args)) fail('INVALID_ARGUMENTS')
  if (Object.keys(args).some(k => !allowed.includes(k))) fail('UNKNOWN_FIELD')
}
function normalizeTask(args) {
  keys(args,['task_id','route','prompt','files'])
  if (typeof args.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(args.task_id)) fail('INVALID_TASK_ID')
  if (!Object.hasOwn(ROUTES,args.route)) fail('UNKNOWN_ROUTE')
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32000) fail('INVALID_PROMPT')
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 16) fail('INVALID_SCOPE')
  const files = args.files.map(file => {
    if (typeof file !== 'string' || !file || file.length > 240 || /[:*?\x00-\x1f]/.test(file)) fail('INVALID_SCOPE')
    const value = file.replaceAll('\\','/').replace(/\/+$/,'')
    if (!value || value.startsWith('/') || value.split('/').some(p => !p || p === '..' || p === '.')) fail('INVALID_SCOPE')
    return value
  })
  return { task_id:args.task_id, route:args.route, prompt:args.prompt, files:[...new Set(files)].sort() }
}
const overlap = (a,b) => a === b || a.startsWith(b+'/') || b.startsWith(a+'/')

export function createWorkerBroker({ runId, cwd, parent, workerPreset, start, record = () => {}, maxConcurrent = 4, maxWorkers = 12, signal }) {
  if (!parent || typeof parent.id !== 'string' || typeof start !== 'function') fail('INVALID_OWNER')
  if (!['team-worker','team-worker-cordis'].includes(workerPreset)) fail('INVALID_WORKER_PRESET')
  for (const v of [maxConcurrent,maxWorkers]) if (!Number.isSafeInteger(v) || v < 1 || v > 64) fail('INVALID_LIMIT')
  // Freeze this run's native member selection. The external Claude role, parent,
  // worker preset, scope, limits and lifecycle remain owned by this broker.
  const memberRoutes = parent.ctx?.get?.('workbenchMemberRoutes')
  const routes = !memberRoutes ? ROUTES : Object.fromEntries(Object.entries(ROUTES).map(([role,route]) =>
    [role, route.provider !== 'spawn' ? route : { ...route,
      agentOptions:memberRoutes.resolveMember(role,routePreset(role,workerPreset),route.agentOptions) }]))
  const rows = new Map()
  let closed = false
  let closing
  const emit = event => { try { record({ runId, ownerId:parent.id, ...event }) } catch { /* diagnostics only */ } }
  function snapshot(row) {
    return { id:row.task.task_id, childId:row.activation?.childId ?? null, route:row.task.route,
      state:row.state, files:row.task.files, ...(row.output === undefined ? {} : {output:row.output}),
      ...(row.reason ? {reason:row.reason} : {}) }
  }
  function find(args, withTimeout = false) {
    keys(args, withTimeout ? ['id','timeout_ms'] : ['id'])
    const row = rows.get(args.id)
    if (!row) fail('UNKNOWN_WORKER')
    return row
  }
  function release(row) {
    if (!row.activation) return Promise.resolve()
    row.release ??= Promise.resolve().then(() => row.activation.dispose()).catch(() => {
      closed = true // Quiescence is unknown: never reuse the file scope or slot.
      row.cleanupFailed = true; row.state = 'error'; row.reason = 'CLEANUP_FAILED'; row.output = ''
      emit({kind:'worker-cleanup-error',taskId:row.task.task_id})
    })
    return row.release
  }
  async function dispatch(args) {
    if (closed || signal?.aborted) fail('RUN_CLOSED')
    const task = normalizeTask(args)
    const fingerprint = JSON.stringify(task)
    const previous = rows.get(task.task_id)
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT')
      await previous.opening
      return snapshot(previous)
    }
    if (rows.size >= maxWorkers) fail('TOTAL_LIMIT')
    const live = [...rows.values()].filter(running)
    if (live.length >= maxConcurrent) fail('CONCURRENCY_LIMIT')
    if (live.some(row => row.task.files.some(a => task.files.some(b => overlap(keyFor(a),keyFor(b)))))) fail('SCOPE_CONFLICT')
    const row = { task, fingerprint, state:'starting', controller:new AbortController() }
    rows.set(task.task_id,row) // Reserve slot, key and file scopes before the first await.
    const route = routes[task.route]
    const prompt = (route.readOnly ? [
      `你是工程领导派出的只读成员（${task.route}），没参与实现；只完成下面任务，不转派、不开新团队、不改全局配置。`,
      `工作目录：${cwd}。本任务的核查/调研范围（相对文件/目录）：${task.files.join(', ')}。任何文件都不得修改，写文件的工具与 shell 写入已被机械拒绝。`,
      task.route === 'review'
        ? '仅用 Read/Glob/Grep 独立审查设计、风险、物理数值合理性，只给意见不实现、不跑命令，不代替 verify 验收。报告路径:行号、依据与未确认项，不输出凭据。'
        : '自己读代码、自己跑只读命令取证，不采信实现者自述。不要输出凭据。完成后报告结论、逐条证据（命令原文与输出摘要 / 路径:行号）、发现的问题与未确认项。',
      task.prompt,
    ] : [
      '你是工程领导派出的执行成员，只完成下面任务；不转派、不开新团队、不改全局配置。',
      `工作目录：${cwd}。本任务允许修改的相对文件/目录：${task.files.join(', ')}。其他文件只能读取。`,
      '先读现状再改；文件范围是协作约定不是OS沙箱。不要输出凭据。完成后报告文件、实际测试命令/结果、风险与未完成项。',
      task.prompt,
    ]).join('\n')
    row.opening = (async () => {
      try {
        row.activation = await start({ provider:route.provider, label:`CC worker ${task.route}: ${task.task_id}`, delivery:'caller', signal:row.controller.signal,
          request:{ parent, cwd, prompt:[{type:'text',text:prompt}], ...(route.provider === 'spawn' ? {agentPreset:routePreset(task.route,workerPreset), agentOptions:route.agentOptions, maxDepth:2} : {}) } })
        row.state = 'running'
        emit({kind:'worker-start',taskId:task.task_id,childId:row.activation.childId,route:task.route,provider:route.provider,
          ...(route.provider==='spawn'&&route.agentOptions!==ROUTES[task.route].agentOptions ? {selectedProvider:route.agentOptions.provider,selectedModel:route.agentOptions.model} : {})})
        row.settled = Promise.resolve(row.activation.result).then(result => {
          row.terminalState = row.controller.signal.aborted ? 'aborted' : result.stopReason === 'completed' ? 'completed' : result.stopReason === 'aborted' ? 'aborted' : 'error'
          row.state = 'finishing'
          row.output = (result.output ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0,24000)
          row.reason = result.stopReason
        }, () => { row.terminalState='error'; row.state='finishing'; row.reason='WORKER_FAILED' }).then(async () => {
          await release(row)
          if (!row.cleanupFailed) row.state = row.terminalState
          emit({kind:'worker-end',taskId:task.task_id,childId:row.activation.childId,state:row.state})
        })
        if (closed || row.controller.signal.aborted) { row.controller.abort(); await release(row); await row.settled }
      } catch {
        row.state = row.controller.signal.aborted ? 'aborted' : 'error'
        row.reason = 'START_FAILED'
        emit({kind:'worker-start-error',taskId:task.task_id})
      }
    })()
    await row.opening
    return snapshot(row)
  }
  const status = args => snapshot(find(args))
  async function wait(args) {
    const row = find(args,true)
    const timeout = args.timeout_ms ?? 1000
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 25000) fail('INVALID_TIMEOUT')
    let timer
    try {
      await Promise.race([(async () => { await row.opening; await row.settled })(), new Promise(resolve => { timer=setTimeout(resolve,timeout) })])
    } finally { clearTimeout(timer) }
    return snapshot(row)
  }
  async function cancel(args) {
    const row = find(args)
    row.controller.abort()
    await row.opening; await release(row); await row.settled
    return snapshot(row)
  }
  function close() {
    if (closing) return closing
    closed = true
    signal?.removeEventListener('abort',onAbort)
    for (const row of rows.values()) if (running(row)) row.controller.abort()
    closing = Promise.all([...rows.values()].map(async row => { await row.opening; await release(row); await row.settled })).then(() => {
      if ([...rows.values()].some(row => row.cleanupFailed)) fail('CLEANUP_FAILED')
    })
    return closing
  }
  function onAbort() { void close().catch(() => {}) }
  signal?.addEventListener('abort',onAbort,{once:true})
  if (signal?.aborted) onAbort()
  return { dispatch, status, wait, cancel, close }
}
