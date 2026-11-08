// Offline check using the installed Desktop's exact schemas and an isolated
// Cordis fixture. Never mounts a plugin into the running Host.
const path=require('node:path');const fs=require('node:fs');const{createRequire}=require('node:module');const{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const host=path.join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/app.asar/dsh/package.json');
process.argv[1]=host;
(async()=>{
 const requireHost=createRequire(host);
 const yaml=require('G:/DSH-Platform-Hub/system/runtimes/dsh-0.1.5-alpha.1/node_modules/js-yaml');
 const patch=yaml.load(fs.readFileSync(path.join(root,'cordis.host.yml'),'utf8'));
 const row=patch.flatMap(p=>p.insert??[]).find(r=>r.id==='secretary-team-cc-runtime');
 const runtime=await import(pathToFileURL(path.join(root,'host/claude-code.mjs')).href);
 const config=runtime.Config(row.config);
 if(config.model!=='claude-opus-5-5')throw new Error('Wrong fixed model');
 console.log('PASS exact Host Schema accepts Claude Code runtime config');
 const sub=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-tool-subagent')).href);
 const routes=await import(pathToFileURL(path.join(root,'preset/delegation.mjs')).href);
 let total=0;
 for(const preset of ['secretary-standard','secretary-cordis','team-leader','team-leader-cordis'])for(const tool of routes.toolsFor(preset)){sub.Config(routes.toolConfig(tool));total++}
 console.log(`PASS exact Host tool-subagent Schema accepts ${total} native/external bindings`);
 const scopeCheck=require('node:child_process').spawnSync(process.execPath,[path.join(root,'scripts/check-owned-tool-scope.cjs')],{env:process.env,stdio:'inherit'});
 if(scopeCheck.status!==0)throw new Error('Official scope integration check failed');
 console.log('RESULT: OK (offline schemas and isolated Cordis only; no running Host apply)');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
