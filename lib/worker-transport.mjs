import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

// One listener and capability per CLI run. Never shares the GUI/API auth token.
export async function startBrokerServer({ broker }) {
  const token=randomBytes(32).toString('hex')
  const expected=Buffer.from(`Bearer ${token}`)
  const methods={dispatch_worker:'dispatch',worker_status:'status',wait_worker:'wait',cancel_worker:'cancel'}
  let revoked=false, active=0, closing
  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}}
    if(revoked) return send(410,{error:'RUN_CLOSED'})
    if(req.headers.origin !== undefined) return send(403,{error:'ORIGIN_DENIED'})
    if(req.method!=='POST'||req.url!=='/rpc') return send(404,{error:'NOT_FOUND'})
    const auth=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'')
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected)) return send(401,{error:'UNAUTHORIZED'})
    if(req.headers.host!==`127.0.0.1:${server.address().port}`) return send(403,{error:'HOST_DENIED'})
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')) return send(415,{error:'JSON_REQUIRED'})
    if(Number(req.headers['content-length']??0)>65536) return send(413,{error:'TOO_LARGE'})
    if(active>=16) return send(429,{error:'REQUEST_LIMIT'})
    active++
    try {
      const chunks=[];let size=0
      for await(const chunk of req){size+=chunk.length;if(size>65536){send(413,{error:'TOO_LARGE'});return}chunks.push(chunk)}
      let body
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'INVALID_JSON'})}
      if(!body||typeof body!=='object'||!Object.hasOwn(methods,body.method)||Object.keys(body).some(k=>!['method','arguments'].includes(k))) return send(400,{error:'UNKNOWN_METHOD'})
      if(revoked) return send(410,{error:'RUN_CLOSED'})
      send(200,await broker[methods[body.method]](body.arguments??{}))
    }catch(error){
      // Only our fixed uppercase codes may cross this boundary. Never serialize
      // credentials, a thrown provider error, stack, or arbitrary process output.
      const code=/^[A-Z_]{1,64}$/.test(error?.message??'')?error.message:'BROKER_ERROR'
      send(400,{error:code})
    }finally{active--}
  })
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=1000
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
  return {token,url:`http://127.0.0.1:${server.address().port}/rpc`,close(){
    revoked=true
    closing??=new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections()})
    return closing
  }}
}
