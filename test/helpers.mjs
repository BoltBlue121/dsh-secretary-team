// Shared plumbing for the offline secretary-team tests. Nothing here talks to a
// running DSH Host: modules are loaded from a temp copy against fake contexts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TEST_DIR = dirname(fileURLToPath(import.meta.url))
export const BUNDLE_DIR = resolve(TEST_DIR, '..')
export const REPO_DIR = resolve(BUNDLE_DIR, '../..')
export const REAL_LOG = join(REPO_DIR, 'research/secretary-team-20261030/delegation-status.log')

// Override with DSH_APP_ASAR when DSH is installed elsewhere.
const ASAR = process.env.DSH_APP_ASAR
  ?? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData/Local'), 'Programs/DeepSeek Harness/resources/app.asar')
export const TOOL_SUBAGENT_ENTRY = join(ASAR, 'dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js')

export function createReporter(title) {
  let passed = 0
  const failures = []
  console.log(`# ${title}`)
  const check = (label, ok, detail) => {
    if (ok) {
      passed += 1
      console.log(`PASS ${label}`)
    } else {
      failures.push(label)
      console.log(`FAIL ${label}${detail === undefined ? '' : ` (${detail})`}`)
    }
    return ok
  }
  const sameSet = (label, got, want) => {
    const a = [...got].sort().join(',')
    const b = [...want].sort().join(',')
    return check(label, a === b, `got [${a}] want [${b}]`)
  }
  const finish = () => {
    console.log(`RESULT: ${failures.length === 0 ? 'OK' : 'FAIL'} (${passed} passed, ${failures.length} failed)`)
    process.exit(failures.length === 0 ? 0 : 1)
  }
  return { check, sameSet, finish }
}

const countLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').length : null)

// Records the real log's line count now; `verify` asserts it did not change.
export function guardRealLog(check) {
  const before = countLines(REAL_LOG)
  return () => {
    const after = countLines(REAL_LOG)
    check(`real delegation-status.log untouched (lines before=${before} after=${after})`, after === before)
  }
}

// Copies preset/delegation.mjs into a fresh temp dir with LOG_PATH redirected,
// next to a stub `@deepseek-ai/dsh-tool-subagent` that the module resolves via
// `createRequire(process.argv[1])`.
export function stageDelegation(prefix) {
  const work = mkdtempSync(join(tmpdir(), prefix))
  const stubDir = join(work, 'node_modules/@deepseek-ai/dsh-tool-subagent')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-subagent', type: 'module', exports: './index.js' }))
  writeFileSync(join(stubDir, 'index.js'), "export const name = 'stub-tool-subagent'\nexport function apply() {}\n")
  const entry = join(work, 'entry.js')
  writeFileSync(entry, '')
  const testLog = join(work, 'delegation-test.log')
  writeFileSync(testLog, '')

  const source = readFileSync(join(BUNDLE_DIR, 'preset/delegation.mjs'), 'utf8')
  const match = /^const LOG_PATH = '([^'\n]+)'$/m.exec(source)
  if (match === null) throw new Error('LOG_PATH declaration not found in preset/delegation.mjs')
  if (resolve(match[1]) !== resolve(REAL_LOG)) throw new Error(`LOG_PATH ${match[1]} is not the expected ${REAL_LOG}`)
  const copy = join(work, 'delegation.copy.mjs')
  writeFileSync(copy, source.replace(match[0], `const LOG_PATH = ${JSON.stringify(testLog)}`))

  process.argv[1] = entry
  let loads = 0
  return {
    work,
    testLog,
    load: () => import(`${pathToFileURL(copy).href}?instance=${(loads += 1)}`),
    cleanup: () => {
      try {
        rmSync(work, { recursive: true, force: true })
      } catch {
        // Best effort.
      }
    },
  }
}

// Fake Host context for the delegation plugin; returns the captured listeners.
export function bootDelegation(mod, agents, options = {}) {
  const handlers = new Map()
  const dispose = mod.apply({
    on(event, fn) { handlers.set(event, fn); return () => {} },
    get(name) {
      if (name !== 'agents') return undefined
      return { list: () => agents, ...(options.isOwnedBy === undefined ? {} : { isOwnedBy: options.isOwnedBy }) }
    },
    agentPresets: { composedPreset: (agentCtx) => agentCtx.preset },
  })
  handlers.set('test/dispose', dispose)
  return handlers
}

// A fake Agent whose `ctx.plugin` records every mount as a disposable fiber.
// `tools: true` adds the scoped restriction surface used by the flat-team guard.
export function makeAgent(id, preset, options = {}) {
  const mounted = []
  const disposed = []
  const restrictions = []
  const agent = {
    id,
    session: { header: { id } },
    ctx: {
      preset,
      ...(options.tools === true
        ? { tools: { restrict: (filter) => { restrictions.push(filter); return () => {} } } }
        : {}),
      plugin: async (plugin, config) => {
        const fiber = { config, disposed: false, dispose: async () => { fiber.disposed = true; disposed.push(config.toolName) } }
        mounted.push(fiber)
        return fiber
      },
    },
  }
  return { agent, mounted, disposed, restrictions, live: () => mounted.filter((f) => !f.disposed).map((f) => f.config.toolName) }
}

export const settle = async (ms = 80) => {
  for (let i = 0; i < ms / 10; i += 1) await new Promise((r) => setTimeout(r, 10))
}
