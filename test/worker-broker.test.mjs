import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerBroker } from '../lib/worker-broker.mjs'

// Only the paid external startActivation boundary is faked. Admission, routing,
// idempotency, reservations, cancellation and result ownership stay real.
function setup(extra = {}) {
  const starts = []
  const parent = { id: 'secretary-fixture' }
  const record = []
  const broker = createWorkerBroker({ runId: 'run-fixture', cwd: 'G:/fixture', parent,
    workerPreset: 'team-worker', record: event => record.push(event),
    start: async spec => {
      let finish
      const result = new Promise(resolve => { finish = resolve })
      const row = { spec, finish, disposed: 0 }
      starts.push(row)
      const activation = { childId: `child-${starts.length}`, result, dispose: async () => { row.disposed++; finish({ stopReason: 'aborted', output: [] }) } }
      spec.signal.addEventListener('abort', () => finish({ stopReason: 'aborted', output: [] }), { once: true })
      return activation
    }, ...extra })
  return { broker, starts, parent, record }
}
const task = (task_id = 'a', extra = {}) => ({ task_id, route: 'fast', prompt: 'Implement within the allocated file.', files: [`${task_id}.js`], ...extra })

test('dispatch retains trusted parent and fixed DS route, not CLI supplied identity', async () => {
  const { broker, starts, parent } = setup()
  const ticket = await broker.dispatch(task())
  assert.equal(ticket.id, 'a')
  assert.equal(starts[0].spec.request.parent, parent)
  assert.equal(starts[0].spec.delivery, 'caller')
  assert.equal(starts[0].spec.provider, 'spawn')
  assert.equal(starts[0].spec.request.agentOptions.model, 'deepseek-flash')
  assert.equal(starts[0].spec.request.agentPreset, 'team-worker')
  await assert.rejects(broker.dispatch({ ...task('b'), parent: 'forged' }), /UNKNOWN_FIELD/)
  await broker.close()
})
test('Claude frontend uses external CC worker, never native Claude spawn', async () => {
  const { broker, starts } = setup()
  await broker.dispatch(task('ui', { route: 'frontend' }))
  assert.equal(starts[0].spec.provider, 'secretary-cc-worker')
  assert.equal(starts[0].spec.request.agentOptions, undefined)
  assert.equal(starts[0].spec.request.agentPreset, undefined)
  await broker.close()
})
test('identical dispatch is idempotent; changed intent with same key is rejected', async () => {
  const { broker, starts } = setup()
  const [a,b] = await Promise.all([broker.dispatch(task()), broker.dispatch(task())])
  assert.equal(a.id,b.id); assert.equal(starts.length,1)
  await assert.rejects(broker.dispatch(task('a', { prompt: 'different task' })), /IDEMPOTENCY_CONFLICT/)
  await broker.close()
})
test('slots are reserved before async start resolves', async () => {
  let release
  const { broker } = setup({ maxConcurrent: 1, start: () => new Promise(resolve => { release = resolve }) })
  const opening = broker.dispatch(task())
  await assert.rejects(broker.dispatch(task('b')), /CONCURRENCY_LIMIT/)
  release({ childId: 'late', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} })
  await opening; await broker.close()
})
test('path traversal, unknown routes and direct provider selection are rejected', async () => {
  const { broker, starts } = setup()
  for (const files of [['../other'], ['G:/outside'], ['/outside'], ['a/../../b'], ['C:\\outside']]) {
    await assert.rejects(broker.dispatch(task('x', { files })), /INVALID_SCOPE/)
  }
  await assert.rejects(broker.dispatch(task('x', { route: 'claude-api' })), /UNKNOWN_ROUTE/)
  await assert.rejects(broker.dispatch({ ...task('x'), provider: 'xindupx' }), /UNKNOWN_FIELD/)
  assert.equal(starts.length,0); await broker.close()
})
test('overlapping live file scopes are refused, including case and directories', async () => {
  const { broker, starts } = setup()
  await broker.dispatch(task('a', { files: ['src'] }))
  await assert.rejects(broker.dispatch(task('b', { files: ['SRC/main.js'] })), /SCOPE_CONFLICT/)
  starts[0].finish({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
  await broker.wait({ id: 'a', timeout_ms: 1000 })
  await broker.dispatch(task('b', { files: ['src/main.js'] }))
  await broker.close()
})
test('completed result is available only through its own broker', async () => {
  const a = setup(); const b = setup()
  await a.broker.dispatch(task())
  a.starts[0].finish({ stopReason: 'completed', output: [{ type: 'text', text: 'tested output' }] })
  const result = await a.broker.wait({ id:'a', timeout_ms:1000 })
  assert.equal(result.state,'completed'); assert.match(result.output,/tested output/)
  assert.throws(() => b.broker.status({ id:'a' }), /UNKNOWN_WORKER/)
  await a.broker.close(); await b.broker.close()
})
test('worker failure is not rewritten as completed; total budget persists', async () => {
  const { broker, starts } = setup({ maxWorkers:1 })
  await broker.dispatch(task())
  starts[0].finish({ stopReason:'error', output:[{type:'text',text:'failed'}] })
  assert.equal((await broker.wait({id:'a',timeout_ms:1000})).state,'error')
  await assert.rejects(broker.dispatch(task('b')),/TOTAL_LIMIT/)
  await broker.close()
})
test('close cancels owned children and rejects any further admission', async () => {
  const { broker, starts } = setup()
  await broker.dispatch(task())
  await broker.close(); await broker.close()
  assert.equal(starts[0].disposed,1)
  assert.equal(broker.status({id:'a'}).state,'aborted')
  await assert.rejects(broker.dispatch(task('b')),/RUN_CLOSED/)
})
test('cleanup failures are terminal errors and are not swallowed by close', async () => {
  const { broker } = setup({ start: async () => ({childId:'bad-cleanup', result:Promise.resolve({stopReason:'completed',output:[]}), dispose:async()=>{throw new Error('fixture cleanup failure')} }) })
  await broker.dispatch(task())
  const done=await broker.wait({id:'a',timeout_ms:1000})
  assert.equal(done.state,'error')
  assert.equal(done.reason,'CLEANUP_FAILED')
  await assert.rejects(broker.dispatch(task('replacement')),/RUN_CLOSED/)
  await assert.rejects(broker.close(),/CLEANUP_FAILED/)
})

test('abort during startup still cleans late activation', async () => {
  let release; let disposed = 0
  const { broker } = setup({ start: () => new Promise(resolve => { release=resolve }) })
  const pending = broker.dispatch(task())
  const closing = broker.close()
  release({ childId:'late', result:Promise.resolve({stopReason:'aborted',output:[]}), dispose:async()=>{disposed++} })
  await pending; await closing
  assert.equal(disposed,1)
})
