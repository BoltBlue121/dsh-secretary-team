import test from 'node:test'
import assert from 'node:assert/strict'
import { startBrokerServer } from '../lib/worker-transport.mjs'
import { createMcpHandler } from '../lib/worker-mcp.mjs'

test('loopback bridge requires exact capability and rejects web origins', async () => {
  let calls=0
  const server=await startBrokerServer({ broker:{dispatch:async args=>{calls++;return {id:args.task_id}},status:()=>({state:'running'}),wait:async()=>({state:'completed'}),cancel:async()=>({state:'aborted'})} })
  const send=(headers={},body={method:'dispatch_worker',arguments:{task_id:'x'}})=>fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  try {
    assert.equal((await send()).status,401)
    assert.equal((await send({Authorization:'Bearer wrong'})).status,401)
    assert.equal((await send({Authorization:`Bearer ${server.token}`,Origin:'https://evil.test'})).status,403)
    assert.equal((await send({Authorization:`Bearer ${server.token}`},{method:'any_service',arguments:{}})).status,400)
    const response=await send({Authorization:`Bearer ${server.token}`})
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{id:'x'}); assert.equal(calls,1)
  } finally { await server.close() }
})
test('oversized requests and wrong path never call broker', async () => {
  const server=await startBrokerServer({broker:{dispatch:()=>assert.fail('must not dispatch')}})
  try {
    const headers={Authorization:`Bearer ${server.token}`,'Content-Type':'application/json'}
    assert.equal((await fetch(server.url+'/other',{method:'POST',headers,body:'{}'})).status,404)
    assert.equal((await fetch(server.url,{method:'POST',headers,body:'x'.repeat(70000)})).status,413)
  } finally {await server.close()}
})
test('MCP exposes only bounded worker actions and initialization is local', async () => {
  const seen=[]
  const handler=createMcpHandler({call:async(name,args)=>{seen.push([name,args]);return {state:'completed'}}})
  const init=await handler({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}})
  assert.equal(init.result.protocolVersion,'2025-03-26')
  const list=await handler({jsonrpc:'2.0',id:2,method:'tools/list'})
  assert.deepEqual(list.result.tools.map(t=>t.name).sort(),['cancel_worker','dispatch_worker','wait_worker','worker_status'])
  assert.equal(await handler({jsonrpc:'2.0',method:'notifications/initialized'}),undefined)
  assert.equal(seen.length,0)
  const result=await handler({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'wait_worker',arguments:{id:'a',timeout_ms:1000}}})
  assert.equal(result.result.structuredContent.state,'completed')
  assert.deepEqual(seen,[['wait_worker',{id:'a',timeout_ms:1000}]])
  const denied=await handler({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'shell',arguments:{command:'x'}}})
  assert.equal(denied.result.isError,true); assert.equal(seen.length,1)
})
