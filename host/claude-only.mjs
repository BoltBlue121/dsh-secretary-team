// Covers ordinary DSH AgentLoop (including cold resume) and llm.stream calls.
// Not a sandbox against arbitrary trusted Host code or direct HTTP from a shell.
export const name='secretary-claude-code-only'
export const inject=['llm']
export function isNativeClaude(config){
  // Explicit API models opt into their DSH provider; ordinary Claude stays CLI-only.
  if(config?.provider!=='workbench-claude-cli' && /^\[api\]claude[-a-z0-9.]+$/i.test(String(config?.model??'')))return false
  return /claude|(?:^|[/_-])(?:opus|sonnet|haiku)(?:$|[/_-])/i.test(String(config?.model??'')) || /^anthropic$/i.test(String(config?.provider??''))
}
function assertRoute(config){
  if(isNativeClaude(config)){
    const error=new Error('CLAUDE_CODE_REQUIRED: Claude agents must run through the Claude Code CLI provider. Use delegate_claude_code in a normal session, or delegate_leader / delegate_worker_frontend in the secretary team. Native Claude API fallback is disabled.')
    error.code='CLAUDE_CODE_REQUIRED'
    throw error
  }
}
export function apply(ctx){
  // Optional companion owns a real CLI adapter. Without its live Cordis
  // service the original refuse-native policy remains in force.
  const companion=()=>ctx.get?.('workbenchClaudeLink')
  ctx.on('agent/request',async(_payload,next)=>{
    const config=await next()
    if(isNativeClaude(config)&&companion())return companion().select(config)
    assertRoute(config);return config
  },{prepend:true})
  ctx.on('llm/stream',async function*(options,next){
    if(isNativeClaude(options)&&companion()){
      if(!companion().owns(options)){yield* ctx.llm.stream(companion().select(options));return}
    }else{assertRoute(options)}
    yield* next()
  },{prepend:true})
}
