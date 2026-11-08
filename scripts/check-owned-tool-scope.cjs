// OFFLINE integration using installed Cordis + official tool-subagent + scope.
// No running Host connection, no CLI/model, no credentials, no persistent writes.
const assert=require('node:assert/strict'),path=require('node:path');
const{createRequire}=require('node:module');const{pathToFileURL}=require('node:url');
const host=path.join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/app.asar/dsh/package.json');
const requireHost=createRequire(host);const load=spec=>import(pathToFileURL(requireHost.resolve(spec)).href);
(async()=>{
 const {Context,Service}=await load('@deepseek-ai/cordis');
 const {createScope,scopeOf}=await load('@deepseek-ai/dsh-scope');
 const official=await load('@deepseek-ai/dsh-tool-subagent');
 const own=await import(pathToFileURL(path.resolve(__dirname,'../preset/delegation.mjs')).href);
 assert.equal(typeof own.ownedToolPlugin,'function','production direct-Agent binding factory must exist');
 assert.throws(()=>own.ownedToolPlugin(official,undefined),/DELEGATION_SESSION_REQUIRED/,'missing Session must not silently fall back to the standing installer');
 const root=new Context(),agents=[],definitions=new Map();
 class Tools extends Service {
  constructor(ctx){super(ctx,'tools')}
  register(def){const key=scopeOf(this.ctx);let set=definitions.get(key);if(!set){set=new Map();definitions.set(key,set)};if(set.has(def.name))throw new Error('DUPLICATE_TOOL');return this.ctx.effect(()=>{set.set(def.name,def);return()=>set.delete(def.name)})}
  get(name,key){return definitions.get(key)?.get(name)}
 }
 class Subagents extends Service {
  constructor(ctx){super(ctx,'subagents')}
  getProvider(name){return {name,inheritsParentContext:false,capabilities:{agentPreset:true,agentOptions:true,depthLimit:true}}}
  resolveMaxDepth(value){return value==='provider-managed'?undefined:value}
 }
 class SystemPrompt extends Service {
  constructor(ctx){super(ctx,'systemPrompt')}
  getSectionOrder(){return 0}getContextOrder(){return 0}
  section(){return this.ctx.effect(()=>()=>{})}context(){return this.ctx.effect(()=>()=>{})}
 }
 class Projections extends Service {constructor(ctx){super(ctx,'sessionProjections')}register(){return this.ctx.effect(()=>()=>{})}}
 class Presets extends Service {constructor(ctx){super(ctx,'agentPresets')}async readDocument(id){return {id,description:'offline fixture'}}}
 class Agents extends Service {constructor(ctx){super(ctx,'agents')}list(){return agents}}
 new Tools(root);new Subagents(root);new SystemPrompt(root);new Projections(root);new Presets(root);new Agents(root);
 const config=official.Config({provider:'spawn',toolName:'fixture_worker',agentOptions:{provider:'moeblack',model:'gpt-6-astra'},agentPreset:'team-worker',allowedAgentPresets:['team-worker'],maxDepth:2});
 const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
 async function exercise(direct){
  const agent={id:direct?'owned-agent':'standing-control',session:{header:{id:'fixture-session'}}};
  const scope=createScope(root,agent);agent.ctx=scope.ctx;agents.push(agent);
  const module=direct?own.ownedToolPlugin(official,agent.session):official;
  const wrapper=agent.ctx.plugin(module,config);const fiber=await wrapper;await flush();
  assert.ok(definitions.get(agent)?.has('fixture_worker'),'tool mounted on exact scope');
  await fiber.dispose();await flush();
  const remains=definitions.get(agent)?.has('fixture_worker')??false;
  if(direct)assert.equal(remains,false,'disposing owned wrapper must remove actual registration');
  else assert.equal(remains,true,'negative control: standing installer leaves its sibling registration');
  await scope.dispose();await flush();
  assert.equal(definitions.get(agent)?.size??0,0,'scope teardown removes every registration');
  agents.splice(agents.indexOf(agent),1);
  console.log('PASS '+(direct?'direct-Agent wrapper owns actual tool disposal':'old standing path reproduced sibling-fiber residual (negative control)'));
 }
 try {await exercise(false);await exercise(true);console.log('RESULT: OK (real Cordis/official plugin, isolated fixture services)')}
 finally {await root.fiber.dispose()}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
