// Read-only CLI/worker evidence check. Does not call Host APIs, start processes,
// execute delivered code, inspect auth files, or change the historical journal.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { evaluateCliRun } from '../lib/cli-evidence.mjs'
const args=process.argv.slice(2)
const value=(name,fallback)=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1)??fallback
const runId=args.find(a=>!a.startsWith('--'))
if(!runId||!/^[A-Za-z0-9_-]{1,100}$/.test(runId))throw new Error('Provide one exact CLI runId')
const journal=value('--journal','G:/DSH-Platform-Hub/research/secretary-team-20261030/cli-runs.jsonl')
const sessionRoot=value('--sessions',process.env.DSH_HOME?path.join(process.env.DSH_HOME,'sessions'):undefined)
function decode(file){
 const b=fs.readFileSync(file),magic=Buffer.from([0x28,0xb5,0x2f,0xfd]),starts=[]
 for(let p=b.indexOf(magic);p>=0;p=b.indexOf(magic,p+1))starts.push(p)
 let text=''
 for(let i=0;i<starts.length;){let ok=false;for(let j=i+1;j<=starts.length;j++){try{text+=zlib.zstdDecompressSync(b.subarray(starts[i],starts[j]??b.length)).toString('utf8');i=j;ok=true;break}catch{}}if(!ok)throw new Error('INCOMPLETE_SESSION_FRAMES')}
 return text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line))
}
function inspectNative(id){
 if(!sessionRoot||!/^[A-Za-z0-9_-]{1,100}$/.test(id))return undefined
 let file
 for(const entry of fs.readdirSync(sessionRoot,{withFileTypes:true})){
  if(!entry.isDirectory())continue
  const candidate=path.join(sessionRoot,entry.name,id,'session.v4.jsonl.zstd')
  if(fs.existsSync(candidate)){file=candidate;break}
 }
 if(!file)return undefined
 const events=decode(file),session=events.find(e=>e.type==='session')
 let preset=session?.agentPreset
 const routes=[],ends=[],catalogs=[]
 for(const e of events){
  if(e.type==='agent-preset/selected')preset=e.data?.agentPreset??preset
  if(e.type==='request/header'){
   const header=e.data?.header??e.data
   routes.push({provider:header?.config?.provider,model:header?.config?.model})
   if(Array.isArray(header?.tools))catalogs.push(header.tools.map(t=>typeof t==='string'?t:t?.name??t?.function?.name).filter(Boolean))
  }
  if(e.type==='turn/end')ends.push(e.data?.reason?.kind)
 }
 return {parentSession:session?.parentSession,preset,routes,ends,catalogs}
}
let events
try{events=fs.readFileSync(journal,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line))}
catch{console.log('INSUFFICIENT: journal missing or not valid JSONL');process.exit(2)}
const report=evaluateCliRun({events,runId,requireWorkers:args.includes('--require-workers'),requireLeaderWrite:args.includes('--require-leader-write'),expectedRoutes:value('--expect-routes','').split(',').filter(Boolean),inspectNative})
if(args.includes('--json'))console.log(JSON.stringify(report,null,2))
else{
 console.log(`RUN ${report.runId} provider=${report.provider??'?'} owner=${report.ownerId??'?'}`)
 for(const worker of report.workers)console.log(`WORKER ${worker.id} child=${worker.childId} route=${worker.route} backend=${worker.provider} state=${worker.state}`)
 for(const check of report.checks)console.log(`${check.status}  ${check.label}`)
 console.log(`CLI-reported cost (native worker billing excluded): ${report.cliReportedCostUsd.toFixed(6)}`)
 console.log('NOTE: '+report.note)
 console.log('RESULT: '+report.verdict)
}
process.exitCode=report.verdict==='PASS'?0:report.verdict==='FAIL'?1:2
