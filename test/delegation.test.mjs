// Preset-switch lifecycle of preset/delegation.mjs: a Session created on the
// default preset, switched to a secretary preset, then a leader preset, then a
// worker preset, with the delegation tool surface asserted at each step.
//
// Usage: node test/delegation.test.mjs
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { TOOL_SUBAGENT_ENTRY, bootDelegation, createReporter, guardRealLog, makeAgent, settle, stageDelegation } from './helpers.mjs'

const LEADER_TOOLS = ['delegate_leader', 'delegate_leader_astra', 'delegate_leader_deepseek']
const WORKER_TOOLS = ['delegate_worker_fast', 'delegate_worker_stable', 'delegate_worker_writing', 'delegate_worker_backend', 'delegate_worker_frontend', 'delegate_worker_verify', 'delegate_worker_research', 'delegate_worker_plan']

const { check, sameSet, finish } = createReporter('delegation: preset switch lifecycle')
const verifyRealLog = guardRealLog(check)
const stage = stageDelegation('dsh-secretary-delegation-')

try {
  const agents = []
  const handlers = bootDelegation(await stage.load(), agents)
  const onCreated = handlers.get('agent/created')
  const onToolsChange = handlers.get('tools/change')
  check('agent/created listener registered', typeof onCreated === 'function')
  check('tools/change listener registered', typeof onToolsChange === 'function')

  const track = (id, preset) => {
    const a = makeAgent(id, preset)
    agents.push(a.agent)
    return a
  }

  // 1. Session created on the default preset: nothing mounted.
  const s = track('offline-session', 'standard')
  await onCreated({ agent: s.agent })
  await settle()
  sameSet('created on standard: no mounts', s.live(), [])

  // 2. GUI preset switch before the first turn: recompose emits tools/change.
  s.agent.ctx.preset = 'secretary-standard'
  onToolsChange()
  await settle()
  sameSet('switch to secretary-standard: leader tools mounted', s.live(), LEADER_TOOLS)

  // 3. A second tools/change (any unrelated tool registration) must not double-mount.
  const before = s.mounted.length
  onToolsChange()
  await settle()
  check('repeat tools/change: no extra mounts', s.mounted.length === before, `${s.mounted.length - before} extra`)

  // 4. Switch to a leader preset: leader tools disposed, worker tools mounted.
  s.agent.ctx.preset = 'team-leader'
  onToolsChange()
  await settle()
  sameSet('switch to team-leader: worker tools live', s.live(), WORKER_TOOLS)
  sameSet('switch to team-leader: leader tools disposed', s.disposed, LEADER_TOOLS)

  // 5. Switch to a worker preset: no delegation tools at all.
  s.agent.ctx.preset = 'team-worker'
  onToolsChange()
  await settle()
  sameSet('switch to team-worker: no live mounts', s.live(), [])

  // 6. A leader created directly still gets its workers on creation.
  const leader = track('offline-leader', 'team-leader')
  await onCreated({ agent: leader.agent })
  await settle()
  sameSet('created on team-leader: worker tools mounted', leader.live(), WORKER_TOOLS)

  // 7. Legacy accept-path presets stay untouched.
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    const a = track(`offline-${preset}`, preset)
    await onCreated({ agent: a.agent })
    await settle()
    sameSet(`created on ${preset}: no mounts`, a.live(), [])
  }

  // 8. v1.7.3: a reconcile that lands after the Agent context unloaded is normal
  // teardown. The live run logged ten "mount ... failed ... cannot create effect
  // on inactive context" lines when the Opus leader finished.
  const dead = makeAgent('offline-dead-leader', 'team-leader')
  dead.agent.ctx.plugin = async () => { throw new Error('cannot create effect on inactive context') }
  agents.push(dead.agent)
  await onCreated({ agent: dead.agent })
  await settle()
  sameSet('inactive leader: nothing left mounted', dead.live(), [])
  const logAfterDead = readFileSync(stage.testLog, 'utf8')
  check('inactive leader: no mount failure line', !/mount \w+ failed for offline-dead-leader/.test(logAfterDead))
  check('inactive leader: logged as inactive', /agent offline-dead-leader preset=team-leader inactive/.test(logAfterDead))

  // Routes as recorded in the (redirected) delegation log.
  const logText = readFileSync(stage.testLog, 'utf8')
  check('redirected log received the activation line', logText.includes('delegation plugin active (bundle'))
  const routes = new Map()
  for (const m of logText.matchAll(/(delegate_\w+)\(([^/]+)\/([^)]+)\)/g)) routes.set(m[1], `${m[2]}/${m[3]}`)
  console.log('  routes: ' + [...routes].map(([k, v]) => `${k}=${v}`).join(' '))
  for (const [tool, expected] of [['delegate_leader','secretary-cc-leader/claude-code'], ['delegate_worker_frontend','secretary-cc-worker/claude-code']]) {
    check(`${tool} routes to a real Claude Code backend`, routes.get(tool) === expected, `got ${routes.get(tool)}`)
  }
  check('no banology Claude route configured', ![...routes.values()].some((r) => r.startsWith('banology/claude')))

  // Optional: validate every config actually mounted against the real schema.
  const configs = [s, leader].flatMap((a) => a.mounted.map((f) => f.config))
  let Config
  try {
    Config = (await import(pathToFileURL(TOOL_SUBAGENT_ENTRY).href)).Config
  } catch (error) {
    console.log(`SKIP tool-subagent Config schema check (cannot import ${TOOL_SUBAGENT_ENTRY}: ${String(error?.code ?? error?.message ?? error).slice(0, 80)})`)
  }
  if (typeof Config === 'function') {
    for (const config of configs) {
      let problem
      try {
        Config(config)
      } catch (error) {
        problem = String(error?.message ?? error).slice(0, 160)
      }
      check(`tool-subagent Config accepts ${config.toolName} mount config`, problem === undefined, problem)
    }
    let rejected = false
    try {
      Config({ ...configs[0], maxDepth: 'not-a-number' })
    } catch {
      rejected = true
    }
    check('tool-subagent Config rejects a malformed config (control)', rejected)
  } else if (Config !== undefined) {
    check('tool-subagent exports a Config function', false, `got ${typeof Config}`)
  }
} catch (error) {
  check('test ran without throwing', false, String(error?.stack ?? error))
} finally {
  verifyRealLog()
  stage.cleanup()
}
finish()
