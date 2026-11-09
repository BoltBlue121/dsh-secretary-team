import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { isAbsolute, dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createReadStream, appendFileSync, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createClaudeProvider } from '../lib/cc-provider.mjs'
import { runClaudeProcess } from '../lib/cc-process.mjs'
import { discardClaudeSession } from '../lib/cc-session.mjs'
import { createFileLedger } from '../lib/cc-ledger.mjs'

// Share the exact running Host dependencies; do not require an ESM package
// already being imported by Cordis during startup.
const requireFromHost=createRequire(process.argv[1])
const schemaModule=await import(pathToFileURL(requireFromHost.resolve('@deepseek-ai/schemastery')).href)
const Schema=schemaModule.default??schemaModule
const {scrubbedParentEnv}=await import(pathToFileURL(requireFromHost.resolve('@deepseek-ai/dsh-subprocess')).href)
export const name='secretary-claude-code-runtime'
export const inject=['subagents','subprocess','credentials','sandboxPolicy']
export const Config=Schema.object({
  // Local installs may pin an absolute executable plus its SHA-256. A stock
  // install can leave the pin and the gateway empty: the CLI then resolves from
  // PATH and uses its own login, and no per-launch hash cost is paid.
  executablePath:Schema.string().default('claude'),
  expectedSha256:Schema.string().default(''),
  expectedVersion:Schema.string().default('2.1.198'),
  nodeExecutablePath:Schema.string().default('node'),
  configDir:Schema.string().default(''),
  baseUrl:Schema.string().default(''),
  credentialRef:Schema.string().default(''),
  model:Schema.string().default('claude-opus-5-5'),
  timeoutMs:Schema.number().default(600000),
  maxOutputBytes:Schema.number().default(2000000),
  maxBudgetUsd:Schema.number().default(2),
  disposeGraceMs:Schema.number().default(3000),
  maxConcurrent:Schema.number().default(4),
  maxWorkers:Schema.number().default(12),
})
const pathLike=value=>typeof value==='string'&&/[\\/]/.test(value)
function validate(config){
  for(const key of ['executablePath','nodeExecutablePath'])if(pathLike(config[key])&&!isAbsolute(config[key]))throw new Error(`CLI_CONFIG_${key}_ABSOLUTE_REQUIRED`)
  if(config.expectedSha256&&!/^[a-f0-9]{64}$/i.test(config.expectedSha256))throw new Error('CLI_CONFIG_PIN_REQUIRED')
  if(config.configDir&&!isAbsolute(config.configDir))throw new Error('CLI_CONFIG_configDir_ABSOLUTE_REQUIRED')
  if(config.baseUrl){
    const url=new URL(config.baseUrl)
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('CLI_CONFIG_HTTPS_REQUIRED')
  }
  if(!/^claude-/.test(config.model))throw new Error('CLI_CONFIG_CLAUDE_MODEL_REQUIRED')
  for(const key of ['timeoutMs','maxOutputBytes','disposeGraceMs','maxConcurrent','maxWorkers'])if(!Number.isSafeInteger(config[key])||config[key]<1)throw new Error(`CLI_CONFIG_${key}_INVALID`)
  if(!Number.isFinite(config.maxBudgetUsd)||config.maxBudgetUsd<=0)throw new Error('CLI_CONFIG_BUDGET_INVALID')
}
export function apply(ctx,config){
  validate(config)
  // Distribution default: env override or a per-user temp dir (the continuation
  // ledger lives next to it), never the author's workspace path.
  const logPath=process.env.DSH_SECRETARY_TEAM_CLI_LOG||join(tmpdir(),'dsh-secretary-team','cli-runs.jsonl')
  const record=event=>{
    try{mkdirSync(dirname(logPath),{recursive:true});appendFileSync(logPath,JSON.stringify({at:new Date().toISOString(),...event})+'\n','utf8')}catch{/* metadata only */}
  }
  // v2.6: CLI leader continuations survive reloads/restarts. Ids, owner session,
  // cwd and timestamps only: no prompt text, no credentials.
  const ledger=createFileLedger(join(dirname(logPath),'cc-continuations.json'))
  const verify=async()=>{
    // Recheck each launch: an auto/manual replacement at the same path must not
    // inherit a successful pin cached from an older executable. An empty pin
    // means "trust the resolved command", for stock installs without a hash.
    if(!config.expectedSha256)return
    const hash=createHash('sha256')
    for await(const chunk of createReadStream(config.executablePath))hash.update(chunk)
    if(hash.digest('hex').toLowerCase()!==config.expectedSha256.toLowerCase())throw new Error('CLI_PIN_MISMATCH')
    if(isAbsolute(config.nodeExecutablePath)&&!(await stat(config.nodeExecutablePath)).isFile())throw new Error('CLI_NODE_MISSING')
  }
  const deps={
    verify,
    directory:async cwd=>{if(typeof cwd!=='string'||!isAbsolute(cwd))return false;try{return(await stat(cwd)).isDirectory()}catch{return false}},
    resolveCredential:ref=>ctx.credentials.resolve(ref),
    baseEnvironment:()=>scrubbedParentEnv(),
    policy:parent=>ctx.sandboxPolicy.resolve({session:parent.session}),
    runProcess:runClaudeProcess,
    spawn:spec=>ctx.subprocess.spawn(spec),
    startWorker:spec=>ctx.subagents.startActivation(spec),
    // v2.6: leader transcripts live under the CLI config dir (stock: ~/.claude).
    discardSession:id=>discardClaudeSession(config.configDir||join(homedir(),'.claude'),id),
    ledger,
    record,
  }
  const providers=[
    ['secretary-cc-leader','leader','team-worker'],
    ['secretary-cc-leader-cordis','leader','team-worker-cordis'],
    ['secretary-cc-worker','worker','team-worker'],
    ['secretary-cc-review','review','team-worker'],
  ].map(([name,role,workerPreset])=>createClaudeProvider({name,role,workerPreset,config,deps}))
  for(const provider of providers)ctx.subagents.registerProvider(provider)
  ctx.effect(()=>()=>Promise.all(providers.map(p=>p.dispose())))
  record({kind:'provider-active',version:'2.0.0',cliVersion:config.expectedVersion,model:config.model,providers:providers.map(p=>p.name)})
}
