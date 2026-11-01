'use strict';
// Per-worker, loopback-only compatibility adapter. It never owns account secrets.
const http=require('node:http');
const {randomBytes,timingSafeEqual,randomUUID}=require('node:crypto');
function createMemoryAccountProxy({invoke,timeoutMs=30000}){
  if(typeof invoke!=='function')throw Error('记忆账号通道不可用');
  const token=randomBytes(32).toString('hex');let server,starting,closed=false,active=null;
  const send=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  const fail=(res,status)=>send(res,status,{error:{message:'记忆模型请求未完成',type:'request_error'}});
  async function handler(req,res){
    const auth=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.origin||auth.length!==expected.length||!timingSafeEqual(auth,expected)){req.resume();return fail(res,403);}
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'||req.headers['content-type']?.split(';')[0]!=='application/json'){req.resume();return fail(res,404);}
    const chunks=[];let size=0;
    try {for await(const chunk of req){size+=chunk.length;if(size>512*1024){req.destroy();return;}chunks.push(chunk);}}catch{return;}
    if(closed||active)return fail(res,503);
    let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail(res,400);}chunks.length=0;
    const allowed=new Set(['model','messages','stream','max_tokens','max_completion_tokens']);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.has(k))||value.model!=='neko-account-memory'||(value.stream!==undefined&&value.stream!==false)||!Array.isArray(value.messages)||!value.messages.length||value.messages.length>50)return fail(res,400);
    if(value.messages.some(m=>!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()||m.content.length>150000||Object.keys(m).some(k=>!['role','content'].includes(k)))||value.messages.reduce((n,m)=>n+m.content.length,0)>200000)return fail(res,400);
    const limit=value.max_completion_tokens??value.max_tokens??4096;
    if(!Number.isSafeInteger(limit)||limit<1||limit>32000)return fail(res,400);
    const abort=new AbortController(),id='memory-'+randomUUID();active={abort,id};
    const timer=setTimeout(()=>abort.abort(),timeoutMs);
    const interrupted=()=>abort.abort();res.once('close',interrupted);
    try{
      const interruptedResult=new Promise((_,reject)=>{if(abort.signal.aborted)return reject(Error('cancelled'));abort.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});
      const result=await Promise.race([invoke({requestId:id,messages:value.messages,maxTokens:limit,signal:abort.signal}),interruptedResult]);
      if(abort.signal.aborted||closed||typeof result!=='string'||!result.trim()||result.length>128000)return fail(res,503);
      send(res,200,{id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:'neko-account-memory',choices:[{index:0,message:{role:'assistant',content:result},finish_reason:'stop'}]});
    }catch{fail(res,503);}finally{clearTimeout(timer);res.removeListener('close',interrupted);if(active?.id===id)active=null;}
  }
  return {
    async start(){if(closed)throw Error('记忆账号通道已关闭');if(!starting){server=http.createServer((req,res)=>{void handler(req,res).catch(()=>fail(res,500));});server.headersTimeout=10000;server.requestTimeout=30000;starting=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}await starting;if(closed||!server?.address())throw Error('记忆账号通道已关闭');return {protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'neko-account-memory',apiKey:token};},
    async close(){closed=true;active?.abort.abort();await starting?.catch(()=>{});if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});server=null;}
  };
}
module.exports={createMemoryAccountProxy};
