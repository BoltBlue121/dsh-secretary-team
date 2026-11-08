// Per-Agent delegation surface for the secretary team.
//
// Declaring `tool-subagent` rows inside a preset does not install their tools
// (a preset-scope row takes the per-Agent reconcile path, and `agentPresets.mount`
// applies plugins before `bind` joins the Agent to the composition). Registering
// them globally does install them, but then every unrelated session sees seven
// delegation tools it may not use, and only a guard stands between a confused
// model and a wrong call.
//
// This plugin mounts the official `@deepseek-ai/dsh-tool-subagent` once per
// Agent, inside that Agent's own scope, for exactly the tools its preset may use:
//
//   secretary-standard     → delegate_leader / delegate_leader_astra → team-leader
//   secretary-cordis       → delegate_leader / delegate_leader_astra → team-leader-cordis
//   team-leader            → six delegate_worker_*                   → team-worker / team-verifier
//   team-leader-cordis     → six delegate_worker_*                   → team-worker-cordis / team-verifier
//   everything else        → nothing
//
// The creation-mode presets get their own route: the cordis secretary must reach
// the cordis leader, because only that preset carries `tool-cordis`, the skills
// and the "the team never installs plugins" rule; the standard leader would
// silently drop a creation-mode handoff.
//
// Scoped registration is the mechanism the registry error text points at ("for a
// per-agent variant, register through that agent's `agent.ctx`"), so the tool
// exists only where it is legitimate: no global rows, no prompt filtering, no
// guard needed.
//
// v1.4: a Session can be created on the default preset and switched to a
// secretary preset before its first turn (the GUI preset picker does exactly
// that). `agent/created` fires with the old preset and never fires again, so a
// creation-only listener mounts nothing. `agentPresets.recompose` emits
// `tools/change` after re-binding, so this plugin reconciles every live Agent on
// that event too, and disposes the previous mounts when an Agent's tool set
// changes.
//
// v1.5: the mount record lives on the Agent itself (symbol-keyed), not in a
// module-level WeakMap. A profile config change re-applies this plugin with
// fresh module state while fibers it mounted earlier may still be registered on
// the Agent, so module-local state could forget them.
//
// v1.6: a mount that throws is cleaned up and retried on the next signal instead
// of being recorded as complete; a failed module load is not cached forever; and
// a preset change that lands while a reconcile is in flight is replayed instead
// of dropped.
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'secretary-team-delegation'
export const inject = ['agentPresets', 'loader', 'agents']

const LOG_PATH = 'G:/DSH-Platform-Hub/research/secretary-team-20261030/delegation-status.log'
// Logged on activation so the log shows which revision the Host is running.
const VERSION = '2.4.1'

// Claude is a product backend, not an AgentLoop model route. Never fall back
// to spawn+Opus if the CLI backend is absent or fails.
const ASTRA = { provider: 'banology-gemini', model: 'gpt-6-astra' }
// Optional cheaper engineering leader on the DeepSeek account route. Same
// hands-on leader preset, only the model route differs.
const DEEPSEEK = { provider: 'deepseek-account', model: 'deepseek-flash' }
// Independent acceptance runs on its own leaf preset: read everything, run the
// acceptance commands, write nothing. `flattenDelegatedMember` also denies write
// and edit in the verifier's own scope, so "report, do not fix" is mechanical.
const VERIFY_PRESET = 'team-verifier'
// The rest of a standard team roster: research first, then a plan, then
// implementation, then independent acceptance.
const RESEARCH_PRESET = 'team-researcher'
const PLAN_PRESET = 'team-planner'
// DSH's own default composition. Always offered as a member preset when it is
// readable, so a leader can hand a task to a stock DSH agent instead of a team
// preset when that fits better.
const DSH_STANDARD_PRESET = 'standard'

function leaderTools(agentPreset) {
  return [
    { toolName: 'delegate_leader', backend: agentPreset === 'team-leader-cordis' ? 'secretary-cc-leader-cordis' : 'secretary-cc-leader' },
    { toolName: 'delegate_leader_astra', agentPreset, agentOptions: ASTRA },
    { toolName: 'delegate_leader_deepseek', agentPreset, agentOptions: DEEPSEEK },
  ]
}

