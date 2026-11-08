import test from 'node:test'
import assert from 'node:assert/strict'
import { toolsFor, toolConfig, keyFor } from '../preset/delegation.mjs'

test('every Claude team role is bound to a real CLI backend',()=>{
 for(const [preset,expected] of [['secretary-standard','secretary-cc-leader'],['secretary-cordis','secretary-cc-leader-cordis']]){
  const config=toolConfig(toolsFor(preset).find(t=>t.toolName==='delegate_leader'))
  assert.equal(config.provider,expected)
  assert.equal(config.maxDepth,'provider-managed')
  assert.equal(config.agentOptions,undefined)
  assert.equal(config.agentPreset,undefined)
 }
 for(const preset of ['team-leader','team-leader-cordis']){
  const config=toolConfig(toolsFor(preset).find(t=>t.toolName==='delegate_worker_frontend'))
  assert.equal(config.provider,'secretary-cc-worker')
  assert.equal(config.agentOptions,undefined)
 }
})
test('DS/GPT/Gemini retain native routes and appropriate worker presets',()=>{
 const configs=toolsFor('team-leader-cordis').map(toolConfig)
 for(const name of ['fast','stable','backend','writing']){
  const config=configs.find(t=>t.toolName===`delegate_worker_${name}`)
  assert.equal(config.provider,'spawn')
  assert.equal(config.agentPreset,'team-worker-cordis')
  assert.doesNotMatch(config.agentOptions.model,/claude|opus/i)
 }
})
test('mount identity changes for backend and model changes, not only preset',()=>{
 const base={toolName:'delegate_leader',agentPreset:'team-leader',agentOptions:{provider:'xindupx',model:'claude-opus-5-5'}}
 assert.notEqual(keyFor([base]),keyFor([{...base,backend:'secretary-cc-leader',agentOptions:undefined}]))
 assert.notEqual(keyFor([base]),keyFor([{...base,agentOptions:{provider:'moeblack',model:'gpt-6-astra'}}]))
})
