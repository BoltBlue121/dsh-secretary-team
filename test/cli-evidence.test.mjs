import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCliRun } from '../lib/cli-evidence.mjs'

const root='run-leader', child='worker-ds'
const own=(kind,more={})=>({kind,runId:root,...more})
function fixture(){return [
 own('run-start',{role:'leader',ownerId:'owner-session',provider:'secretary-cc-leader',model:'claude-opus-5-5',cliVersion:'2.1.198'}),
 own('cli-start',{role:'leader'}),own('cli-tool',{role:'leader',tool:'Write',file_path:'fixture/leader.txt'}),
 own('worker-start',{taskId:'ds',childId:child,route:'fast',provider:'spawn'}),
 own('worker-end',{taskId:'ds',childId:child,state:'completed'}),
 own('cli-result',{role:'leader',cost:0.1}),own('cli-end',{role:'leader',stopReason:'completed'}),own('run-end',{role:'leader',stopReason:'completed'}),
]}
const native=()=>({parentSession:'owner-session',preset:'team-worker',routes:[{provider:'deepseek-account',model:'deepseek-flash'}],ends:['completed'],catalogs:[['read','write','edit']]})
const evaluate=(events=fixture(),more={})=>evaluateCliRun({events,runId:root,requireWorkers:true,requireLeaderWrite:true,expectedRoutes:['fast'],inspectNative:native,...more})
const result=(report,label)=>report.checks.find(c=>c.label===label)?.status

test('completed CLI and independently matching native worker records pass',()=>{
 const report=evaluate();assert.equal(report.verdict,'PASS');assert.equal(report.workers.length,1)
})
test('CLI completed cannot hide a failed worker or later activation',()=>{
 const events=fixture();events.find(e=>e.kind==='worker-end').state='error'
 events.push({kind:'provider-active',version:'later-reload'})
 const report=evaluate(events);assert.equal(report.verdict,'FAIL');assert.equal(result(report,'all dispatched workers completed'),'FAIL')
})
test('model name and final text alone are not real CLI evidence',()=>{
 const report=evaluate(fixture().filter(e=>!['cli-start','cli-result','cli-end'].includes(e.kind)))
 assert.equal(report.verdict,'INSUFFICIENT')
})
test('native worker without DSH session evidence is insufficient, not pass',()=>{
 const report=evaluate(fixture(),{inspectNative:()=>undefined})
 assert.equal(report.verdict,'INSUFFICIENT')
})
test('Claude worker must have its own CLI run, never native spawn',()=>{
 const events=fixture();Object.assign(events.find(e=>e.kind==='worker-start'),{route:'frontend',provider:'spawn'})
 const report=evaluate(events,{expectedRoutes:['frontend']})
 assert.equal(result(report,'Claude workers use verified CLI runs'),'FAIL')
})
test('a proper CC child uses an owned external CLI chain',()=>{
 const events=fixture();Object.assign(events.find(e=>e.kind==='worker-start'),{route:'frontend',provider:'secretary-cc-worker'})
 for(const kind of ['run-start','cli-start','cli-result','cli-end','run-end'])events.push({kind,runId:child,role:'worker',provider:'secretary-cc-worker',ownerId:'owner-session',model:'claude-opus-5-5',cliVersion:'2.1.198',stopReason:'completed'})
 assert.equal(evaluate(events,{expectedRoutes:['frontend']}).verdict,'PASS')
})
test('native worker wrong parent, wrong preset or Claude route fails',()=>{
 for(const bad of [{parentSession:'forged'},{preset:'secretary-standard'},{routes:[{provider:'xindupx',model:'claude-opus-5-5'}]}]){
  assert.equal(evaluate(fixture(),{inspectNative:()=>({...native(),...bad})}).verdict,'FAIL')
 }
})
test('missing expected route cannot be fabricated from another run',()=>{
 const events=fixture();events.push({kind:'worker-start',runId:'unrelated',route:'backend',provider:'spawn',taskId:'x',childId:'other'})
 const report=evaluate(events,{expectedRoutes:['fast','backend']})
 assert.equal(result(report,'requested worker routes were exercised'),'FAIL')
})
test('no-worker leader is allowed unless worker evidence is requested',()=>{
 const events=fixture().filter(e=>!e.kind.startsWith('worker-'))
 assert.equal(evaluate(events,{requireWorkers:false,expectedRoutes:[]}).verdict,'PASS')
 assert.equal(evaluate(events).verdict,'FAIL')
})
test('cleanup failures and unmatched worker events cannot pass',()=>{
 for(const event of [own('worker-cleanup-error',{taskId:'ds'}),own('worker-start-error',{taskId:'other'}),own('worker-end',{taskId:'forged',childId:'unowned',state:'completed'})]){
  assert.equal(evaluate([...fixture(),event]).verdict,'FAIL')
 }
})
