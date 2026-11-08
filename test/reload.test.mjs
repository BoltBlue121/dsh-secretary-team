// Profile hot reload of preset/delegation.mjs. A profile config change makes
// DSH re-apply the plugin with fresh module state, while the tool-subagent
// fibers mounted earlier belong to the Agent's fiber and stay registered. Two
// module instances run against the same Agent object: the second must adopt
// the first instance's mounts instead of mounting a duplicate set, and a later
// switch away must dispose every mount.
//
// Usage: node test/reload.test.mjs
import { bootDelegation, createReporter, guardRealLog, makeAgent, settle, stageDelegation } from './helpers.mjs'

const LEADER_TOOLS = ['delegate_leader', 'delegate_leader_astra', 'delegate_leader_deepseek']

const { check, sameSet, finish } = createReporter('delegation: profile hot reload')
const verifyRealLog = guardRealLog(check)
const stage = stageDelegation('dsh-secretary-reload-')

try {
  // One Agent that keeps its identity (and its mounted fibers) across the reload.
  const a = makeAgent('offline-reload-agent', 'secretary-standard')
  const agents = [a.agent]

  const first = bootDelegation(await stage.load(), agents)
  await first.get('agent/created')({ agent: a.agent })
  await settle()
  sameSet('instance #1: leader tools mounted', a.live(), LEADER_TOOLS)

  // Reload: the old instance's listeners stop receiving events, its module
  // state is gone, but the fibers it mounted on the Agent are still registered.
  const second = bootDelegation(await stage.load(), agents)
  check('instance #2 is a distinct module instance', second !== first)
  second.get('tools/change')()
  await settle()
  check('after reload: no duplicate mounts', a.live().length === LEADER_TOOLS.length, `${a.live().length} live: ${a.live().join(',')}`)
  sameSet('after reload: leader tools still live', a.live(), LEADER_TOOLS)

  check('plugin exposes cross-scope cleanup', typeof second.get('test/dispose') === 'function')
  if (typeof first.get('test/dispose') === 'function') await first.get('test/dispose')()
  sameSet('old instance cleanup cannot remove adopted current tools', a.live(), LEADER_TOOLS)

  // Switching away must dispose every mount, however many exist.
  a.agent.ctx.preset = 'team-worker'
  second.get('tools/change')()
  await settle()
  sameSet('switch to team-worker: every mount disposed', a.live(), [])
  check('switch to team-worker: all mounts disposed', a.mounted.every((f) => f.disposed), `${a.mounted.filter((f) => !f.disposed).length} survived`)
  a.agent.ctx.preset = 'secretary-standard'
  second.get('tools/change')(); await settle()
  if (typeof second.get('test/dispose') === 'function') await second.get('test/dispose')()
  sameSet('unload removes own cross-Agent tools', a.live(), [])
  second.get('tools/change')(); await settle()
  sameSet('disposed plugin cannot remount tools', a.live(), [])
} catch (error) {
  check('test ran without throwing', false, String(error?.stack ?? error))
} finally {
  verifyRealLog()
  stage.cleanup()
}
finish()
