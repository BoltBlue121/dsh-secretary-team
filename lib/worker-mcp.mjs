import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { ROUTE_NAMES } from './worker-broker.mjs'

const idSchema={type:'string',minLength:1,maxLength:64,description:'Use dispatch_worker result.id (the original task_id), not childId or a DSH session UUID.'}
const object=properties=>({type:'object',properties,required:Object.keys(properties).filter(k=>k!=='timeout_ms'),additionalProperties:false})
const TOOLS=[
  {name:'dispatch_worker',description:'Delegate one bounded task to a team member. Implementers: fast/stable/backend/writing/frontend. Read-only roles: verify (independent acceptance; required after implementation), research, plan. Returns a run-local worker id; use wait_worker to collect its report.',inputSchema:object({task_id:{...idSchema,pattern:'^[a-zA-Z0-9_-]+$',description:'Idempotency key: reuse only for an identical task.'},route:{type:'string',enum:ROUTE_NAMES,description:'fast=DS, stable=Sol, backend=Astra, writing=Gemini, frontend=Claude Code; verify=independent read-only verifier (team-verifier), research=read-only researcher (team-researcher), plan=read-only planner (team-planner).'},prompt:{type:'string',minLength:1,maxLength:32000,description:'Self-contained task, constraints and executable acceptance criteria.'},files:{type:'array',minItems:1,maxItems:16,items:{type:'string'},description:'Relative files/directories the worker may change (implementers) or must inspect (verify/research/plan, which never write). No absolute paths, parent traversal, wildcards, or overlap with running workers. Coordination scope, not an OS sandbox.'}})},
  {name:'worker_status',description:'Read the state and available report of one worker from this CLI run.',inputSchema:object({id:idSchema})},
  {name:'wait_worker',description:'Wait for one worker; prefer timeout_ms=25000 over rapid status polling. Use the returned id/task_id, not childId. Returns running or a terminal result; verify actual files/tests.',inputSchema:object({id:idSchema,timeout_ms:{type:'integer',minimum:0,maximum:25000,default:1000}})},
  {name:'cancel_worker',description:'Cancel and release one worker owned by this run; returns its final status.',inputSchema:object({id:idSchema})},
]
export function createMcpHandler({call}){
  return async request=>{
    if(!request||request.jsonrpc!=='2.0'||typeof request.method!=='string')return {jsonrpc:'2.0',id:request?.id??null,error:{code:-32600,message:'Invalid Request'}}
    if(request.id===undefined)return undefined
    const result=value=>({jsonrpc:'2.0',id:request.id,result:value})
    if(request.method==='initialize')return result({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(request.params?.protocolVersion)?request.params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'dsh-run-workers',version:'2.0.0'},instructions:'Only controls workers owned by this CLI run. Choose nonoverlapping file scopes and wait for reports. Acceptance is done by a route=verify worker that did not implement, never by the leader itself. No global DSH service access.'})
    if(request.method==='ping')return result({})
    if(request.method==='tools/list')return result({tools:TOOLS})
    if(request.method==='tools/call'){
      try{
        const name=request.params?.name
        if(!TOOLS.some(t=>t.name===name))throw new Error('UNKNOWN_TOOL')
        const value=await call(name,request.params.arguments??{})
        return result({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value})
      }catch(error){const code=/^[A-Z_]{1,64}$/.test(error?.message??'')?error.message:'WORKER_BRIDGE_ERROR';return result({isError:true,content:[{type:'text',text:code}]})}
    }
    return {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}}
  }
}
async function main(){
  const url=new URL(process.env.DSH_CC_WORKER_URL??'http://invalid/')
  const token=process.env.DSH_CC_WORKER_TOKEN
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/rpc'||!url.port||url.username||url.password||!token)throw new Error('INVALID_BRIDGE_ENV')
  const handler=createMcpHandler({call:async(method,args)=>{
    const response=await fetch(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({method,arguments:args}),signal:AbortSignal.timeout(30000)})
    const value=await response.json()
    if(!response.ok)throw new Error(value?.error??'BRIDGE_HTTP_ERROR')
    return value
  }})
  let buffer='',active=0
  process.stdin.setEncoding('utf8')
  process.stdin.on('data',chunk=>{
    buffer+=chunk
    if(buffer.length>131072){process.exitCode=1;process.stdin.destroy();return}
    for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1)
      if(!line.trim())continue
      let request
      try{request=JSON.parse(line)}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue}
      if(active>=16){if(request.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'Busy'}})+'\n');continue}
      active++
      void handler(request).then(reply=>{if(reply)process.stdout.write(JSON.stringify(reply)+'\n')}).finally(()=>{active--})
    }
  })
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(()=>{process.stderr.write('WORKER_BRIDGE_START_FAILED\n');process.exitCode=1})}
