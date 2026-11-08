// v2.1 routing options: the operator-selectable native leader, the dynamic
// specialized-preset list handed to delegated members, and the flat-team guard
// that keeps a member a leaf even when it carries another preset's tools.
//
// Usage: node test/options.test.mjs
import { readFileSync } from 'node:fs'
import { bootDelegation, createReporter, guardRealLog, makeAgent, settle, stageDelegation } from './helpers.mjs'

const { check, sameSet, finish } = createReporter('delegation: v2.1 leader and member options')
const verifyRealLog = guardRealLog(check)
const stage = stageDelegation('dsh-secretary-options-')
const json = (value) => JSON.stringify(value)

try {
  const mod = await stage.load()

  // 1. The DeepSeek leader is a real, separate route with the same leader preset.
  {
    const leaders = mod.toolsFor('secretary-standard')
    sameSet('secretary-standard: three leader entries', leaders.map((t) => t.toolName),
      ['delegate_leader', 'delegate_leader_astra', 'delegate_leader_deepseek'])
    const deepseek = leaders.find((t) => t.toolName === 'delegate_leader_deepseek')
    check('deepseek leader uses deepseek-account/deepseek-flash',
      deepseek.agentOptions.provider === 'deepseek-account' && deepseek.agentOptions.model === 'deepseek-flash',
      json(deepseek.agentOptions))
    check('deepseek leader stays on team-leader', deepseek.agentPreset === 'team-leader', deepseek.agentPreset)
    const cordis = mod.toolsFor('secretary-cordis')
    check('cordis secretary preset carries the deepseek option too',
      cordis.some((t) => t.toolName === 'delegate_leader_deepseek' && t.agentPreset === 'team-leader-cordis'))
  }

  // 2. Specialized preset choices: registry order kept, team-control presets and
  // broken declarations excluded, the member's own default always available.
  {
    const registry = {
      list: async () => [
        { id: 'team-worker' },
        { id: 'cordis' },
        { id: 'comsol-sim' },
        { id: 'novel-writer' },
        { id: 'ai-draw' },
        { id: 'tavern-lite' },
        { id: 'secretary-standard' },
        { id: 'secretary-cordis' },
        { id: 'team-leader' },
        { id: 'team-leader-cordis' },
        { id: 'broken-preset', broken: true },
        { id: 'cordis' },
        { id: 42 },
      ],
    }
    const choices = await mod.workerPresetChoices(registry, 'team-worker')
    sameSet('specialized choices exclude team control, broken and duplicates, and add the stock DSH preset',
      choices, ['cordis', 'comsol-sim', 'novel-writer', 'ai-draw', 'tavern-lite', 'standard'])
    check('specialized choices keep registry order, stock preset last',
      json(choices) === json(['cordis', 'comsol-sim', 'novel-writer', 'ai-draw', 'tavern-lite', 'standard']), json(choices))
    const cordisChoices = await mod.workerPresetChoices(registry, 'team-worker-cordis')
    check('the other worker default becomes selectable instead',
      cordisChoices.includes('team-worker') && !cordisChoices.includes('team-worker-cordis'), json(cordisChoices))
    check('the stock DSH preset is offered there too', cordisChoices.includes('standard'), json(cordisChoices))
    const failing = await mod.workerPresetChoices({ list: async () => { throw new Error('registry down') } }, 'team-worker')
    sameSet('registry failure falls back to the fixed default only', failing, [])
    const unreadable = {
      list: async () => [{ id: 'good' }, { id: 'bad-declaration' }],
      readDocument: async (id) => { if (id === 'bad-declaration') throw new Error('cannot read declaration'); return { id } },
    }
    sameSet('a preset whose declaration cannot be read is dropped before mounting',
      await mod.workerPresetChoices(unreadable, 'team-worker'), ['good', 'standard'])
    const many = { list: async () => Array.from({ length: 30 }, (_, i) => ({ id: `preset-${i}` })) }
    check('specialized choices are capped', (await mod.workerPresetChoices(many, 'team-worker')).length === 15)
  }

  // 3. toolsFor applies choices to worker entries only; leader entries stay closed.
  {
    const tools = mod.toolsFor('team-leader', undefined, ['cordis', 'comsol-sim'])
    const workers = tools.filter((t) => t.backend === undefined && t.agentPreset === 'team-worker')
    check('every implementer entry offers the default plus the specialized presets',
      workers.every((t) => json(t.allowedAgentPresets) === json(['team-worker', 'cordis', 'comsol-sim'])),
      workers.map((t) => json(t.allowedAgentPresets)).join(' '))
    const verifyTool = tools.find((t) => t.toolName === 'delegate_worker_verify')
    check('the verifier is a native entry on the independent verifier preset',
      verifyTool?.backend === undefined && verifyTool?.agentPreset === 'team-verifier', json(verifyTool))
    check('the verifier keeps the default plus the specialized presets',
      json(verifyTool?.allowedAgentPresets) === json(['team-verifier', 'cordis', 'comsol-sim']), json(verifyTool?.allowedAgentPresets))
    check('implementer entries never offer the verifier role',
      workers.every((t) => !t.allowedAgentPresets.includes('team-verifier')))
    const researchTool = tools.find((t) => t.toolName === 'delegate_worker_research')
    const planTool = tools.find((t) => t.toolName === 'delegate_worker_plan')
    check('research and plan are native entries on their own roster presets',
      researchTool?.agentPreset === 'team-researcher' && planTool?.agentPreset === 'team-planner',
      `${researchTool?.agentPreset},${planTool?.agentPreset}`)
    check('the stock DSH standard preset is selectable for every member tool',
      tools.filter((t) => t.backend === undefined).every((t) => json(t.allowedAgentPresets) === json([t.agentPreset, 'cordis', 'comsol-sim'])),
      tools.filter((t) => t.backend === undefined).map((t) => json(t.allowedAgentPresets)).join(' '))
    const leaders = mod.toolsFor('secretary-standard', undefined, ['cordis'])
    check('leader entries never take a worker preset list',
      leaders.every((t) => t.allowedAgentPresets === undefined))
    const routed = mod.toolsFor('team-leader', { resolveMember: (role) => ({ provider: 'fixture', model: `m-${role}` }) }, ['cordis'])
    check('member route override and preset list compose on the same entry',
      routed.filter((t) => t.backend === undefined).every((t) => t.agentOptions.provider === 'fixture' && json(t.allowedAgentPresets) === json([t.agentPreset, 'cordis'])))
  }

  // 4. toolConfig carries the exact preset list; a missing list closes to the default.
  {
    const closed = mod.toolConfig({ provider: 'spawn', toolName: 'delegate_worker_fast', agentOptions: { provider: 'p', model: 'm' }, agentPreset: 'team-worker', maxDepth: 2 })
    check('missing list closes to the member default', json(closed.allowedAgentPresets) === json(['team-worker']), json(closed.allowedAgentPresets))
    const open = mod.toolConfig({ provider: 'spawn', toolName: 'delegate_worker_fast', agentOptions: { provider: 'p', model: 'm' }, agentPreset: 'team-worker', allowedAgentPresets: ['team-worker', 'cordis'], maxDepth: 2 })
    check('explicit list is passed through verbatim', json(open.allowedAgentPresets) === json(['team-worker', 'cordis']))
    const cli = mod.toolConfig({ backend: 'secretary-cc-worker', toolName: 'delegate_worker_frontend' })
    check('CLI member config stays provider-managed without preset fields',
      cli.maxDepth === 'provider-managed' && cli.allowedAgentPresets === undefined && cli.agentPreset === undefined)
  }

  // 5. Flat-team guard: only a leader-owned member is flattened, in that member's
  // own scope, before it can take a first step.
  {
    const agents = []
    const handlers = bootDelegation(mod, agents, { isOwnedBy: (id, owner) => id === 'member-1' && owner.id === 'leader-1' })
    const created = handlers.get('agent/created')
    const leader = makeAgent('leader-1', 'team-leader', { tools: true })
    agents.push(leader.agent)
    await created({ agent: leader.agent })
    await settle()
    check('leader itself is never flattened', leader.restrictions.length === 0, json(leader.restrictions))

    const member = makeAgent('member-1', 'comsol-sim', { tools: true })
    agents.push(member.agent)
    await created({ agent: member.agent })
    await settle()
    check('specialized member has recursive delegation denied',
      member.restrictions.some((filter) => filter.deny?.includes('subagent')), json(member.restrictions.slice(0, 2)))
    check('specialized member also loses the team tools',
      member.restrictions.some((filter) => filter.deny?.includes('spawn_teammate')) &&
      member.restrictions.some((filter) => filter.deny?.includes('delegate_claude_code')))
    check('flattening is registered in the member scope, once', member.restrictions.length > 0 &&
      readFileSync(stage.testLog, 'utf8').includes('member member-1 flattened'))

    const other = makeAgent('other-1', 'cordis', { tools: true })
    agents.push(other.agent)
    await created({ agent: other.agent })
    await settle()
    check('an unrelated preset agent is not flattened', other.restrictions.length === 0, json(other.restrictions))

    // The independent verifier is a leaf too, and additionally loses the write
    // tools: a verifier must report, not fix.
    const verifierAgents = []
    const verifierHandlers = bootDelegation(mod, verifierAgents, { isOwnedBy: (id, owner) => id === 'verifier-1' && owner.id === 'leader-9' })
    const verifierCreated = verifierHandlers.get('agent/created')
    const verifierLeader = makeAgent('leader-9', 'team-leader', { tools: true })
    verifierAgents.push(verifierLeader.agent)
    await verifierCreated({ agent: verifierLeader.agent })
    await settle()
    const verifier = makeAgent('verifier-1', 'team-verifier', { tools: true })
    verifierAgents.push(verifier.agent)
    await verifierCreated({ agent: verifier.agent })
    await settle()
    check('verifier member: write and edit are denied in its own scope',
      verifier.restrictions.some((f) => f.deny?.includes('write')) && verifier.restrictions.some((f) => f.deny?.includes('edit')),
      json(verifier.restrictions))
    check('verifier member: still a leaf (no recursive delegation)',
      verifier.restrictions.some((f) => f.deny?.includes('subagent')))
  }

  // 6. A native leader is the secretary's child, not a member: it keeps the
  // worker tools it needs and is never flattened by the member guard.
  {
    const agents = []
    const handlers = bootDelegation(mod, agents, { isOwnedBy: (id, owner) => id === 'leader-2' && owner.id === 'secretary-1' })
    const created = handlers.get('agent/created')
    const secretary = makeAgent('secretary-1', 'secretary-standard', { tools: true })
    agents.push(secretary.agent)
    await created({ agent: secretary.agent })
    await settle()
    const leader = makeAgent('leader-2', 'team-leader', { tools: true })
    agents.push(leader.agent)
    await created({ agent: leader.agent })
    await settle()
    check('a secretary-owned native leader is not flattened', leader.restrictions.length === 0, json(leader.restrictions))
    check('the native leader still mounts all worker tools', leader.live().length === 8, json(leader.live()))
  }
} catch (error) {
  check('test ran without throwing', false, String(error?.stack ?? error))
} finally {
  verifyRealLog()
  stage.cleanup()
}
finish()
