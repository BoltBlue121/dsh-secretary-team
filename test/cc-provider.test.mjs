import test from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeProvider } from '../lib/cc-provider.mjs'
const config={executablePath:'claude',expectedSha256:'fixture',model:'claude-opus-5-5',baseUrl:'https://gateway.example',credentialRef:'GATEWAY_API_KEY',nodeExecutablePath:'C:/tools/node.exe',timeoutMs:1000,maxOutputBytes:10000,maxBudgetUsd:1,disposeGraceMs:50,maxWorkers:2,maxConcurrent:1}
const parent={id:'parent',session:{}}
const request=()=>({parent,cwd:'G:/fixture',prompt:[{type:'text',text:'make a small project'}],signal:new AbortController().signal})
function setup(extra={}){
 const seen=[]
 const deps={verify:async()=>{},directory:async()=>true,resolveCredential:async()=>({value:'fixture-secret'}),baseEnvironment:()=>({PATH:'x',ANTHROPIC_BASE_URL:'wrong'}),policy:()=>({mode:'danger-full-access'}),runProcess:async input=>{seen.push(input);return {stopReason:'completed',output:[{type:'text',text:'done'}]}},startWorker:async()=>assert.fail('unexpected worker'),record:()=>{},...extra}
 return {provider:createClaudeProvider({name:'test-provider',role:'leader',workerPreset:'team-worker',config,deps}),seen}
}
test('provider returns external run with isolated MCP and locked credentials',async()=>{
 const {provider,seen}=setup();const run=await provider.start(request());const result=await run.result
 assert.equal(result.stopReason,'completed');assert.equal(seen.length,1)
 assert.equal(seen[0].env.ANTHROPIC_BASE_URL,'https://gateway.example')
 assert.equal(seen[0].env.ANTHROPIC_AUTH_TOKEN,'fixture-secret')
 assert.doesNotMatch(JSON.stringify(seen[0].mcpConfig),/fixture-secret/)
 assert.match(JSON.stringify(seen[0].mcpConfig),/\$\{DSH_CC_WORKER_TOKEN\}/)
 assert.equal(provider.capabilities.agentPreset,false)
 await run.dispose()
})
test('sandbox cannot be silently widened by external CLI',async()=>{
 const {provider,seen}=setup({policy:()=>({mode:'read-only'})})
 await assert.rejects(provider.start(request()),/CLI_CONFINED_MODE_UNSUPPORTED/)
 assert.equal(seen.length,0)
})
test('pin and credentials failure never invokes fallback',async()=>{
 const a=setup({verify:async()=>{throw new Error('PIN_MISMATCH')}})
 await assert.rejects(a.provider.start(request()),/PIN_MISMATCH/);assert.equal(a.seen.length,0)
 const b=setup({resolveCredential:async()=>({value:''})})
 await assert.rejects(b.provider.start(request()),/CLI_CREDENTIAL_MISSING/);assert.equal(b.seen.length,0)
})
test('unconfirmed CLI process cleanup rejects dispose and blocks reuse',async()=>{
 const {provider}=setup({runProcess:async()=>({stopReason:'error',output:[],diagnostic:'CLI_CLEANUP_FAILED'})})
 const run=await provider.start(request())
 assert.equal((await run.result).diagnostic,'CLI_CLEANUP_FAILED')
 await assert.rejects(run.dispose(),/CLI_CLEANUP_FAILED/)
 await assert.rejects(provider.start(request()),/CLI_CLEANUP_PENDING/)
 await assert.rejects(provider.dispose(),/CLI_CLEANUP_FAILED/)
})

test('CLI failure is terminal and cleans its bridge',async()=>{
 let url,token
 const {provider}=setup({runProcess:async input=>{url=input.env.DSH_CC_WORKER_URL;token=input.env.DSH_CC_WORKER_TOKEN;return {stopReason:'error',output:[],diagnostic:'CLI_EXIT_NONZERO'}}})
 const run=await provider.start(request());assert.equal((await run.result).stopReason,'error')
 await assert.rejects(fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`}}))
 await run.dispose()
})
test('provider unload waits for unpublished startup and prevents late CLI work',async()=>{
 let release,enter
 const ready=new Promise(resolve=>{enter=resolve})
 const {provider,seen}=setup({verify:()=>{enter();return new Promise(resolve=>{release=resolve})}})
 const opening=provider.start(request())
 const observed=opening.catch(error=>error.message)
 await ready
 let finished=false
 const closing=provider.dispose().then(()=>{finished=true})
 await Promise.resolve();await Promise.resolve()
 assert.equal(finished,false)
 release();assert.equal(await observed,'CLI_ABORTED')
 await closing;assert.equal(seen.length,0)
})

test('provider unload joins an in-flight CLI run',async()=>{
 let resolveRun, entered
 const ready=new Promise(resolve=>{entered=resolve})
 const {provider}=setup({runProcess:async input=>{entered();return new Promise(resolve=>{resolveRun=resolve;input.signal.addEventListener('abort',()=>resolve({stopReason:'aborted',output:[]}),{once:true})})}})
 const run=await provider.start(request());await ready
 await provider.dispose()
 assert.equal((await run.result).stopReason,'aborted')
 await assert.rejects(provider.start(request()),/CLI_PROVIDER_CLOSED/)
})

test('worker role cannot obtain MCP worker delegation',async()=>{
 let seen
 const deps={verify:async()=>{},directory:async()=>true,resolveCredential:async()=>({value:'x'}),baseEnvironment:()=>({}),policy:()=>({mode:'danger-full-access'}),runProcess:async input=>{seen=input;return {stopReason:'completed',output:[{type:'text',text:'done'}]}}}
 const provider=createClaudeProvider({name:'secretary-cc-worker',role:'worker',workerPreset:'team-worker',config,deps})
 const run=await provider.start(request());await run.result
 assert.deepEqual(seen.mcpConfig,{mcpServers:{}})
 assert.equal(seen.env.DSH_CC_WORKER_TOKEN,undefined)
 await run.dispose()
})
