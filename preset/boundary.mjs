// Team boundary: keep a team Agent from turning into a leader, an orchestrator
// or an outside spawner.
//
// Two layers, because the model-facing catalog and the executor are different
// surfaces:
//
// 1. `tools.restrict({ deny })` masks a GLOBAL tool in this agent's scope, which
//    is what actually removes it from the request header the model reads
//    (`tools.view(scope).visible` feeds the header). Restrictions intersect and
//    scoped registrations stay visible, so the fixed delegation tools the preset
//    registers itself are untouched. A name that is not a global tool in this
//    scope makes `restrict()` throw; that is swallowed because the guard below
//    still refuses the call, and the union is retried on `tools/change` for rows
//    that register after the agent was composed (the Claude Code CLI provider
//    registers `subagent_claude_code` once its version probe finishes).
// 2. `tools.guard()` refuses execution monotonically, and the prompt assembly
//    hook drops the names from the prompt's own tool section. Both are the
//    second line of defense for a model that names a tool from memory.
//
// History: v1.5 added the generic spawn tools once the Claude Code CLI subagent
// provider came up; v1.6 mounted this boundary in all six team presets (the four
// leader/worker presets were reachable through the same global tools); v1.7 adds
// the catalog-level restriction after a live secretary session still listed
// `subagent_claude_code` even though the assembly hook had filtered it. If the
// team ever needs a Claude Code worker, add a dedicated fixed-route tool instead
// of re-exposing this one.

// v2.6: the secretary and the leader must be able to keep talking to each other
// after the first dispatch (user, 2026-11-09: "秘书跟领导应该有能力双向反复沟通").
// DSH already has that channel: a spawn-provider child is continuable, and the
// standard `@deepseek-ai/dsh-tool-subagent-control` `send_message({ agent_id,
// message })` reaches a direct continuable child or the sender's direct parent —
// `ctx.subagents.sendMessage` authorizes exactly that lineage and nothing else.
// The Agent Teams `send_message({ target, message })` is a different, global tool
// that reaches teammates. The secretary/leader presets register the standard tool
// in their own scope (scoped registrations shadow globals), and mount
// `boundary-messaging`, which passes only the standard call shape. Members and
// read-only roles keep this strict boundary.

export const name = 'secretary-team-boundary'
export const inject = ['tools', 'systemPrompt']

const TEAM_TOOLS = new Set([
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  // Registered by newer Agent Teams versions; harmless if absent.
  'followup_task',
])

// Any other way to start a nested agent would bypass the fixed route.
const SPAWN_TOOLS = new Set(['subagent', 'subagent_fork', 'subagent_claude_code', 'delegate_claude_code'])

const DENY = [...TEAM_TOOLS, ...SPAWN_TOOLS]

// The two standard subagent-control tools. Both take `agent_id`; the Agent Teams
// tools of the same names take `target`.
export const ADJACENT_TOOLS = new Set(['send_message', 'interrupt_agent'])

/** True for a `send_message` / `interrupt_agent` call in the standard shape. */
export function standardAdjacentCall(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  if (Object.hasOwn(args, 'target')) return false
  return typeof args.agent_id === 'string' && args.agent_id.trim().length > 0
}

// A tool definition handed to prompt assembly is Team-shaped when its parameter
// schema names `target`. Definitions may carry the schema flat or as JSON Schema.
function teamShaped(tool) {
  for (const schema of [tool?.parameters, tool?.parameters?.properties, tool?.inputSchema?.properties, tool?.input_schema?.properties]) {
    if (schema !== null && typeof schema === 'object' && Object.hasOwn(schema, 'target')) return true
  }
  return false
}

const ADJACENT_MESSAGE =
  'Use send_message({ agent_id, message }) / interrupt_agent({ agent_id }) only with the agent id of your own ' +
  'direct leader child or your direct parent. Agent Teams targets (target: ...) are not available in this preset.'
const LEADER_ONLY_MESSAGE =
  'The secretary may send_message / interrupt_agent only its own leaders: the child ids that delegate_leader_* returned ' +
  '(earlier ones in this conversation still count). Members belong to the leader: relay through the leader instead.'

// Secretary tools that start a leader. Their result carries the leader child id.
export const LEADER_TOOL = /^delegate_leader(?:_[a-z0-9]+)?$/
const STARTED = /started subagent (\S+)/

/** The child id a successful delegate_leader* call returned, if any. */
export function leaderIdFrom(exec, result) {
  if (!LEADER_TOOL.test(exec?.name ?? '') || result === null || typeof result !== 'object' || result.isError === true) return undefined
  const direct = result.value?.subagentId ?? result.structuredContent?.subagentId
  if (typeof direct === 'string' && direct.trim()) return direct
  const blocks = Array.isArray(result.content) ? result.content : typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : []
  for (const block of blocks) {
    const match = typeof block?.text === 'string' ? STARTED.exec(block.text) : null
    if (match) return match[1]
  }
  return undefined
}

