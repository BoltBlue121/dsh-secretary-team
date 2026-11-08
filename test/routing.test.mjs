// v1.6 routing and failure handling of preset/delegation.mjs: the per-preset
// SURFACES table, the cordis remount, a mount that rejects, a preset change that
// lands while a reconcile is in flight, and a module load that fails once.
//
// Usage: node test/routing.test.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootDelegation, createReporter, guardRealLog, makeAgent, settle, stageDelegation } from './helpers.mjs'

const LEADER_TOOLS = ['delegate_leader', 'delegate_leader_astra', 'delegate_leader_deepseek']
const WORKER_TOOLS = ['delegate_worker_fast', 'delegate_worker_stable', 'delegate_worker_writing', 'delegate_worker_backend', 'delegate_worker_frontend', 'delegate_worker_verify', 'delegate_worker_research', 'delegate_worker_plan']
// Role tools always carry their own roster preset, not the leader's implementer preset.
const VERIFY_TOOL = 'delegate_worker_verify'
const ROLE_PRESETS = {
  [VERIFY_TOOL]: 'team-verifier',
  delegate_worker_research: 'team-researcher',
  delegate_worker_plan: 'team-planner',
}
// Expected surface per preset, kept independent of the module's SURFACES map.
const EXPECTED = {
  'secretary-standard': { tools: LEADER_TOOLS, agentPreset: 'team-leader' },
  'secretary-cordis': { tools: LEADER_TOOLS, agentPreset: 'team-leader-cordis' },
  'team-leader': { tools: WORKER_TOOLS, agentPreset: 'team-worker' },
  'team-leader-cordis': { tools: WORKER_TOOLS, agentPreset: 'team-worker-cordis' },
}
const presetFor = (tool, want) => ROLE_PRESETS[tool] ?? want.agentPreset
const NO_SURFACE = ['team-worker', 'team-worker-cordis', 'team-verifier', 'team-researcher', 'team-planner', 'standard', 'minimal', 'ptc', 'cordis', 'ai-draw']
const SURFACE = Symbol.for('@local/dsh-secretary-team/surface')

const { check, sameSet, finish } = createReporter('delegation: v1.6 routing and failure handling')
const verifyRealLog = guardRealLog(check)
const stage = stageDelegation('dsh-secretary-routing-')
const noResolveDir = mkdtempSync(join(tmpdir(), 'dsh-secretary-noresolve-'))

// Log lines for one Agent, from the redirected test log.
const logFor = (id) => readFileSync(stage.testLog, 'utf8').split('\n').filter((line) => line.includes(` ${id} `) || line.includes(`for ${id}:`))

