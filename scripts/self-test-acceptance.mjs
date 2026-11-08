// Offline fixtures only: a hands-on leader is valid with or without workers.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const EXE = process.execPath
const VERIFIER = fileURLToPath(new URL('./verify-acceptance.cjs', import.meta.url))
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-leader-role-'))
const LOG = path.join(HOME, 'delegation.log')
const SESSIONS = path.join(HOME, 'sessions', 'synthetic-project')
const ROOT = 'session-synthetic-root'
const LEADER = 'agent-synthetic-leader'
const WORKER = 'agent-synthetic-worker'
const t0 = Date.now() - 60000
const stamp = offset => new Date(t0 + offset * 1000).toISOString()
const LEADER_TOOLS = ['read', 'write', 'edit', 'pwsh', 'job_output', 'delegate_worker_fast', 'delegate_worker_stable']
let failures = 0
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++ }
const session = (id, preset, parent, offset) => ({ seq: 1, time: stamp(offset), type: 'session', sessionId: id, agentPreset: preset, parentSession: parent })
const header = (provider, model, tools, offset) => ({ seq: 2, time: stamp(offset), type: 'request/header', data: { header: { config: { provider, model }, tools: tools.map(name => ({ name })) } } })
const assistant = (calls, offset) => ({ seq: 3, time: stamp(offset), type: 'assistant/message', data: { message: { content: calls.map(c => ({ type: 'tool-call', ...c })) } } })
const end = offset => ({ seq: 4, time: stamp(offset), type: 'turn/end', data: { reason: { kind: 'completed' } } })
function writeSession(id, events) {
  const dir = path.join(SESSIONS, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n')))
}
function fixture({ workers = false, readonly = false, provider = 'moeblack', model = 'gpt-6-astra', bypass = false } = {}) {
  // This is a fresh, script-owned mkdtemp tree, never the real DSH_HOME.
  if (fs.existsSync(SESSIONS)) fs.rmSync(SESSIONS, { recursive: true })
  fs.writeFileSync(LOG, `${stamp(0)} delegation plugin active (bundle fixture)\n`)
  writeSession(ROOT, [session(ROOT, 'secretary-standard', null, 1), header('deepseek-account', 'deepseek-flash', ['read', 'delegate_leader_astra'], 2), assistant([{ name: 'delegate_leader_astra', args: { prompt: 'build' } }], 3), end(30)])
  const calls = [
    { name: 'write', args: { file_path: 'fixture/main.js', content: 'x' } },
    { name: 'edit', args: { file_path: 'fixture/main.js', old_string: 'x', new_string: 'y' } },
    { name: 'pwsh', args: { command: 'Set-Content -Path fixture/out.txt -Value hi' } },
  ]
  if (workers) calls.push({ name: 'delegate_worker_stable', args: { prompt: 'write tests' } })
  writeSession(LEADER, [session(LEADER, 'team-leader', ROOT, 4), header(provider, model, readonly ? LEADER_TOOLS.filter(t => !['write', 'edit'].includes(t)) : [...LEADER_TOOLS, ...(bypass ? ['subagent'] : [])], 5), assistant(calls, 6), end(20)])
  if (workers) writeSession(WORKER, [session(WORKER, 'team-worker', LEADER, 7), header('moeblack', 'gpt-6.1-sol', ['read', 'write', 'edit'], 8), assistant([{ name: 'write', args: { file_path: 'fixture/test.js' } }], 9), end(10)])
}
function run(extra = []) {
  try {
    return { code: 0, out: execFileSync(EXE, [VERIFIER, ROOT, `--delegation-log=${LOG}`, ...extra], { env: { ...process.env, DSH_HOME: HOME, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }) }
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` } }
}
function pass(label, result) { check(label, result.code === 0 && /^RESULT: PASS$/m.test(result.out)); if (result.code !== 0) console.log(result.out.slice(-1800)) }
function fail(label, result, marker) { check(label, result.code !== 0 && result.out.includes(marker)); if (result.code === 0 || !result.out.includes(marker)) console.log(result.out.slice(-1800)) }
try {
  fixture()
  pass('leader writes, edits and runs shell without a worker', run())
  pass('explicit leader-write evidence accepts direct file work', run(['--require-leader-write']))
  fail('explicit three-level check needs a worker', run(['--require-workers']), 'FAIL  finished leader delegated to a worker')
  fixture({ workers: true })
  pass('leader and worker both implement (three-level acceptance)', run(['--require-workers', '--require-leader-write']))
  fixture()
  fail('explicit --since cannot relabel an old root as new', run([`--since=${stamp(2)}`]), 'FAIL  root was created after requested --since')
  fixture({ workers: true })
  writeSession(LEADER, [session(LEADER, 'team-leader', ROOT, 4), header('moeblack', 'gpt-6-astra', LEADER_TOOLS, 5), assistant([{ name: 'delegate_worker_stable', args: { prompt: 'implement' } }], 6), end(20)])
  pass('leader may delegate all implementation instead of writing', run(['--require-workers']))
  fail('direct-write evidence must be observed when explicitly requested', run(['--require-leader-write']), 'FAIL  leaders made direct write/edit calls')
  fixture()
  writeSession(LEADER, [session(LEADER, 'team-leader', ROOT, 4), header('moeblack', 'gpt-6-astra', LEADER_TOOLS, 5), header('moeblack', 'gpt-6-astra', [...LEADER_TOOLS, 'subagent'], 10), end(20)])
  fail('later catalog leaks are checked, not only the first header', run(), 'FAIL  leaders were not offered subagent*/Team tools')
  fixture({ readonly: true })
  fail('read-only leader is a regression', run(), 'FAIL  leaders were offered write/edit')
  for (const provider of ['xindupx','some-other-channel']) {
    fixture({ provider, model:'claude-opus-5-5' })
    fail(`native Claude is rejected even on ${provider}`, run(), 'FAIL  no native Claude model route')
  }
  fixture({ bypass: true })
  fail('generic spawning still fails the boundary check', run(), 'FAIL  leaders were not offered subagent*/Team tools')
  fixture()
  fs.appendFileSync(LOG, `${stamp(12)} mount delegate_worker_fast failed for ${LEADER}: inactive context\n${stamp(40)} delegation plugin active (bundle later-reload)\n`)
  fail('reload cannot erase this run mount failures', run(), 'FAIL  delegation log has no mount/dispose failures for this run')
  fixture()
  fs.appendFileSync(LOG, `${stamp(12)} mount delegate_worker_fast failed for unrelated-agent: test\n`)
  pass('unrelated agent failures do not invalidate this tree', run())
  fixture()
  fs.appendFileSync(LOG, `${stamp(12)} plugin load failed: fixture error\n`)
  fail('unattributed plugin failure during run is retained', run(), 'FAIL  delegation log has no mount/dispose failures for this run')
  fixture()
  fs.rmSync(LOG)
  fail('missing log is not a pass', run(), 'INSUFFICIENT  delegation log has no mount/dispose failures for this run')
} finally {
  if (path.dirname(HOME) !== os.tmpdir() || !path.basename(HOME).startsWith('dsh-leader-role-')) throw new Error('Refuse cleanup outside owned fixture')
  fs.rmSync(HOME, { recursive: true, force: true })
}
console.log(failures ? `RESULT: FAIL (${failures} harness checks failed)` : 'RESULT: OK')
process.exitCode = failures ? 1 : 0
