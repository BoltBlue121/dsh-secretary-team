// Secretary gate (preset/secretary-gate.mjs): a live run proved the persona text
// alone does not stop the secretary from building the project itself. The split is
// now strict — the main agent is only the secretary, the leader and its team do
// every file change — so the gate refuses every file-writing tool shape and shell
// commands that would write, while keeping read-only inspection available.
//
// Usage: node test/gate.test.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLE_DIR, createReporter } from './helpers.mjs'

const { check, finish } = createReporter('gate: secretary may not write files')

try {
  const mod = await import(pathToFileURL(join(BUNDLE_DIR, 'preset/secretary-gate.mjs')).href)
  check('plugin name', mod.name === 'secretary-team-gate')
  check('inject lists tools', Array.isArray(mod.inject) && mod.inject.includes('tools'))

  let guard
  mod.apply({ tools: { guard: (fn) => { guard = fn; return () => {} } } })
  check('tools.guard registered', typeof guard === 'function')

  const call = (name, args) => guard({ name, arguments: args })

  const writeReason = call('write', { path: 'a.txt', content: 'x' })
  check('write is refused', typeof writeReason === 'string', writeReason)
  check('write refusal names delegate_leader', /delegate_leader/.test(writeReason ?? ''))

  const editReason = call('edit', { path: 'a.txt', old: 'a', new: 'b' })
  check('edit is refused too (the secretary never changes files)', typeof editReason === 'string', editReason)
  check('edit refusal names the Astra and DeepSeek routes',
    /delegate_leader_astra/.test(editReason ?? '') && /delegate_leader_deepseek/.test(editReason ?? ''))
  check('apply_patch is refused', typeof call('apply_patch', { input: 'x' }) === 'string')
  check('write_file alias is refused', typeof call('write_file', { path: 'a', content: 'x' }) === 'string')
  check('read is allowed', call('read', { path: 'a.txt' }) === undefined)
  check('grep is allowed', call('grep', { pattern: 'x' }) === undefined)

  const shellReason = call('pwsh', { command: 'Set-Content -Path a.txt -Value x' })
  check('pwsh Set-Content is refused', typeof shellReason === 'string', shellReason)
  check('shell refusal names delegate_leader', /delegate_leader/.test(shellReason ?? ''))
  check('pwsh New-Item is refused', typeof call('pwsh', { command: 'New-Item -ItemType Directory -Path tmp' }) === 'string')
  check('pwsh Out-File is refused', typeof call('pwsh', { command: 'Get-Content a | Out-File b' }) === 'string')
  check('pwsh redirect is refused', typeof call('pwsh', { command: 'node cli.js > out.txt' }) === 'string')
  check('pwsh Add-Content is refused', typeof call('pwsh', { command: 'Add-Content -Path log.txt -Value x' }) === 'string')
  check('bash rm is refused', typeof call('bash', { command: 'rm -rf build' }) === 'string')

  check('pwsh Get-Content is allowed', call('pwsh', { command: 'Get-Content a.txt' }) === undefined)
  check('pwsh node run is allowed', call('pwsh', { command: 'node test.js' }) === undefined)
  check('pwsh 2>&1 is allowed', call('pwsh', { command: 'node test.js 2>&1' }) === undefined)
  check('pwsh git status is allowed', call('pwsh', { command: 'git status --short' }) === undefined)
  check('missing arguments do not throw', call('pwsh', undefined) === undefined)

  // The gate is a guard, not a catalog filter: the delegation tools stay usable.
  check('delegate_leader is not gated', call('delegate_leader', { prompt: 'x' }) === undefined)

  // The read-only surface is enforced by the preset composition itself, not only
  // by the guard: shell, jobs, schedule, goal and planning rows are absent, and
  // tool-fs is mounted with write/edit disabled.
  {
    const require = createRequire(import.meta.url)
    const yaml = require('G:/DSH-Platform-Hub/system/runtimes/dsh-0.1.5-alpha.1/node_modules/js-yaml')
    const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => String(value) })
    const patch = yaml.load(readFileSync(join(BUNDLE_DIR, 'cordis.patch.yml'), 'utf8'), {
      schema: yaml.DEFAULT_SCHEMA.extend([jsType]),
    })
    const byId = new Map(patch.flatMap((layer) => layer.insert ?? []).map((row) => [row.config?.id, row]))
    const FORBIDDEN = ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-schedule', 'command-goal', 'tool-goal',
      'planning', 'tool-plugin-manager', 'tool-plugin-market']
    const READONLY = ['tool-fs', 'tool-fs-search', 'tool-web', 'tool-ask-user', 'tool-todo', 'present']
    for (const id of ['secretary-standard', 'secretary-cordis']) {
      const row = byId.get(id)
      check(`${id}: preset declared`, row !== undefined)
      const plugins = row?.config?.plugins ?? []
      check(`${id}: no shell/job/schedule/goal/planning rows`, plugins.every((entry) => !FORBIDDEN.includes(entry.id)),
        plugins.map((entry) => entry.id).join(','))
      const fsRow = plugins.find((entry) => entry.id === 'tool-fs')
      check(`${id}: tool-fs is mounted read-only`, fsRow?.config?.write === false && fsRow?.config?.edit === false,
        JSON.stringify(fsRow?.config))
      check(`${id}: keeps the read-only inspection surface`, READONLY.every((tool) => plugins.some((entry) => entry.id === tool)))
      check(`${id}: keeps secretary-gate as defense in depth`, plugins.some((entry) => entry.id === 'secretary-gate'))
    }
    for (const id of ['team-leader', 'team-leader-cordis', 'team-worker', 'team-worker-cordis']) {
      const row = byId.get(id)
      const fsRow = (row?.config?.plugins ?? []).find((entry) => entry.id === 'tool-fs')
      check(`${id}: still allowed to write`, fsRow === undefined || (fsRow.config?.write !== false && fsRow.config?.edit !== false),
        JSON.stringify(fsRow?.config))
    }
    // Read-only roster roles (acceptance, research, planning): read-only fs but
    // able to run read-only commands; no file-writing tool rows.
    for (const id of ['team-verifier', 'team-researcher', 'team-planner']) {
      const row = byId.get(id)
      check(`${id}: preset declared`, row !== undefined)
      const plugins = row?.config?.plugins ?? []
      const fsRow = plugins.find((entry) => entry.id === 'tool-fs')
      check(`${id}: tool-fs is mounted read-only`, fsRow?.config?.write === false && fsRow?.config?.edit === false,
        JSON.stringify(fsRow?.config))
      check(`${id}: can run read-only commands`, plugins.some((entry) => entry.id === 'tool-pwsh' || entry.id === 'tool-bash'))
      check(`${id}: no file-writing tool rows`, !plugins.some((entry) => ['write', 'edit', 'apply_patch'].includes(entry.id)),
        plugins.map((entry) => entry.id).join(','))
    }
  }
} catch (error) {
  console.error('FAIL unexpected error: ' + (error?.stack ?? error))
  process.exit(1)
}

finish()
