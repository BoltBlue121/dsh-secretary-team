// Read-only role gate for the independent team roles: team-verifier,
// team-researcher and team-planner.
//
// Those presets mount `tool-fs` with write/edit disabled, and
// `flattenDelegatedMember` denies the write tools again in a verifier's scope.
// But they keep `pwsh` / `bash` so they can run acceptance commands, and until
// v2.5 "do not write through the shell either" was only a persona line. This
// gate makes it mechanical with the same detection the secretary gate uses,
// plus the verbs a reviewer is most likely to reach for when it starts "just
// fixing" what it was asked to grade (cp/mv/touch/tee, `sed -i`, git verbs that
// change the work tree or history, package installs, `fs.writeFileSync` and
// friends inside `node -e`, .NET file writers).
//
// Read-only commands stay available: `node test/run.mjs`, `npm test`,
// `git status/diff/log`, `Get-Content`, `2>&1`, `2>$null`. Tests may still
// create their own temp files; the gate judges the command line, it is not an
// OS sandbox.
import { CORDIS_EXEC_TOOLS, FILE_TOOLS, SHELL_TOOLS, shellWrites } from './secretary-gate.mjs'

export const name = 'secretary-team-readonly-gate'
export const inject = ['tools']

const ROLE_WRITE = new RegExp([
  String.raw`\b(?:cp|mv|touch|tee|ln|rmdir|del|erase|copy|move|ren|ni|ri|sc|ac)\b`,
  String.raw`\bsed\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i`,
  String.raw`\bgit\s+(?:add|commit|checkout|switch|restore|reset|revert|apply|am|rm|mv|clean|stash|merge|rebase|cherry-pick|push|pull|tag|branch\s+-[dDmM])\b`,
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|remove|rm|uninstall|update|up|publish|link)\b`,
  String.raw`\bpip3?\s+(?:install|uninstall)\b`,
  String.raw`\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdirSync|rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync|createWriteStream)\b`,
  String.raw`\b(?:WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendAllLines)\b`,
  String.raw`-OutFile\b|\bExport-(?:Csv|Clixml)\b|\bExpand-Archive\b|\bCompress-Archive\b`,
].join('|'), 'i')

const FILE_MESSAGE =
  'This is a read-only team role (independent verifier / researcher / planner): it reports, it does not change files. ' +
  'Write the problem and the expected fix into your report; the leader assigns the rework to an implementer.'
const SHELL_MESSAGE =
  'This is a read-only team role: this shell command would write files or change the repository. ' +
  'Run only read-only commands (tests, builds into temp dirs, git status/diff/log, reads) and report the finding instead.'
const CORDIS_MESSAGE =
  'This is a read-only team role: defining, running or removing Cordis plugins executes code. Report instead.'

/** Exposed for tests: would this shell command be refused for a read-only role? */
export function roleShellWrites(command) {
  return shellWrites(command, ROLE_WRITE)
}

export function apply(ctx) {
  ctx.tools.guard((exec) => {
    if (FILE_TOOLS.has(exec?.name)) return FILE_MESSAGE
    if (CORDIS_EXEC_TOOLS.has(exec?.name)) return CORDIS_MESSAGE
    if (SHELL_TOOLS.has(exec?.name) && roleShellWrites(exec?.arguments?.command)) return SHELL_MESSAGE
    return undefined
  })
}
