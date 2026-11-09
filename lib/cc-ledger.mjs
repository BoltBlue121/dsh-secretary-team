// v2.6: on-disk ledger of Claude CLI leader continuations, so `[续接 id]` keeps
// working after a bundle reload or Host restart. One JSON file, one key per
// provider name. Rows hold ids, owner session, cwd and timestamps only: no
// prompt text, no credentials. Writes are atomic (tmp + rename).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const empty = () => ({ version: 1, providers: {} })

export function createFileLedger(path) {
  const read = () => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      return value && typeof value === 'object' && value.version === 1 && value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers) ? value : empty()
    } catch { return empty() }
  }
  return {
    load(name) {
      const rows = read().providers[name]
      return Array.isArray(rows) ? rows : []
    },
    save(name, rows) {
      const next = read()
      next.providers[name] = rows
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8')
      renameSync(tmp, path)
    },
  }
}
