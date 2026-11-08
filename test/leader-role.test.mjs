// Regression: leaders are hands-on engineering main agents, not read-only managers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { apply as boundary } from '../preset/boundary.mjs'
const require = createRequire(import.meta.url)
const yaml = require('G:/DSH-Platform-Hub/system/runtimes/dsh-0.1.5-alpha.1/node_modules/js-yaml')
const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ __js: value }) })
const rows = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([js]) }).flatMap(layer => layer.insert ?? [])
let failed = 0
const check = (name, fn) => { try { fn(); console.log('PASS ' + name) } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message) } }
for (const id of ['team-leader', 'team-leader-cordis']) {
  const row = rows.find(row => row.config?.id === id)
  check(`${id}: declaration exists`, () => assert.ok(row))
  const tools = row.config.plugins.find(p => p.id === 'tool-fs')
  for (const tool of ['read', 'write', 'edit']) check(`${id}: ${tool} enabled`, () => assert.notEqual(tools.config?.[tool], false))
  check(`${id}: no secretary write gate`, () => assert.ok(!row.config.plugins.some(p => p.id === 'secretary-gate')))
  const persona = row.config.plugins.find(p => p.id === 'persona').config.prefix
  check(`${id}: engineering main agent persona`, () => assert.match(persona, /工程主 Agent/))
  check(`${id}: no read-only manager instructions`, () => assert.doesNotMatch(persona, /管理者，不动手|你的工具里没有 write|你自己只读文件|任何文件的新建、修改、删除，哪怕只有一行/))
  check(`${id}: may choose direct implementation`, () => assert.match(persona, /自主决定/))
  check(`${id}: coordinates file ownership`, () => assert.match(persona, /自己.*成员.*同一文件|成员.*自己.*同一文件/))
}
let guard
boundary({ tools: { guard(fn) { guard = fn } }, on() { return () => {} } })
for (const name of ['write', 'edit', 'pwsh', 'delegate_worker_stable']) {
  check(`leader boundary permits ${name}`, () => assert.equal(guard({ name, arguments: { command: 'Set-Content out.txt x' } }), undefined))
}
console.log(`RESULT: ${failed ? 'FAIL' : 'OK'} (${failed} failures)`)
process.exitCode = failed ? 1 : 0