function workerTools(agentPreset) {
  return [
    {
      toolName: 'delegate_worker_fast',
      agentPreset,
      agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    },
    { toolName: 'delegate_worker_stable', agentPreset, agentOptions: { provider: 'moeblack', model: 'gpt-6.1-sol' } },
    {
      toolName: 'delegate_worker_writing',
      agentPreset,
      agentOptions: { provider: 'banology-gemini', model: 'gemini-4-argon' },
    },
    { toolName: 'delegate_worker_backend', agentPreset, agentOptions: ASTRA },
    { toolName: 'delegate_worker_frontend', backend: 'secretary-cc-worker' },
    { toolName: 'delegate_worker_verify', agentPreset: VERIFY_PRESET, agentOptions: { provider: 'moeblack', model: 'gpt-6.1-sol' } },
    { toolName: 'delegate_worker_research', agentPreset: RESEARCH_PRESET, agentOptions: { provider: 'banology-gemini', model: 'gemini-4-argon' } },
    { toolName: 'delegate_worker_plan', agentPreset: PLAN_PRESET, agentOptions: ASTRA },
  ]
}

const SURFACES = new Map([
  ['secretary-standard', leaderTools('team-leader')],
  ['secretary-cordis', leaderTools('team-leader-cordis')],
  ['team-leader', workerTools('team-worker')],
  ['team-leader-cordis', workerTools('team-worker-cordis')],
])

// Survives a re-apply of this plugin; a plain module-level map would not.
const SURFACE = Symbol.for('@local/dsh-secretary-team/surface')
// Fallback for an Agent object that refuses the symbol property.
const FALLBACK_SURFACES = new WeakMap()

function log(line) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
}

// Delegated members may run under any registered preset that is not itself a
// team-control preset, so the specialized composition (cordis tooling, COMSOL,
// novel writing, drawing, …) travels with the member instead of being hardcoded.
// Team-control presets stay excluded: a member must never become a second
// secretary, a second engineering leader, a self-appointed verifier, researcher
// or planner. The stock DSH `standard` composition is accepted explicitly.
const TEAM_CONTROL_PRESET = /^(?:secretary-|team-leader|team-verifier|team-researcher|team-planner)/
const MAX_PRESET_CHOICES = 15

export async function workerPresetChoices(agentPresets, fallback) {
  let presets = []
  let listed = false
  try {
    presets = (await agentPresets?.list?.()) ?? []
    listed = true
  } catch {
    // Registry unavailable: the fixed default preset still works.
  }
  const ids = []
  const accept = async (id) => {
    // `list()` reports activation failures as a diagnostic on `broken`, not as a
    // boolean flag: any presence means this preset cannot be composed safely.
    if (typeof id !== 'string' || id === fallback || TEAM_CONTROL_PRESET.test(id) || ids.includes(id)) return
    // A candidate that cannot even have its declaration read would fail the
    // official preset validation for every worker tool, so drop it here instead.
    if (agentPresets?.readDocument !== undefined) {
      try {
        await agentPresets.readDocument(id)
      } catch {
        return
      }
    }
    ids.push(id)
  }
  for (const preset of presets) {
    if (preset?.broken !== undefined) continue
    await accept(preset?.id)
  }
  // The stock DSH composition is always offered when readable, even if the
  // registry list does not surface it. Only ask once the registry answered:
  // with the registry down we cannot validate the declaration either.
  if (listed) await accept(DSH_STANDARD_PRESET)
  return ids.slice(0, MAX_PRESET_CHOICES)
}

export function toolsFor(preset, memberRoutes, presetChoices) {
  const tools = SURFACES.get(preset) ?? []
  const routed = !memberRoutes || (preset !== 'team-leader' && preset !== 'team-leader-cordis')
    ? tools
    : tools.map(tool => tool.backend ? tool : { ...tool,
      agentOptions:memberRoutes.resolveMember(tool.toolName.slice('delegate_worker_'.length),tool.agentPreset,tool.agentOptions) })
  if (!presetChoices?.length) return routed
  return routed.map(tool => tool.backend || !tool.toolName.startsWith('delegate_worker_') ? tool
    : { ...tool, allowedAgentPresets:[tool.agentPreset, ...presetChoices] })
}

