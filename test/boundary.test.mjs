// Secretary boundary (preset/boundary.mjs): the model must not be offered Team
// tools or generic spawn tools, and the guard must refuse them if a model still
// names them from memory.
//
// Usage: node test/boundary.test.mjs
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLE_DIR, createReporter, guardRealLog } from './helpers.mjs'

const TEAM_TOOLS = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
const SPAWN_TOOLS = ['subagent', 'subagent_fork', 'subagent_claude_code', 'delegate_claude_code']
const KEEP_TOOLS = ['read', 'write', 'edit', 'pwsh', 'todo_write', 'web_search', 'web_fetch', 'delegate_leader', 'delegate_leader_astra']

const { check, sameSet, finish } = createReporter('boundary: secretary tool surface')
const verifyRealLog = guardRealLog(check)

try {
  const mod = await import(pathToFileURL(join(BUNDLE_DIR, 'preset/boundary.mjs')).href)
  let guard
  let assemble
  mod.apply({
    tools: { guard: (fn) => { guard = fn; return () => {} } },
    on: (event, fn) => { if (event === 'system-prompt/assemble') assemble = fn; return () => {} },
  })
  check('tools.guard registered', typeof guard === 'function')
  check('system-prompt/assemble listener registered', typeof assemble === 'function')

  const offered = [...KEEP_TOOLS, ...TEAM_TOOLS, ...SPAWN_TOOLS, 'followup_task']
  const result = await assemble({ tools: offered.map((name) => ({ name })) }, {}, async () => ({ tools: offered.map((name) => ({ name })), systemPrompt: 'x' }))
  const kept = result.tools.map((t) => t.name)
  sameSet('assembly keeps exactly the non-Team, non-spawn tools', kept, KEEP_TOOLS)
  check('assembly result keeps its systemPrompt', result.systemPrompt === 'x')

  for (const name of TEAM_TOOLS) {
    check(`Team tool ${name} dropped from assembly`, !kept.includes(name))
    check(`guard refuses Team tool ${name}`, typeof guard({ name }) === 'string')
  }
  for (const name of SPAWN_TOOLS) {
    check(`spawn tool ${name} dropped from assembly`, !kept.includes(name))
    check(`guard refuses spawn tool ${name}`, typeof guard({ name }) === 'string')
  }
  // v1.6: newer Agent Teams versions also register followup_task.
  check('Team tool followup_task dropped from assembly', !kept.includes('followup_task'))
  check('guard refuses Team tool followup_task', typeof guard({ name: 'followup_task' }) === 'string')
  // v1.6: the boundary now runs in all six team presets, so refusals must not
  // claim the caller is the secretary.
  for (const name of ['followup_task', 'spawn_teammate', 'subagent']) {
    const text = guard({ name })
    check(`guard message for ${name} does not claim the secretary preset`, typeof text === 'string' && !/the secretary preset/i.test(text), text)
  }
  for (const name of KEEP_TOOLS) {
    check(`guard allows ${name}`, guard({ name }) === undefined)
  }

  // v1.7: the model-facing catalog comes from tools.view(scope).visible, which
  // the assembly hook cannot reach for a row registered after the agent was
  // composed (the Claude Code CLI provider registers subagent_claude_code when
  // its version probe finishes). The boundary now restricts each denied name as
  // a global tool in this scope, and retries on tools/change.
  const GLOBAL = new Set([...KEEP_TOOLS, ...TEAM_TOOLS, ...SPAWN_TOOLS, 'followup_task'])
  const allDenied = [...TEAM_TOOLS, ...SPAWN_TOOLS, 'followup_task']

  const restricted = []
  let changeHandler
  mod.apply({
    tools: {
      guard: () => () => {},
      restrict: (filter) => {
        const unknown = (filter.deny ?? []).filter((name) => !GLOBAL.has(name))
        if (unknown.length) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
        restricted.push(...filter.deny)
        return () => {}
      },
    },
    on: (event, fn) => {
      if (event === 'tools/change') changeHandler = fn
      return () => {}
    },
  })
  sameSet('restrict() masks every Team and spawn tool that is global here', restricted, allDenied)
  check('tools/change retry is registered', typeof changeHandler === 'function')

  // A row that is not global yet must not make restrict() throw, and must be
  // picked up on the next tools/change.
  GLOBAL.delete('subagent_claude_code')
  const lateRestricted = []
  mod.apply({
    tools: {
      guard: () => () => {},
      restrict: (filter) => {
        const unknown = (filter.deny ?? []).filter((name) => !GLOBAL.has(name))
        if (unknown.length) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
        lateRestricted.push(...filter.deny)
        return () => {}
      },
    },
    on: (event, fn) => {
      if (event === 'tools/change') changeHandler = fn
      return () => {}
    },
  })
  check('a not-yet-global name does not throw out of apply()', !lateRestricted.includes('subagent_claude_code'))
  GLOBAL.add('subagent_claude_code')
  changeHandler()
  check('tools/change retry restricts a late-registered subagent_claude_code', lateRestricted.includes('subagent_claude_code'))
} catch (error) {
  check('test ran without throwing', false, String(error?.stack ?? error))
} finally {
  verifyRealLog()
}
finish()
