'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {createMemoryAccountRelay}=require('../../apps/neko-workbench/memory-account-relay.cjs');
const {createCompanionAccountProvider}=require('../../apps/neko-workbench/companion-account-provider.cjs');
const {createCompanionAccountBridge}=require('../../apps/neko-workbench/companion-account-bridge.cjs');
const root=path.resolve(__dirname,'../..');
const python=process.env.NEKO_WORKBENCH_MEMORY_PYTHON_DIRECT;
const libs=process.env.NEKO_WORKBENCH_MEMORY_PYTHON_LIBS;

test('bundled Python SDK, native ChatOpenAI and real memory extraction use the isolated account bridge',{
  skip:!python||!libs,timeout:60000,
},async t=>{
  let modelCalls=0;
  const text='[{"text":"合成用户喜欢海边","importance":6,"entity":"master"}]';
  const bridge=createCompanionAccountBridge({
    namespace:'memory',route:{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'},
    ctx:{get:()=>({getState:async()=>({status:'credential-stored'})}),llm:{prepareCall:async config=>({config,
      stream:async function*(input){
        assert.equal(input.tools,undefined);assert.equal(input.sessionId,undefined);
        modelCalls++;yield{type:'text-delta',index:0,text};yield{type:'finish',reason:{kind:'stop'}};
      },
    })}},createUserMessage:v=>({...v,role:'user'}),createAssistantMessage:v=>({...v,role:'assistant'}),
  });
  t.after(()=>bridge.dispose());
  const rpcCalls=[];
  const provider=createCompanionAccountProvider(async(method,input)=>{
    rpcCalls.push(method);
    if(method==='memory-account-status')return bridge.status();
    if(method==='memory-account-chat')return bridge.send(input);
    if(method==='memory-account-cancel')return bridge.cancel(input);
    throw Error('Unexpected RPC');
  },{namespace:'memory'});
  const relay=createMemoryAccountRelay({provider});t.after(()=>relay.stop());
  const model=await relay.start();assert.equal(modelCalls,0);
  const script=`import asyncio,json,site,sys
site.addsitedir(sys.argv[1])
sys.path.insert(0,sys.argv[2])
from openai import OpenAI
from utils.llm_client.openai_client import ChatOpenAI
from utils.llm_client.messages import HumanMessage
cfg=json.loads(sys.stdin.readline())
client=OpenAI(base_url=cfg['baseUrl'],api_key=cfg['apiKey'],max_retries=0,timeout=10)
messages=[{'role':'user','content':'synthetic memory input'}]
one=client.chat.completions.create(model=cfg['model'],messages=messages,max_tokens=1024)
assert json.loads(one.choices[0].message.content)[0]['entity']=='master'
stream=client.chat.completions.create(model=cfg['model'],messages=messages,stream=True,max_completion_tokens=1024)
assert json.loads(''.join(c.choices[0].delta.content or '' for c in stream))[0]['importance']==6
async def native():
    llm=ChatOpenAI(model=cfg['model'],base_url=cfg['baseUrl'],api_key=cfg['apiKey'],max_retries=0,timeout=10)
    result=await llm.ainvoke([HumanMessage(content='synthetic native request')],max_completion_tokens=4096)
    assert json.loads(result.content)[0]['entity']=='master'
asyncio.run(native())
client.close()
print('SDK_NATIVE_OK')
`;
  const child=spawn(python,['-B','-c',script,libs,path.join(root,'services/neko-memory/vendor')],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'},
  });
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  child.stdin.end(JSON.stringify(model)+'\n');
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,stderr.slice(-2500));assert.match(stdout,/SDK_NATIVE_OK/);assert.equal(modelCalls,3);

  const {NekoMemoryWorker}=await import(pathToFileURL(path.join(root,'apps/neko-workbench/memory/neko-adapter.mjs')));
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'memory-account-native-'));
  const worker=new NekoMemoryWorker({repositoryRoot:root,dataRoot,getModel:async()=>model,
    getPersona:async()=>({name:'大肥鱼',prompt:'仅使用合成测试材料'}),startupTimeoutMs:30000});
  t.after(async()=>{await worker.close();fs.rmSync(dataRoot,{recursive:true,force:true});});
  await worker.ensure();assert.equal((await worker.request('/health')).ready,true);assert.equal(modelCalls,3);
  const event={eventId:'synthetic-memory-account',itemId:'synthetic-episode',personaId:'bigfish',origin:'user',
    operation:'upsert',parents:[],occurredAt:'2026-11-04T00:00:00Z',
    value:{kind:'episode',text:'合成用户原话：我喜欢海边。',visibility:'private',certainty:'inferred',evidenceRefs:['synthetic-user-message']}};
  const pushed=await worker.request('/push',{personaId:'bigfish',events:[event]},30000);
  assert(pushed.ackedEventIds.includes(event.eventId));assert(modelCalls>3);
  const pulled=await worker.request('/pull?cursor=0');
  assert(pulled.events.some(e=>e.value?.text==='合成用户喜欢海边'));
  assert(rpcCalls.every(method=>method.startsWith('memory-account-')));
});