export function toolConfig(tool) {
  if (tool.backend) return { provider:tool.backend, toolName:tool.toolName, maxDepth:'provider-managed' }
  return { provider:'spawn', toolName:tool.toolName, agentOptions:tool.agentOptions,
    agentPreset:tool.agentPreset, allowedAgentPresets:tool.allowedAgentPresets ?? [tool.agentPreset], maxDepth:2 }
}
// Use the exact official direct-Agent setup (ctx, config, session), so the
// registration belongs to our wrapper instead of a sibling standing installer.
export function ownedToolPlugin(plugin, session) {
  if (!session || typeof session !== 'object') throw new Error('DELEGATION_SESSION_REQUIRED')
  return { name:'secretary-owned-subagent-tool', inject:plugin.inject, Config:plugin.Config,
    apply:(toolCtx, config) => plugin.apply(toolCtx, config, session) }
}
export function keyFor(tools) {
  return tools.length ? `cli-only-v2:${JSON.stringify(tools.map(toolConfig))}` : 'none'
}
function routeLabel(tool) {
  return tool.backend ? `${tool.backend}/claude-code` : `${tool.agentOptions.provider}/${tool.agentOptions.model}`
}

function readSurface(agent) {
  try {
    const own = agent[SURFACE]
    if (own !== undefined) return own
  } catch {
    // Fall through to the WeakMap.
  }
  return FALLBACK_SURFACES.get(agent)
}

function writeSurface(agent, state) {
  try {
    agent[SURFACE] = state
    return
  } catch {
    // Non-extensible Agent object.
  }
  FALLBACK_SURFACES.set(agent, state)
}

function clearSurface(agent) {
  try {
    delete agent[SURFACE]
  } catch {
    // Ignore.
  }
  FALLBACK_SURFACES.delete(agent)
}

// A fiber registered by an earlier revision of this plugin may still be live; one
// whose Agent context unloaded reports a null uid.
function alive(fibers) {
  return fibers.filter((fiber) => fiber !== undefined && fiber !== null && fiber.uid !== null && fiber.disposed !== true)
}

// Cordis refuses `ctx.plugin()`/`ctx.effect()` once a scope is disposed. Seeing
// this during a reconcile means the Agent is gone, not that the mount is broken.
const INACTIVE_CONTEXT = /inactive context/i

async function disposeAll(fibers, agentId) {
  for (const fiber of fibers) {
    try {
      await fiber.dispose()
    } catch (error) {
      log(`dispose failed for ${String(agentId)}: ${String(error?.message ?? error)}`)
    }
  }
}

