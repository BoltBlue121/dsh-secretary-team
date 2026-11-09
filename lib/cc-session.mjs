// v2.6: remove the Claude Code transcript of a leader session this bundle
// created. Leader runs persist their session (so `[续接 id]` can resume it);
// once a continuation is evicted, disposed or its first turn failed, the
// transcript is deleted so task content does not pile up on disk.
//
// Deliberately narrow: only `<root>/projects/<one dir>/<uuid>.jsonl` and the
// sibling `<uuid>/` directory Claude Code keeps for that session, where <uuid>
// is a session id this provider generated or Claude reported for it. No glob,
// no sweep of other sessions (a stock install shares ~/.claude with the user).
import { readdir, lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isSessionId } from './cc-process.mjs'

export async function discardClaudeSession(root, sessionId) {
  if (typeof root !== 'string' || !root || !isSessionId(sessionId)) return 0
  const projects = join(root, 'projects')
  let dirs
  try { dirs = await readdir(projects, { withFileTypes: true }) } catch { return 0 }
  let removed = 0
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    for (const [name, kind] of [[`${sessionId}.jsonl`, 'file'], [sessionId, 'dir']]) {
      const target = join(projects, dir.name, name)
      try {
        const info = await lstat(target)
        if (info.isSymbolicLink()) continue
        if (kind === 'file' ? !info.isFile() : !info.isDirectory()) continue
        await rm(target, { recursive: kind === 'dir', force: false })
        removed++
      } catch { /* absent or not removable: nothing else to do */ }
    }
  }
  return removed
}
