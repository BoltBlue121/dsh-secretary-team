// Keyless real-Claude-Code + MCP smoke. Only loopback fake Anthropic/worker
// endpoints are used: no credentials, model purchase, Host, or project mutation.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn,spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {runClaudeProcess} from '../lib/cc-process.mjs'
import {createWorkerBroker} from '../lib/worker-broker.mjs'
import {startBrokerServer} from '../lib/worker-transport.mjs'
const dir=mkdtempSync(join(tmpdir(),'dsh-cc-local-smoke-'))
mkdirSync(join(dir,'config'))
let modelCalls=0,hadTools=false,workerStarts=0,receivedWorkerResult=false
const records=[]
const broker=createWorkerBroker({runId:'keyless-fixture',cwd:dir,parent:{id:'fixture-parent'},workerPreset:'team-worker',record:e=>records.push(e),start:async spec=>{
 workerStarts++;assert.equal(spec.provider,'spawn');assert.equal(spec.request.agentOptions.model,'deepseek-flash')
 return {childId:'fixture-worker',result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:'fixture-worker-output'}]}),dispose:async()=>{}}
}})
const bridge=await startBrokerServer({broker})
function sse(res,event,data){res.write(`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`)}
const api=createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c)
 const raw=Buffer.concat(chunks).toString('utf8');let body;try{body=JSON.parse(raw)}catch{body={}}
 if(req.url.includes('count_tokens')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"input_tokens":10}');return}
 if(!req.url.startsWith('/v1/messages')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return}
 modelCalls++
 const names=(body.tools??[]).map(t=>t.name)
 hadTools ||= names.includes('mcp__dsh_workers__dispatch_worker')
 receivedWorkerResult ||= raw.includes('fixture-worker-output')
 const step=modelCalls
 const tool=step===1?'mcp__dsh_workers__dispatch_worker':step===2?'mcp__dsh_workers__wait_worker':null
 const input=step===1?{task_id:'fixture',route:'fast',prompt:'Return fixture-worker-output; do not write files.',files:['proof.txt']}:{id:'fixture',timeout_ms:1000}
 const block=tool?{type:'tool_use',id:`toolu_local_${step}`,name:tool,input:{}}:{type:'text',text:''}
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
 sse(res,'message_start',{message:{id:`msg_local_${step}`,type:'message',role:'assistant',model:'claude-opus-5-5',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}})
 sse(res,'content_block_start',{index:0,content_block:block})
 sse(res,'content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(input)}:{type:'text_delta',text:'Local CLI MCP smoke completed.'}})
 sse(res,'content_block_stop',{index:0})
 sse(res,'message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:25}})
 sse(res,'message_stop',{});res.end()
})
await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve))
let child
const nativeSpawn=spec=>{
 child=spawn(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env:spec.env,stdio:['pipe','pipe','pipe'],windowsHide:true})
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({exitCode:code,signal}))})
 return {stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,
 terminate(){if(child.exitCode===null&&child.pid){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill('SIGTERM')}},
 async waitForExit(signal){if(signal?.aborted)return false;return Promise.race([done.then(()=>true),new Promise(resolve=>signal?.addEventListener('abort',()=>resolve(false),{once:true}))])}}
}
try{
 const env={}
 for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key]
 Object.assign(env,{ANTHROPIC_BASE_URL:`http://127.0.0.1:${api.address().port}`,ANTHROPIC_AUTH_TOKEN:'fixture-not-a-real-key',CLAUDE_CONFIG_DIR:join(dir,'config'),DSH_CC_WORKER_URL:bridge.url,DSH_CC_WORKER_TOKEN:bridge.token,DISABLE_AUTOUPDATER:'1',DISABLE_UPDATES:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'})
 const mcpConfig={mcpServers:{dsh_workers:{type:'stdio',command:process.execPath,args:[fileURLToPath(new URL('../lib/worker-mcp.mjs',import.meta.url))],env:{DSH_CC_WORKER_URL:'${DSH_CC_WORKER_URL}',DSH_CC_WORKER_TOKEN:'${DSH_CC_WORKER_TOKEN}'}}}}
 const result=await runClaudeProcess({config:{executablePath:'C:/Users/l/AppData/Roaming/npm/claude.exe',model:'claude-opus-5-5',timeoutMs:60000,maxOutputBytes:1000000,disposeGraceMs:10000,maxBudgetUsd:0.1},cwd:dir,prompt:'Use the configured member tools to dispatch and collect the fixture task.',role:'leader',mcpConfig,systemPrompt:'You are a local protocol test. Use the tool calls provided by the loopback fixture.',runId:'keyless-fixture',env,signal:new AbortController().signal,spawn:nativeSpawn,record:event=>records.push(event)})
 console.log(JSON.stringify({stopReason:result.stopReason,diagnostic:result.diagnostic,modelCalls,hadTools,workerStarts,receivedWorkerResult,toolEvents:records.filter(e=>e.kind==='cli-tool').map(e=>e.tool)}))
 assert.equal(result.stopReason,'completed');assert.equal(hadTools,true);assert.equal(workerStarts,1);assert.equal(receivedWorkerResult,true)
 assert.equal(records.some(e=>JSON.stringify(e).includes(bridge.token)),false)
}finally{
 await bridge.close();await broker.close();await new Promise(resolve=>{api.close(resolve);api.closeAllConnections()})
 if(dirname(dir)!==tmpdir()||!dir.includes('dsh-cc-local-smoke-'))throw new Error('Refuse non-fixture cleanup')
 if(process.platform==='win32'){
  // On this Windows installation removal reports a directory lock while this
  // Node process is alive. The lock owner is not proven. The companion wrapper
  // performs verified fixture removal after exit, before its final verdict.
  console.log(JSON.stringify({cleanupDir:dir}))
 }else rmSync(dir,{recursive:true,force:true})
}
console.log('PROTOCOL: PASS (real CLI + loopback model/MCP/worker fixture; no paid API)')