export function apply(ctx) {
  log(`delegation plugin active (bundle ${VERSION}, claude=Claude-Code-CLI, native-Claude-fallback=disabled)`)
  let modulePromise
  const loadPluginModule = () => {
    if (modulePromise === undefined) {
      modulePromise = (async () => {
        if (ctx.get('loader')?.await !== undefined) await ctx.get('loader').await()
        const requireFromHost = createRequire(process.argv[1])
        const entry = requireFromHost.resolve('@deepseek-ai/dsh-tool-subagent')
        return import(pathToFileURL(entry).href)
      })().catch((error) => {
        // A transient load failure must not disable delegation for the session.
        modulePromise = undefined
        throw error
      })
    }
    return modulePromise
  }

  // Mounting a tool emits `tools/change`, which reconciles; a preset change that
  // arrives during that window is queued instead of lost.
  const reconciling = new WeakSet()
  const pending = new WeakSet()
  const owned = new Map()
  const running = new Set()
  const generation = Symbol('delegation-generation')
  let stopped = false
  // Specialized member presets change rarely; a short cache keeps reconcile off
  // the preset registry on every step while still noticing a newly added preset.
  const choicesCache = new Map()
  const presetChoicesFor = async (fallback) => {
    const hit = choicesCache.get(fallback)
    if (hit !== undefined && Date.now() - hit.at < 30_000) return hit.ids
    const ids = await workerPresetChoices(ctx.agentPresets, fallback)
    choicesCache.set(fallback, { ids, at: Date.now() })
    return ids
  }
  // A delegated member may carry another preset's specialized tools, but it may
  // not start a second layer of agents or a second team. Restrictions are
  // registered in the member's own scope, so they outlive this plugin revision.
  const MEMBER_DENY = ['subagent','subagent_fork','subagent_claude_code','delegate_claude_code',
    'spawn_teammate','send_message','list_agents','wait_agent','interrupt_agent',
    'team_task_create','team_task_list','team_task_get','team_task_update','followup_task']
  // An independent verifier reports, it does not fix. Denying the write tools in
  // its own scope keeps the verdict away from the code it just graded.
  const VERIFIER_DENY = ['write', 'edit', 'apply_patch', 'write_file', 'edit_file']
  const memberPresetOf = (agent) => {
    try { return ctx.agentPresets.composedPreset(agent.ctx) } catch { return undefined }
  }
  const flattened = new WeakSet()
  const flattenDelegatedMember = (agent) => {
    if (agent?.ctx?.tools?.restrict === undefined || flattened.has(agent)) return
    let delegated = false
    for (const owner of owned.keys()) {
      let ownedBy = false
      try {
        ownedBy = ctx.get('agents')?.isOwnedBy?.(agent.id, owner) === true
      } catch {
        continue
      }
      if (!ownedBy) continue
      // A secretary's child is a leader, not a member: only a team-leader's child
      // is flattened. The owner preset is read from its bound composition.
      let ownerPreset
      try { ownerPreset = ctx.agentPresets.composedPreset(owner.ctx) } catch { ownerPreset = undefined }
      if (typeof ownerPreset === 'string' && ownerPreset.startsWith('team-leader')) delegated = true
      break
    }
    if (!delegated) return
    flattened.add(agent)
    const verifier = typeof memberPresetOf(agent) === 'string' && memberPresetOf(agent).startsWith(VERIFY_PRESET)
    let denied = 0
    for (const name of verifier ? [...MEMBER_DENY, ...VERIFIER_DENY] : MEMBER_DENY) {
      try { agent.ctx.tools.restrict({ deny: [name] }); denied += 1 } catch {
        // Not a global tool in this composition.
      }
    }
    log(`member ${String(agent.id)} flattened: ${denied} tool(s) denied${verifier ? ' (verifier: write/edit denied)' : ''}`)
  }
  const adopt = (agent, state) => {
    Object.defineProperty(state, 'owner', { value:generation, writable:true, configurable:true })
    owned.set(agent,state)
    return state
  }
  function reconcile(agent) {
    if (stopped) return Promise.resolve()
    const work = reconcileOnce(agent)
    running.add(work)
    void work.finally(() => running.delete(work)).catch(() => {})
    return work
  }
  async function reconcileOnce(agent) {
    if (stopped || agent?.ctx === undefined) return
    if (reconciling.has(agent)) {
      pending.add(agent)
      return
    }
    reconciling.add(agent)
    try {
      let preset
      try {
        preset = ctx.agentPresets.composedPreset(agent.ctx)
      } catch (error) {
        log(`preset lookup failed for ${String(agent.id)}: ${String(error?.message ?? error)}`)
        return
      }
      const memberRoutes = ctx.get('workbenchMemberRoutes')
      const fallbackPreset = preset === 'team-leader-cordis' ? 'team-worker-cordis' : 'team-worker'
      const choices = preset === 'team-leader' || preset === 'team-leader-cordis'
        ? await presetChoicesFor(fallbackPreset)
        : []
      const tools = toolsFor(preset, memberRoutes, choices)
      const key = keyFor(tools)
      const current = readSurface(agent)
      const previous = alive(current?.fibers ?? [])
      if (current !== undefined && current.key === key && previous.length === (current.fibers ?? []).length) {
        if (tools.length > 0) adopt(agent,current)
        return
      }
      if (current?.key === `inactive:${key}`) return

      let plugin
      if (tools.length > 0) {
        try {
          plugin = await loadPluginModule()
        } catch (error) {
          log(`plugin load failed: ${String(error?.stack ?? error)}`)
          return
        }
      }

      if (stopped) return
      // Dispose first: a remount may reuse the same tool names.
      await disposeAll(current?.fibers ?? [], agent.id)
      if (stopped) return

      if (tools.length === 0) {
        // Remember "nothing to do" so a later signal does not re-log every Agent.
        if (current?.key !== 'none') log(`agent ${String(agent.id)} preset=${preset} tools=0`)
        writeSurface(agent, { key: 'none', fibers: [] })
        return
      }

      const next = []
      const mounted = []
      let inactive = false
      for (const tool of tools) {
        if (stopped) break
        const config = toolConfig(tool)
        let wrapper
        try {
          // The exported 0.2.1-rc.3 direct-Agent setup takes a Session as its
          // third argument. Without it, preset-bearing configs install a sibling
          // candidate.ctx.inject fiber that outlives this wrapper on HMR.
          wrapper = agent.ctx.plugin(ownedToolPlugin(plugin,agent.session), config)
          next.push(await wrapper)
          mounted.push(`${tool.toolName}(${routeLabel(tool)})`)
        } catch (error) {
          const message = String(error?.message ?? error)
          // v1.7.3: a reconcile can arrive after the Agent context unloaded (the
          // leader finished and its scope went inactive). That is normal teardown,
          // not a mount defect: stop, drop what mounted, and remember it so a later
          // tools/change does not retry forever.
          if (INACTIVE_CONTEXT.test(message)) {
            inactive = true
            try {
              if (wrapper !== undefined) await Object.getPrototypeOf(wrapper).dispose()
            } catch {
              // Ignore cleanup failures.
            }
            break
          }
          log(`mount ${tool.toolName} failed for ${String(agent.id)}: ${message}`)
          // A fiber may exist even when awaiting its plugin rejected; dispose the
          // real fiber (never the wrapper, whose dispose() would corrupt the uid).
          try {
            if (wrapper !== undefined) await Object.getPrototypeOf(wrapper).dispose()
          } catch {
            // Ignore cleanup failures.
          }
        }
      }
      if (stopped) {
        await disposeAll(alive(next),agent.id)
        return
      }
      if (inactive) {
        await disposeAll(alive(next), agent.id)
        writeSurface(agent, { key: `inactive:${key}`, fibers: [] })
        log(`agent ${String(agent.id)} preset=${preset} inactive: context unloaded, nothing mounted`)
        return
      }
      // A partial surface is recorded without a key, so the next signal retries.
      writeSurface(agent, adopt(agent, { key: mounted.length === tools.length ? key : undefined, fibers: next }))
      log(
        `agent ${String(agent.id)} preset=${preset} mounted=${mounted.length > 0 ? `[${mounted.length}/${tools.length}] ${mounted.join(',')}` : 'none'}`,
      )
    } finally {
      reconciling.delete(agent)
      if (pending.has(agent)) {
        pending.delete(agent)
        void reconcile(agent)
      }
    }
  }

  const liveAgents = () => {
    try {
      return ctx.get('agents')?.list() ?? []
    } catch {
      return []
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    if (agent?.ctx === undefined) return
    // Flatten before the member's first step: a specialized preset must not
    // inherit a second layer of delegation just because it carries such tools.
    flattenDelegatedMember(agent)
    // `agent/created` can land before a deferred preset mount finished binding the
    // Agent, so give the binding a moment instead of concluding "no preset".
    for (let attempt = 0; attempt < 25; attempt += 1) {
      let preset
      try {
        preset = ctx.agentPresets.composedPreset(agent.ctx)
      } catch (error) {
        log(`preset lookup failed for ${String(agent.id)}: ${String(error?.message ?? error)}`)
        return
      }
      if (preset !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await reconcile(agent)
  })

  // `agentPresets.select` → `recompose` re-binds the Agent and emits this, which is
  // the only signal a Session that switched preset before its first turn gives.
  ctx.on('tools/change', () => {
    for (const agent of liveAgents()) void reconcile(agent)
  })

  // Resolve operator-configured member routes at a safe boundary when the optional
  // Workbench service has been loaded, changed, or removed since the last step.
  ctx.on('agent/pre-step', async ({ agent },next) => {
    if (agent?.ctx && readSurface(agent)?.fibers?.length && !stopped) await reconcile(agent)
    return next()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent !== undefined) { owned.delete(agent); clearSurface(agent) }
  })
  return async () => {
    stopped = true
    await Promise.allSettled([...running])
    for (const [agent,state] of owned) {
      if (state.owner !== generation || readSurface(agent) !== state) continue
      clearSurface(agent)
      await disposeAll(alive(state.fibers),agent.id)
    }
    owned.clear()
  }
}