// v2.6 review fix: a Claude CLI leader's native workers are started with the
// SECRETARY as their DSH parent (the CLI is external, so the broker has no other
// Agent to own them), which makes them direct continuable children of the
// secretary. `leaderTargetsOnly` limits the secretary to its leaders, so it
// cannot steer a write-capable worker or the verifier around its leader.
//
// Compatibility with conversations started before 2.6 (and after a restart):
// a leader id is accepted when this scope saw delegate_leader* return it, OR
// when DSH's durable subagentCatalog of the secretary's own session lists it as
// a direct child that is not a broker member (broker members are labelled
// `CC worker <route>: <task>` since the first CLI broker, 6f2dc47). Anything
// else, or an unreadable catalog, is refused.
export const BROKER_MEMBER_LABEL = /^CC worker /

/**
 * Decide a secretary target from its own durable child catalog.
 * @returns undefined when allowed, otherwise the refusal reason.
 */
export async function catalogVerdict(query, ownSessionId, targetId, signal) {
  if (typeof query?.observeSession !== 'function' || typeof ownSessionId !== 'string') return LEADER_ONLY_MESSAGE
  let observation
  try {
    observation = await query.observeSession(ownSessionId, signal ? { signal } : {})
    const entries = observation?.projections?.values?.subagentCatalog
    if (!Array.isArray(entries)) return LEADER_ONLY_MESSAGE
    const entry = entries.find(e => e?.id === targetId)
    if (!entry) return LEADER_ONLY_MESSAGE
    if (typeof entry.label === 'string' && BROKER_MEMBER_LABEL.test(entry.label)) return LEADER_ONLY_MESSAGE
    return undefined
  } catch {
    return LEADER_ONLY_MESSAGE
  } finally {
    try { observation?.[Symbol.dispose]?.() } catch { /* observation release is best effort */ }
  }
}

export function createBoundary({ adjacentMessaging = false, leaderTargetsOnly = false } = {}) {
  const passes = (exec) => adjacentMessaging && ADJACENT_TOOLS.has(exec?.name) && standardAdjacentCall(exec)
  const keepsInPrompt = (tool) => adjacentMessaging && ADJACENT_TOOLS.has(tool?.name) && !teamShaped(tool)
  return function apply(ctx) {
  // One set per agent scope: every secretary agent applies this separately.
  const leaders = new Set()
  ctx.tools.guard((exec) => {
    if (TEAM_TOOLS.has(exec.name)) {
      if (passes(exec)) return undefined // secretary target check: tools/pre-execute below
      if (adjacentMessaging && ADJACENT_TOOLS.has(exec.name)) return ADJACENT_MESSAGE
      return 'This team preset does not orchestrate Agent Teams members. Delegate the work through delegate_leader / delegate_worker_* instead.'
    }
    if (SPAWN_TOOLS.has(exec.name)) {
      return 'This team preset does not spawn its own subagents. Use the fixed delegation route tools (delegate_leader on a secretary, delegate_worker_* on a leader) instead.'
    }
    return undefined
  })
  const disposeAssembly = ctx.on(
    'system-prompt/assemble',
    async (assembly, context, next) => {
      const result = await next()
      const updatedSystem = typeof result.systemPrompt === 'string'
        ? result.systemPrompt.replace(
            '删除、部署、权限变更、git push 一律不做，写进报告建议。',
            '未获秘书在任务书中转达的用户明确授权前，删除、权限变更、git push 不做；但若秘书在任务书中已明确转达用户授权的远端服务器（SSH/SCP）文件同步、编译及科学仿真算例启动，则属于合法授权范围，必须正常执行。',
          )
        : result.systemPrompt
      return {
        ...result,
        ...(updatedSystem !== undefined ? { systemPrompt: updatedSystem } : {}),
        tools: result.tools.filter((tool) => keepsInPrompt(tool) || (!TEAM_TOOLS.has(tool.name) && !SPAWN_TOOLS.has(tool.name))),
      }
    },
    { prepend: true },
  )

  const restricted = new Set()
  const restrictCatalog = () => {
    if (typeof ctx.tools.restrict !== 'function') return
    for (const name of DENY) {
      if (restricted.has(name)) continue
      try {
        ctx.tools.restrict({ deny: [name] })
        restricted.add(name)
      } catch {
        // Not a global tool in this scope (scope-local or not registered yet);
        // the guard above still refuses the call, and tools/change retries.
      }
    }
  }
  restrictCatalog()
  const disposeChange = ctx.on('tools/change', () => {
    restrictCatalog()
  })
  const disposeResult = leaderTargetsOnly
    ? ctx.on('tools/result', (exec, result) => {
        const id = leaderIdFrom(exec, result)
        if (id) leaders.add(id.trim())
      })
    : undefined
  const disposeGate = leaderTargetsOnly
    ? ctx.on('tools/pre-execute', async (exec, next) => {
        if (!passes(exec)) return next()
        const target = exec.arguments.agent_id.trim()
        if (leaders.has(target)) return next()
        const reason = await catalogVerdict(ctx.get?.('sessionQuery'), exec.agent?.id, target, exec.signal)
        if (reason !== undefined) return { kind: 'deny', reason }
        leaders.add(target)
        return next()
      })
    : undefined

  return () => {
    disposeAssembly?.()
    disposeChange?.()
    disposeResult?.()
    disposeGate?.()
  }
  }
}

// Strict boundary: members, read-only roles. The global restriction above still
// masks the GLOBAL Agent Teams tools in the messaging variant; a scoped standard
// `send_message` stays visible (dsh-tools: "restrictions intersect; scoped
// registrations remain visible").
export const apply = createBoundary({ adjacentMessaging: false })
