// Read-only evaluation of run-owned CLI metadata plus independent native worker
// session summaries. This proves execution/coordination evidence, not artifact
// correctness or complete profile migration; callers must check those separately.
const NATIVE_ROUTES={fast:['deepseek-account','deepseek-flash'],stable:['moeblack','gpt-6.1-sol'],backend:['banology-gemini','gpt-6-astra'],writing:['banology-gemini','gemini-4-argon']}
const claude=model=>/claude|(?:^|[/_-])(?:opus|sonnet|haiku)(?:$|[/_@-])/i.test(String(model))
const status=value=>value===undefined?'INSUFFICIENT':value===null?'N/A':value?'PASS':'FAIL'
const combined=values=>values.some(v=>v===false)?false:values.some(v=>v===undefined)?undefined:true
function cliComplete(events,id,role,provider,owner){
 const rows=events.filter(e=>e.runId===id)
 const start=rows.find(e=>e.kind==='run-start')
 if(!start)return undefined
 if(start.role!==role||start.provider!==provider||start.ownerId!==owner||!claude(start.model)||!start.cliVersion)return false
 const launch=rows.filter(e=>e.kind==='cli-start'&&e.role===role)
 const result=rows.find(e=>e.kind==='cli-result'&&e.role===role)
 const exit=rows.filter(e=>e.kind==='cli-end'&&e.role===role).at(-1)
 const end=rows.filter(e=>e.kind==='run-end'&&e.role===role).at(-1)
 if(launch.length>1)return false
 if(!launch.length||!result||!exit||!end)return undefined
 return exit.stopReason==='completed'&&end.stopReason==='completed'
}
export function evaluateCliRun({events,runId,requireWorkers=false,requireLeaderWrite=false,expectedRoutes=[],inspectNative}){
 const checks=[]
 const add=(label,value,detail)=>checks.push({label,status:status(value),...(detail===undefined?{}:{detail})})
 const own=events.filter(e=>e.runId===runId)
 const start=own.find(e=>e.kind==='run-start')
 const provider=start?.provider
 const expectedProvider=/^secretary-cc-leader(?:-cordis)?$/.test(provider??'')
 add('root is a Claude Code leader run',start?expectedProvider&&start.role==='leader':undefined)
 add('leader CLI execution completed',start?cliComplete(events,runId,'leader',provider,start.ownerId):undefined)
 add('leader directly invoked file writing',requireLeaderWrite?own.some(e=>e.kind==='cli-tool'&&e.role==='leader'&&['Write','Edit'].includes(e.tool)):null)
 const starts=own.filter(e=>e.kind==='worker-start')
 const ends=own.filter(e=>e.kind==='worker-end')
 const identities=starts.map(s=>`${s.taskId}:${s.childId}`)
 const unique=starts.every(s=>typeof s.taskId==='string'&&typeof s.childId==='string')&&new Set(identities).size===identities.length
 const matched=ends.every(e=>starts.some(s=>s.taskId===e.taskId&&s.childId===e.childId))
 add('worker identities and end records are owned and unique',unique&&matched)
 add('workers were dispatched when required',requireWorkers||expectedRoutes.length?starts.length>0:null)
 add('requested worker routes were exercised',expectedRoutes.length?expectedRoutes.every(route=>starts.some(s=>s.route===route)):null)
 add('no startup or cleanup errors in this run',!own.some(e=>['worker-start-error','worker-cleanup-error'].includes(e.kind)))
 const completed=starts.map(s=>{
  const end=ends.filter(e=>e.taskId===s.taskId&&e.childId===s.childId).at(-1)
  return end?end.state==='completed':undefined
 })
 add('all dispatched workers completed',starts.length?combined(completed):null)
 const workers=[],nativeChecks=[],claudeChecks=[]
 for(const worker of starts){
  const end=ends.filter(e=>e.taskId===worker.taskId&&e.childId===worker.childId).at(-1)
  workers.push({id:worker.taskId,childId:worker.childId,route:worker.route,provider:worker.provider,state:end?.state??'unknown'})
  if(worker.route==='frontend'){
   claudeChecks.push(worker.provider==='secretary-cc-worker'?cliComplete(events,worker.childId,'worker','secretary-cc-worker',start?.ownerId):false)
  }else{
   if(worker.provider!=='spawn'||!Object.hasOwn(NATIVE_ROUTES,worker.route)){nativeChecks.push(false);continue}
   let session
   try{session=inspectNative?.(worker.childId)}catch{session=undefined}
   if(!session||!session.routes?.length||!session.ends?.length){nativeChecks.push(undefined);continue}
   const [expectedProvider,expectedModel]=NATIVE_ROUTES[worker.route]
   const expectedPreset=provider==='secretary-cc-leader-cordis'?'team-worker-cordis':'team-worker'
   nativeChecks.push(session.parentSession===start?.ownerId&&session.preset===expectedPreset&&session.ends.at(-1)==='completed'&&session.routes.every(r=>r.provider===expectedProvider&&r.model===expectedModel&&!claude(r.model)))
  }
 }
 add('Claude workers use verified CLI runs',claudeChecks.length?combined(claudeChecks):null)
 add('native workers have matching DSH session evidence',nativeChecks.length?combined(nativeChecks):null)
 const costs=events.filter(e=>e.kind==='cli-result'&&(e.runId===runId||starts.some(s=>s.childId===e.runId))).map(e=>e.cost).filter(v=>typeof v==='number'&&Number.isFinite(v))
 return {runId,ownerId:start?.ownerId,provider,workers,checks,cliReportedCostUsd:costs.reduce((a,b)=>a+b,0),verdict:checks.some(c=>c.status==='FAIL')?'FAIL':checks.some(c=>c.status==='INSUFFICIENT')?'INSUFFICIENT':'PASS',note:'Only execution/coordination evidence. CLI completed is not artifact correctness; verify files and tests independently. CLI cost excludes native worker/channel billing.'}
}
