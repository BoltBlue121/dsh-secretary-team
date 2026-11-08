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

export function apply(ctx) {
  ctx.tools.guard((exec) => {
    if (TEAM_TOOLS.has(exec.name)) {
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
        tools: result.tools.filter((tool) => !TEAM_TOOLS.has(tool.name) && !SPAWN_TOOLS.has(tool.name)),
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

  return () => {
    disposeAssembly?.()
    disposeChange?.()
  }
}
