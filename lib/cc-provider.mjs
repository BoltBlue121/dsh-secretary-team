import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createWorkerBroker } from './worker-broker.mjs'
import { startBrokerServer } from './worker-transport.mjs'

const CAPABILITIES=Object.freeze({agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false})
const safeError=code=>new Error(code)
const leaderPrompt = `你是工程主 Agent，通过真实 Claude Code 执行。秘书控制用户目标、范围与授权；你可亲自读写代码、调试、整合，也可分派下属成员。不要为派活而派活。需要独立并行工作时使用 dsh_workers 的 dispatch_worker；收回结果用 wait_worker/worker_status，停止任务用 cancel_worker。自己与成员不得并发修改同一文件；接手前等成员结束并重新读取。成员报告不是验收证据，亲自核对文件和测试。所有 Claude 角色只能用 Claude Code，不允许自己 HTTP 直连模型或启动另一套 agent 绕过成员桥。不要读/打印认证文件或环境凭据，不改全局 profile，不安装或重启 DSH。需要用户授权的破坏性/部署操作通过秘书汇报。最后报告修改文件、实跑命令与结果、未完成事项。`
const workerPrompt = `你是领导派出的执行成员，通过真实 Claude Code 运行。可亲自读写文件和执行任务内测试；只完成任务书授权范围，不再分派、不启动其他Agent、不直连任何模型API。不改全局profile、不安装或重启DSH，不读/打印凭据。报告文件、实跑测试及风险。`

export function createClaudeProvider({name,role,workerPreset,config,deps}){
  const active=new Set()
  const starting=new Set()
  const unquiesced=new Set()
  let disposed=false
  const record=event=>{try{deps.record?.(event)}catch{/* audit never crashes host */}}
  return {
    name,capabilities:CAPABILITIES,inheritsParentContext:false,
    async start(request){
      let finishStart
      const startDone=new Promise(resolve=>{finishStart=resolve})
      starting.add(startDone)
      try {
      if(disposed)throw safeError('CLI_PROVIDER_CLOSED')
      if(unquiesced.size)throw safeError('CLI_CLEANUP_PENDING')
      if(!request.parent?.session)throw safeError('CLI_OWNER_SESSION_REQUIRED')
      const policy=deps.policy(request.parent)
      // Raw subprocess is not an OS sandbox. Until the nested CLI/MCP process
      // chain has a proven confinement backend, refuse confined sessions.
      if(policy?.mode!=='danger-full-access')throw safeError('CLI_CONFINED_MODE_UNSUPPORTED')
      if(request.signal.aborted)throw safeError('CLI_ABORTED')
      if(!Array.isArray(request.prompt)||!request.prompt.length||request.prompt.some(b=>b.type!=='text'||typeof b.text!=='string'))throw safeError('CLI_TEXT_TASK_REQUIRED')
      const prompt=request.prompt.map(b=>b.text).join('\n')
      if(!prompt.trim()||prompt.length>128000)throw safeError('CLI_INVALID_TASK')
      if(!await deps.directory(request.cwd))throw safeError('CLI_INVALID_CWD')
      await deps.verify()
      // A stock Claude Code install authenticates through its own login; a
      // managed gateway additionally injects base URL + token from credentials.
      const configuredGateway=Boolean(config.baseUrl&&config.credentialRef)
      const credential=configuredGateway?await deps.resolveCredential(config.credentialRef):undefined
      if(configuredGateway&&(typeof credential?.value!=='string'||!credential.value))throw safeError('CLI_CREDENTIAL_MISSING')
      if(disposed||request.signal.aborted)throw safeError('CLI_ABORTED')
      const runId=randomUUID()
      const controller=new AbortController()
      const abort=()=>controller.abort()
      request.signal.addEventListener('abort',abort,{once:true})
      let broker,transport,settled,closePromise
      const state={abort,done:null};active.add(state)
      async function cleanup(){
        closePromise??=(async()=>{
          // Revoke the external capability before admitting any more work.
          const errors=[]
          try{await transport?.close()}catch{errors.push('transport')}
          try{await broker?.close()}catch{errors.push('workers')}
          request.signal.removeEventListener('abort',abort)
          active.delete(state)
          if(errors.length)throw safeError('CLI_CLEANUP_FAILED')
        })()
        return closePromise
      }
      try{
        if(role==='leader'){
          broker=createWorkerBroker({runId,cwd:request.cwd,parent:request.parent,workerPreset,
            start:deps.startWorker,record,maxConcurrent:config.maxConcurrent,maxWorkers:config.maxWorkers,signal:controller.signal})
          transport=await startBrokerServer({broker})
        }
        if(disposed||request.signal.aborted)controller.abort()
        const env={...deps.baseEnvironment(),
          ...(configuredGateway?{ANTHROPIC_BASE_URL:config.baseUrl,ANTHROPIC_AUTH_TOKEN:credential.value,ANTHROPIC_API_KEY:''}:{}),
          ...(config.configDir?{CLAUDE_CONFIG_DIR:config.configDir}:{}),
          DISABLE_AUTOUPDATER:'1',DISABLE_UPDATES:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',
          ...(transport?{DSH_CC_WORKER_URL:transport.url,DSH_CC_WORKER_TOKEN:transport.token}:{})}
        // Env expansion keeps the per-run secret out of argv and config text.
        const mcpConfig={mcpServers:transport?{dsh_workers:{type:'stdio',command:config.nodeExecutablePath,args:[fileURLToPath(new URL('./worker-mcp.mjs',import.meta.url))],env:{DSH_CC_WORKER_URL:'${DSH_CC_WORKER_URL}',DSH_CC_WORKER_TOKEN:'${DSH_CC_WORKER_TOKEN}'}}}:{}}
        record({kind:'run-start',runId,ownerId:request.parent.id,role,provider:name,model:config.model,cliVersion:config.expectedVersion})
        settled=Promise.resolve().then(()=>deps.runProcess({config,cwd:request.cwd,prompt,role,mcpConfig,
          systemPrompt:role==='leader'?leaderPrompt:workerPrompt,runId,env,signal:controller.signal,spawn:deps.spawn,record}))
          .catch(()=>({stopReason:controller.signal.aborted?'aborted':'error',output:[],diagnostic:'CLI_RUNTIME_ERROR'}))
          .then(async result=>{
            if(result.diagnostic==='CLI_CLEANUP_FAILED')unquiesced.add(runId)
            try{await cleanup()}catch{unquiesced.add(runId);return {stopReason:'error',output:[],diagnostic:'CLI_CLEANUP_FAILED'}}
            record({kind:'run-end',runId,ownerId:request.parent.id,role,stopReason:result.stopReason})
            return result
          })
        state.done=settled
        return {id:runId,result:settled,dispose:async()=>{
          controller.abort();await settled;await cleanup()
          if(unquiesced.has(runId))throw safeError('CLI_CLEANUP_FAILED')
        }}
      }catch(error){controller.abort();await cleanup();throw error}
      } finally {starting.delete(startDone);finishStart()}
    },
    async dispose(){
      disposed=true
      for(const state of active)state.abort()
      await Promise.all([...starting])
      for(const state of active)state.abort()
      await Promise.all([...active].map(s=>s.done).filter(Boolean))
      if(unquiesced.size)throw safeError('CLI_CLEANUP_FAILED')
    },
  }
}
