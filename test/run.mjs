// Runs the offline test files one after another, each in its own process (the
// delegation tests rewrite process.argv[1] and load module copies).
//
// Usage: node test/run.mjs   (from the bundle root, or anywhere)
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FILES = ['delegation.test.mjs', 'reload.test.mjs', 'routing.test.mjs', 'options.test.mjs', 'boundary.test.mjs', 'gate.test.mjs', 'leader-role.test.mjs', 'cli-routing.test.mjs', 'claude-policy.test.mjs', 'worker-broker.test.mjs', 'worker-transport.test.mjs', 'cc-provider.test.mjs', 'cc-process.test.mjs', 'cli-evidence.test.mjs']

const results = []
for (const file of FILES) {
  const run = spawnSync(process.execPath, [join(TEST_DIR, file)], { encoding: 'utf8', env: process.env, timeout: 60_000 })
  if (run.stdout) process.stdout.write(run.stdout)
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.error) console.log(`FAIL ${file} did not run: ${run.error.message}`)
  const ok = run.status === 0
  results.push({ file, ok })
  console.log(`== ${file}: ${ok ? 'PASS' : `FAIL (exit ${run.status ?? run.signal})`}\n`)
}

const failed = results.filter((r) => !r.ok)
console.log(`SUMMARY: ${results.length - failed.length}/${results.length} test files passed${failed.length ? `; failed: ${failed.map((r) => r.file).join(', ')}` : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
