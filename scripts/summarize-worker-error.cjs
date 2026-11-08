// Read-only narrow diagnostics. Does not emit request payloads or credentials.
const fs=require('node:fs'),zlib=require('node:zlib');
const file=process.argv[2];if(!file)throw new Error('Provide one session log path');
const b=fs.readFileSync(file),magic=Buffer.from([0x28,0xb5,0x2f,0xfd]),starts=[];
for(let p=b.indexOf(magic);p>=0;p=b.indexOf(magic,p+1))starts.push(p);
let text='';for(let i=0;i<starts.length;){let ok=false;for(let j=i+1;j<=starts.length;j++){try{text+=zlib.zstdDecompressSync(b.subarray(starts[i],starts[j]??b.length)).toString('utf8');i=j;ok=true;break}catch{}}if(!ok)i++}
const scrub=s=>String(s).replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi,'[REDACTED]').slice(0,550);
function errors(obj,depth=0){if(!obj||typeof obj!=='object'||depth>4)return;for(const[k,v]of Object.entries(obj)){if(['kind','code','status','statusCode','message','retryable','category'].includes(k)&&['string','number','boolean'].includes(typeof v))console.log(k+': '+scrub(v));else if(v&&typeof v==='object'&&!Array.isArray(v))errors(v,depth+1)}}
for(const line of text.split(/\r?\n/)){let e;try{e=JSON.parse(line)}catch{continue}if(e.type==='request/header'){const c=e.data?.header?.config??{};console.log('route '+c.provider+'/'+c.model+' effort='+c.reasoningEffort)}if(e.type==='turn/end'||e.type==='agent/error'||e.type==='request/error'){console.log(e.type+' @'+e.time);errors(e.data)}}
