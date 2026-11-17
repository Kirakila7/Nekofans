'use strict';
const http=require('node:http'),{randomBytes,randomUUID,timingSafeEqual}=require('node:crypto');
const MODEL='deepseek-flash';
function convertRequest(body){
 if(!body||body.model!==MODEL||!Array.isArray(body.messages)||!body.messages.length||body.messages.length>52||body.tools||body.functions||body.tool_choice||body.function_call)throw Error('记忆模型请求无效');
 const system=[],messages=[];
 for(const message of body.messages){if(!message||!['system','developer','user','assistant'].includes(message.role)||typeof message.content!=='string')throw Error('记忆模型消息无效');if(['system','developer'].includes(message.role))system.push(message.content);else messages.push({role:message.role,text:message.content});}
 if(!messages.length||messages.at(-1).role!=='user'||!messages.at(-1).text.trim()||messages.some(m=>m.text.length>32000)||messages.reduce((n,m)=>n+m.text.length,0)>64000||system.join('\n').length>60000)throw Error('记忆模型上下文无效或过长');
 if(body.response_format){if(!['json_object','json_schema'].includes(body.response_format.type))throw Error('记忆模型输出格式无效');const schema=JSON.stringify(body.response_format);if(schema.length>4000)throw Error('记忆输出结构过大');system.push('只输出有效 JSON，不使用 Markdown。所需输出结构：'+schema);}
 const maxTokens=body.max_completion_tokens??body.max_tokens??2048;if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>32000)throw Error('记忆模型输出长度无效');
 return {system:system.join('\n\n'),messages,maxTokens,stream:body.stream===true};
}
function createMemoryAccountRelay({provider,isCurrent=()=>true,timeoutMs=90000}){
 let current=null,starting=null,epoch=0,tail=Promise.resolve();const jobs=new Set();
 const allowed=()=>isCurrent()===true;
 function send(res,status,body){if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}}
 async function handle(req,res,state){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);jobs.add(controller);res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
   if(!allowed()||current!==state)return send(res,503,{error:{message:'记忆账号通道已切换或关闭'}});
   const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+state.token);
   if(req.headers.origin||actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(res,401,{error:{message:'记忆通道身份无效'}});
   if(req.method!=='POST'||req.url!=='/v1/chat/completions')return send(res,404,{error:{message:'不支持此记忆接口'}});
   if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(res,400,{error:{message:'需要 JSON 请求'}});
   let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256*1024)return send(res,413,{error:{message:'记忆请求过大'}});chunks.push(chunk);}
   let input;try{input=convertRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return send(res,400,{error:{message:'记忆请求格式无效'}});}
   const run=async()=>{
    if(controller.signal.aborted||!allowed()||current!==state)throw Error('记忆请求已取消');
    const status=await provider.status();if(status.status!=='signed-in')throw Error('请先登录 DeepSeek 工作台账号');
    const id='memory-'+randomUUID();let text='';
    const request={persona:{id:'bigfish-memory',prompt:input.system},messages:input.messages.map(m=>({...m,personaId:'bigfish-memory',conversationId:id})),memories:[],summaries:[],memoryContext:[],maxOutputTokens:input.maxTokens,signal:controller.signal};
    for await(const chunk of provider.stream(request)){if(chunk.type==='delta')text+=chunk.text;if(text.length>128000)throw Error('记忆模型回复过长');}
    if(controller.signal.aborted||!allowed()||current!==state||!text.trim())throw Error('记忆请求未完成');return text;
   };
   const result=tail.catch(()=>{}).then(run);tail=result;const text=await result,id='chatcmpl-'+randomUUID(),created=Math.floor(Date.now()/1000);
   if(!input.stream)return send(res,200,{id,object:'chat.completion',created,model:MODEL,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});
   if(!res.destroyed){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:MODEL,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:MODEL,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}
  }catch{send(res,503,{error:{message:'DeepSeek 账号记忆整理暂不可用，请检查登录或稍后重试'}});}finally{clearTimeout(timer);jobs.delete(controller);}
 }
 return {start(){if(current)return Promise.resolve({...current.model});if(starting)return starting;const generation=epoch;
  starting=(async()=>{if(!provider||typeof provider.status!=='function'||typeof provider.stream!=='function')throw Error('记忆账号通道尚未接入');const status=await provider.status();if(status.status!=='signed-in')throw Error(status.status==='signed-out'?'请先登录 DeepSeek 工作台账号':'DeepSeek 账号通道尚未就绪，请稍后重试');if(!allowed()||generation!==epoch)throw Error('记忆账号通道已取消');
   const state={token:randomBytes(32).toString('hex')};state.server=http.createServer((req,res)=>void handle(req,res,state));state.server.requestTimeout=timeoutMs;state.server.headersTimeout=10000;
   await new Promise((resolve,reject)=>{state.server.once('error',reject);state.server.listen(0,'127.0.0.1',resolve);});if(!allowed()||generation!==epoch){await new Promise(r=>state.server.close(r));throw Error('记忆账号通道已取消');}
   state.model={protocol:'openai-compatible',baseUrl:'http://127.0.0.1:'+state.server.address().port+'/v1',model:MODEL,apiKey:state.token,requestTimeoutMs:timeoutMs};current=state;return {...state.model};
  })().finally(()=>starting=null);return starting;
 },async stop(){epoch++;const state=current;current=null;for(const job of jobs)job.abort();if(state)await new Promise(resolve=>{state.server.close(resolve);state.server.closeAllConnections();});}};
}
module.exports={createMemoryAccountRelay,convertRequest};
