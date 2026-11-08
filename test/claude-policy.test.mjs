import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../host/claude-only.mjs'
const boot=()=>{const handlers=new Map();apply({on:(name,fn)=>{handlers.set(name,fn);return()=>{}}});return handlers}

test('native Claude request is rejected before accepting a model config',async()=>{
 const h=boot();let next=0
 for(const model of ['claude-opus-5-5','claude-sonnet-4','opus','anthropic/claude-haiku']){
   await assert.rejects(h.get('agent/request')({},async()=>{next++;return {provider:'xindupx',model}}),/CLAUDE_CODE_REQUIRED/)
 }
 assert.equal(next,4)
})
test('raw and prepared stream calls cannot fall back to a Claude adapter',async()=>{
 const h=boot();let called=0
 const next=async function*(){called++;yield {type:'text-delta',text:'bad'}}
 await assert.rejects(async()=>{for await(const chunk of h.get('llm/stream')({provider:'xindupx',model:'claude-opus-5-5'},next)){}},/CLAUDE_CODE_REQUIRED/)
 assert.equal(called,0)
})
test('DeepSeek/GPT traffic passes unchanged',async()=>{
 const h=boot()
 for(const config of [{provider:'deepseek-account',model:'deepseek-flash'},{provider:'moeblack',model:'gpt-6-astra'}]){
   assert.equal(await h.get('agent/request')({},async()=>config),config)
   const value={type:'text-delta',text:'ok'}
   const seen=[];for await(const chunk of h.get('llm/stream')(config,async function*(){yield value}))seen.push(chunk)
   assert.equal(seen[0],value)
 }
})
