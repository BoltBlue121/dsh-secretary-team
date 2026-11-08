// Secretary gate: the secretary delegates the work, it does not build things.
//
// The persona says the secretary only interfaces with the user and the leader.
// A live run on 2026-11-01 22:33 showed that instruction alone is not
// enforcement: deepseek-flash answered the acceptance task with "这个任务由
// 我自己来办：共 4 个小文件，十来分钟能收工，派团队反而绕路" and then wrote the
// whole project itself (write ×4). The user then made the split stricter: the
// main agent is the secretary, the leader and its team do every file change.
// So every file-writing tool shape is refused mechanically in the secretary
// presets:
//
// - `write` / `edit` / `apply_patch` (and their `*_file` aliases) change files.
// - shell verbs that write files (Set-Content, New-Item, Out-File, redirects…)
//   would otherwise be the obvious bypass.
// - v2.5: `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine`.
//   The creation-mode secretary mounts `tool-cordis` for `cordis_inspect_*`, and
//   that plugin has no inspect-only switch: the same row registers the tools
//   that define and run dynamic Host/Client plugins, which is executing code.
//
// The refusal message names the legal routes (delegate_leader /
// delegate_leader_astra / delegate_leader_deepseek) so a model that hits the
// gate can correct itself in the same turn. Desks that are not the secretary
// (leaders, workers) do not mount this plugin: workers must be able to write.
// The read-only team roles reuse the same detection through `readonly-gate`.
export const name = 'secretary-team-gate'
export const inject = ['tools']

export const SHELL_TOOLS = new Set(['pwsh', 'bash'])
// Word-boundary verbs plus a file redirect. `2>&1` does not match because the
// character after `>` is `&`. Redirects into the null device (`2>$null`,
// `>/dev/null`, `> nul`) discard output and are stripped before the test.
const SHELL_WRITE =
  /\b(Set-Content|Add-Content|Out-File|Tee-Object|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|mkdir|md|rm)\b|>>?\s*[^\s&|]/i
const NULL_SINK = /\d?>>?\s*(?:\$null|\/dev\/null|nul)(?![\w.])/gi
export const FILE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'write_file', 'edit_file'])
// Everything `tool-cordis` registers besides `cordis_inspect_*`.
export const CORDIS_EXEC_TOOLS = new Set(['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine'])

/** True when a shell command string would write files. `extra` adds patterns. */
export function shellWrites(command, extra) {
  if (typeof command !== 'string') return false
  const stripped = command.replace(NULL_SINK, '')
  return SHELL_WRITE.test(stripped) || (extra !== undefined && extra.test(stripped))
}

const WRITE_MESSAGE =
  'The secretary only interfaces with the user and the leader: do not write, edit or create files yourself. ' +
  'Call delegate_leader / delegate_leader_astra / delegate_leader_deepseek with a full task brief. ' +
  'Read-only inspection is the only work the secretary may do.'
const SHELL_MESSAGE =
  'The secretary does not run commands that write files: this shell command would write. ' +
  'Call delegate_leader / delegate_leader_astra / delegate_leader_deepseek with a full task brief.'
const CORDIS_MESSAGE =
  'The secretary does not define, run, stop or remove Cordis plugins: that executes code. ' +
  'Only cordis_inspect_list / cordis_inspect_query are available to the secretary. ' +
  'Call delegate_leader / delegate_leader_astra / delegate_leader_deepseek with a full task brief.'

export function apply(ctx) {
  ctx.tools.guard((exec) => {
    if (FILE_TOOLS.has(exec?.name)) return WRITE_MESSAGE
    if (CORDIS_EXEC_TOOLS.has(exec?.name)) return CORDIS_MESSAGE
    if (SHELL_TOOLS.has(exec?.name) && shellWrites(exec?.arguments?.command)) return SHELL_MESSAGE
    return undefined
  })
}