try {
  const mod = await stage.load()
  const boot = () => {
    const agents = []
    const handlers = bootDelegation(mod, agents)
    const track = (id, preset) => {
      const a = makeAgent(id, preset)
      agents.push(a.agent)
      return a
    }
    return { created: handlers.get('agent/created'), change: handlers.get('tools/change'), track }
  }

  // 1. Every routed preset mounts exactly its documented surface.
  {
    const { created, track } = boot()
    for (const [preset, want] of Object.entries(EXPECTED)) {
      const a = track(`offline-route-${preset}`, preset)
      await created({ agent: a.agent })
      await settle()
      sameSet(`${preset}: mounts exactly ${want.tools.length} documented tools`, a.live(), want.tools)
      check(`${preset}: no duplicate mounts`, a.mounted.length === want.tools.length, `${a.mounted.length} mounts`)
      const configs = a.mounted.map((f) => f.config)
      check(`${preset}: native configs keep preset; CLI configs reject preset overrides`, configs.every(c => c.provider === 'spawn' ? c.agentPreset === presetFor(c.toolName, want) : c.agentPreset === undefined), configs.map(c => c.agentPreset).join(','))
      const leaderSurface = want.tools[0].startsWith('delegate_leader')
      check(
        `${preset}: every config allowedAgentPresets=[own preset${leaderSurface ? '' : ', stock DSH preset'}]`,
        configs.every(c => c.provider === 'spawn'
          ? JSON.stringify(c.allowedAgentPresets) === JSON.stringify(leaderSurface ? [presetFor(c.toolName, want)] : [presetFor(c.toolName, want), 'standard'])
          : c.allowedAgentPresets === undefined),
        configs.map((c) => JSON.stringify(c.allowedAgentPresets)).join(' '),
      )
      check(`${preset}: log reports [${want.tools.length}/${want.tools.length}]`, logFor(a.agent.id).some((l) => l.includes(`mounted=[${want.tools.length}/${want.tools.length}]`)))
    }

    // 2. Every other preset mounts nothing.
    for (const preset of NO_SURFACE) {
      const a = track(`offline-route-${preset}`, preset)
      await created({ agent: a.agent })
      await settle()
      check(`${preset}: mounts nothing`, a.mounted.length === 0, `${a.mounted.length} mounts: ${a.live().join(',')}`)
    }
  }

  // 3. secretary-standard → secretary-cordis remounts against the cordis leader.
  {
    const { created, change, track } = boot()
    const a = track('offline-remount-cordis', 'secretary-standard')
    await created({ agent: a.agent })
    await settle()
    const old = [...a.mounted]
    a.agent.ctx.preset = 'secretary-cordis'
    change()
    await settle()
    check('standard→cordis: old leader fibers disposed', old.length === 3 && old.every((f) => f.disposed), `${old.filter((f) => !f.disposed).length}/${old.length} survived`)
    sameSet('standard→cordis: leader tools live', a.live(), LEADER_TOOLS)
    const live = a.mounted.filter((f) => !f.disposed).map((f) => f.config)
    check('standard→cordis: both CLI and native leadership select cordis', live.length === 3 && live.every(c => c.provider === 'spawn' ? c.agentPreset === 'team-leader-cordis' : c.provider === 'secretary-cc-leader-cordis'), live.map(c => c.provider).join(','))
    check(
      'standard→cordis: live allowedAgentPresets=[team-leader-cordis]',
      live.every(c => c.provider === 'spawn' ? JSON.stringify(c.allowedAgentPresets) === '["team-leader-cordis"]' : c.allowedAgentPresets === undefined),
    )
  }
  // 4. The first mount rejects; the next tools/change retries to a full surface.
  {
    const { created, change, track } = boot()
    const a = track('offline-mount-failure', 'secretary-standard')
    const realPlugin = a.agent.ctx.plugin
    let calls = 0
    a.agent.ctx.plugin = (plugin, config) => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('simulated mount rejection')) : realPlugin(plugin, config)
    }
    await created({ agent: a.agent })
    await settle()
    const afterFailure = logFor(a.agent.id)
    check('mount failure: logged as "mount delegate_leader failed"', afterFailure.some((l) => l.includes('mount delegate_leader failed for offline-mount-failure: simulated mount rejection')))
    check('mount failure: partial surface logged as [2/3]', afterFailure.some((l) => l.includes('mounted=[2/3]')))
    check('mount failure: no [3/3] before the retry', !afterFailure.some((l) => l.includes('mounted=[3/3]')))
    check('mount failure: surface recorded with key undefined', a.agent[SURFACE] !== undefined && a.agent[SURFACE].key === undefined, JSON.stringify(a.agent[SURFACE]?.key))
    sameSet('mount failure: only the last two tools live before retry', a.live(), ['delegate_leader_astra', 'delegate_leader_deepseek'])

    change()
    await settle()
    sameSet('mount failure: retry ends with all leader tools live', a.live(), LEADER_TOOLS)
    check('mount failure: exactly 3 live after retry', a.live().length === 3, `${a.live().length} live`)
    const afterRetry = logFor(a.agent.id)
    const firstComplete = afterRetry.findIndex((l) => l.includes('mounted=[3/3]'))
    const failureLine = afterRetry.findIndex((l) => l.includes('mount delegate_leader failed'))
    check('mount failure: [3/3] logged only after the retry', firstComplete > failureLine && firstComplete >= afterFailure.length, `failure@${failureLine} complete@${firstComplete} pre-retry lines=${afterFailure.length}`)
    check('mount failure: surface key set after retry', typeof a.agent[SURFACE]?.key === 'string' && a.agent[SURFACE].key !== 'none')
  }

  // 5. A preset change during an in-flight reconcile is replayed, not dropped.
  {
    const { created, change, track } = boot()
    const a = track('offline-queued-change', 'secretary-standard')
    const realPlugin = a.agent.ctx.plugin
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let entered = false
    let calls = 0
    a.agent.ctx.plugin = (plugin, config) => {
      calls += 1
      if (calls !== 1) return realPlugin(plugin, config)
      entered = true
      return gate.then(() => realPlugin(plugin, config))
    }
    const firstRun = created({ agent: a.agent })
    for (let i = 0; i < 50 && !entered; i += 1) await settle(10)
    check('queued change: first reconcile is blocked inside its first mount', entered && a.mounted.length === 0)
    a.agent.ctx.preset = 'team-leader'
    change()
    await settle()
    check('queued change: nothing mounted while the first reconcile is blocked', a.mounted.length === 0, `${a.mounted.length} mounts`)
    release()
    await firstRun
    await settle(150)
    sameSet('queued change: ends with the eight worker tools', a.live(), WORKER_TOOLS)
    check('queued change: no leader tool left live', !a.live().some((t) => LEADER_TOOLS.includes(t)))
    check('queued change: native workers keep preset and Claude uses CLI', a.mounted.filter(f => !f.disposed).every(f => f.config.provider === 'spawn' ? ['team-worker', 'team-verifier', 'team-researcher', 'team-planner'].includes(f.config.agentPreset) : f.config.provider === 'secretary-cc-worker'))
  }

  // 6. A module load that fails once is retried on the next signal. The module
  // resolves the stub via createRequire(process.argv[1]); pointing argv[1] at a
  // directory without node_modules makes that resolve throw for one attempt.
  {
    const { created, change, track } = boot()
    const a = track('offline-load-failure', 'secretary-standard')
    const stagedEntry = process.argv[1]
    process.argv[1] = join(noResolveDir, 'entry.js')
    await created({ agent: a.agent })
    await settle()
    const loadFailed = readFileSync(stage.testLog, 'utf8').includes('plugin load failed')
    check('load failure: first attempt really failed (logged "plugin load failed")', loadFailed)
    check('load failure: nothing mounted after the failed load', a.mounted.length === 0)
    process.argv[1] = stagedEntry
    change()
    await settle()
    sameSet('load failure: later reconcile mounts the leader tools', a.live(), LEADER_TOOLS)
  }

  // 7. An Agent with no tools is recorded as { key: 'none' } and logged once.
  {
    const { created, change, track } = boot()
    const a = track('offline-none-record', 'standard')
    await created({ agent: a.agent })
    await settle()
    check('zero-tool Agent: recorded as { key: none, fibers: [] }', JSON.stringify(a.agent[SURFACE]) === '{"key":"none","fibers":[]}', JSON.stringify(a.agent[SURFACE]))
    change()
    await settle()
    change()
    await settle()
    const zeroLines = logFor(a.agent.id).filter((l) => l.includes('tools=0')).length
    check('zero-tool Agent: tools=0 logged once across 1 create + 2 tools/change', zeroLines === 1, `${zeroLines} lines`)
  }
} catch (error) {
  check('test ran without throwing', false, String(error?.stack ?? error))
} finally {
  verifyRealLog()
  stage.cleanup()
  rmSync(noResolveDir, { recursive: true, force: true })
}
finish()
