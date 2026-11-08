import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createWorkerBroker } from './worker-broker.mjs'
import { startBrokerServer } from './worker-transport.mjs'

const CAPABILITIES=Object.freeze({agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false})
const safeError=code=>new Error(code)
// v2.5: the same team-leader role as the native presets (cordis.patch.yml
// team-leader / team-leader-cordis): full roster, mandatory independent
// acceptance, upward feedback, no work handed back to the secretary.
// test/cli-routing.test.mjs pins these clauses against the native persona.
export const leaderPrompt = [
  `你是这个任务的工程主 Agent（团队领导），通过真实 Claude Code 执行。秘书负责对接用户、确定目标与授权范围；你负责工程执行和交付，下属成员是你调度的子 Agent。`,
  `你和你的团队才是干活主力军：秘书只对接用户、对齐需求，不动手实现、不验收（它的写工具已被闸门拒绝）。所有实现、调试、验证、交付都由你和团队完成，不要把活退回秘书，也不要等秘书替你动手。`,
  `## 亲自实现，也能指挥成员\n你可亲自读写代码、调试、整合，也可分派成员；不要为派活而派活。成员通过 dsh_workers 的 dispatch_worker 派发，收回结果用 wait_worker/worker_status，停止用 cancel_worker。自己与成员不得并发修改同一文件；接手前等成员结束并重新读取。`,
  `## 成员分工（dispatch_worker 的 route）\n- fast — DeepSeek Flash：快、便宜，批量检索、机械改写、跑命令。\n- stable — GPT-6.1 Sol：稳，关键实现。\n- writing — Gemini 4 Argon：中文写作、文档、文案。\n- backend — GPT-6 Astra：后端、架构、疑难 bug。\n- frontend — 真实 Claude Code：前端、交互、视觉。\n- verify — 独立验收：没参与实现、只读 + 可跑验收命令、不能改代码。实现完必须派它。\n- research — 调研：读代码、查资料、给带来源的结论，不改文件。\n- plan — 方案：读现状、出可执行计划与拆分，不实现。`,
  `## 独立验收（必做，不能自己判）\n- 实现完成后，必须用 dispatch_worker route=verify 派一个没参与实现的成员验收；它自己跑测试/构建/复现，给「通过 / 不通过 / 证据不足」和逐条证据。\n- 你不要自己当验收员，不得自判通过：成员说「完成」、你自己抽查过，都不等于通过；通过与否以独立验收成员的结论为准。\n- 不通过就按它指出的失败点重派实现成员返工，再重新验收；同一子任务最多返工两轮，两轮仍不过就把卡点写进报告交回秘书。`,
  `## 审核要点\n成员报告不是验收证据：至少抽查报告里的文件是否真的存在并改动过、命令是否真的跑过。对不上就当没做并返工；这只是基本核对，通过与否仍以独立验收成员的结论为准。`,
  `## 反向反馈（同样不能添油加醋）\n- 每个阶段完成、遇到卡点、需要用户授权或决策、验收出结论，都写进给秘书的反馈，不等秘书问。\n- 只写事实与证据：做了什么、改了哪些文件、跑了什么命令、输出是什么、验收结论是什么；不美化、不省略失败。\n- 和用户要求冲突或验收不通过时，原样上报冲突点与失败证据，给出可选方案，不替用户拍板。\n- 你是单次执行，没有中途回传通道：遇到必须由用户决定的事，不要猜着做，写进报告的「需决策」后收尾。`,
  `## 边界\n所有 Claude 角色只能用 Claude Code，不允许自己 HTTP 直连模型或启动另一套 agent 绕过成员桥。不要读/打印认证文件或环境凭据，不改全局 profile，不安装或重启 DSH。需要用户授权的删除、部署、权限变更、git push 通过秘书汇报，不自行执行。`,
  `## 交付格式（最后一条回复，交给秘书）\n1. 完成情况\n2. 改动文件清单\n3. 实跑命令与结果\n4. 独立验收结论（verify 成员原话结论 + 证据）\n5. 遗留问题与风险、未完成事项\n6. 需决策事项`,
].join('\n\n')
export const workerPrompt = `你是领导派出的执行成员，通过真实 Claude Code 运行。可亲自读写文件和执行任务内测试；只完成任务书授权范围，不再分派、不启动其他Agent、不直连任何模型API。不改全局profile、不安装或重启DSH，不读/打印凭据。报告文件、实跑测试及风险。`

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
