'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
const {createCompanionAccountProvider}=require('../../apps/neko-workbench/companion-account-provider.cjs');
const {createCompanionAccountBridge}=require('../../apps/neko-workbench/companion-account-bridge.cjs');
const {providerGetter,runModel}=require('../../apps/neko-workbench/lobby-cat.cjs');
const root=path.resolve(__dirname,'../..');
const route={provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function host(){
  const calls=[],rpcCalls=[];let status='credential-stored';
  const waits=new Map();
  const ctx={get:key=>key==='deepseekAccount'?{getState:async()=>({status,token:'never-projected'})}:null,
    llm:{prepareCall:async(config,signal)=>{calls.push({config,signal});return {config,stream:async function*(input){
      calls.at(-1).input=input;
      if(input.messages[0].content[0].text.startsWith('hold-'))await new Promise(resolve=>{waits.set(input.messages[0].content[0].text,resolve);input.signal.addEventListener('abort',resolve,{once:true});});
      if(input.signal.aborted){yield {type:'finish',reason:{kind:'aborted'}};return;}
      yield {type:'text-delta',index:0,text:input.system.includes('公共')?'公开回复':'私聊回复'};yield {type:'finish',reason:{kind:'stop'}};
    }};}}};
  const args={ctx,route,createUserMessage:x=>({...x,role:'user'}),createAssistantMessage:x=>({...x,role:'assistant'})};
  const privateBridge=createCompanionAccountBridge(args),publicBridge=createCompanionAccountBridge({...args,namespace:'lobby'});
  const rpc=async(method,p={})=>{rpcCalls.push({method,p});const target=method.startsWith('lobby-')?publicBridge:privateBridge;
    if(method.endsWith('-status'))return target.status();if(method.endsWith('-chat'))return target.send(p);if(method.endsWith('-cancel'))return target.cancel(p);throw Error('invalid RPC');};
  return {calls,rpcCalls,privateBridge,publicBridge,rpc,waits,setStatus:value=>{status=value;},dispose:()=>{privateBridge.dispose();publicBridge.dispose();}};
}
function runtimeFixture(t,h){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lobby-account-route-'));
  const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:x=>Buffer.from('fixture:'+x),decryptString:x=>x.toString().slice(8)};
  const runtime=new WorkbenchMainChat({dataDir:directory,repositoryRoot:root,safeStorage,initialBackend:'deepseek-account',
    accountProvider:createCompanionAccountProvider(h.rpc),lobbyAccountProvider:createCompanionAccountProvider(h.rpc,{namespace:'lobby'}),
    environmentContext:()=> 'PRIVATE-HOME-OBJECT',memoryWorker:{request:async()=>{throw Error('fixture offline');},stop:async()=>{},close:async()=>{}}});
  t.after(async()=>{await runtime.close();h.dispose();fs.rmSync(directory,{recursive:true,force:true});});return runtime;
}
const publicInput=(text='公共频道内容')=>({persona:{id:'bigfish',prompt:'公共身份'},text,maxOutputTokens:123});

test('DeepSeek account route is available after verified login and public generation never enters private history',async t=>{
  const h=host(),runtime=runtimeFixture(t,h);await runtime.start();
  assert.equal((await runtime.send('PRIVATE-USER-SECRET')).status,'completed');
  const history=await runtime.history();
  assert.equal(runtime.lobbyProviderState().available,false,'unverified account is not advertised as available');
  await runtime.refreshLobbyAccount();assert.equal(runtime.lobbyProviderState().available,true);
  let apiUsed=false;const provider=providerGetter({runtime,createChatApiProvider:()=>{apiUsed=true;throw Error('no API fallback');}})();
  assert.equal(await runModel(provider,publicInput()),'公开回复');
  assert.equal(apiUsed,false);assert.deepEqual(await runtime.history(),history);
  const publicCalls=h.rpcCalls.filter(x=>x.method==='lobby-account-chat');assert.equal(publicCalls.length,1);
  assert.deepEqual(publicCalls[0].p.history,[]);assert.equal(publicCalls[0].p.text,'公共频道内容');
  assert(!JSON.stringify(publicCalls).includes('PRIVATE-USER-SECRET'));assert(!JSON.stringify(publicCalls).includes('PRIVATE-HOME-OBJECT'));
  assert.deepEqual(h.calls.map(x=>({provider:x.config.provider,model:x.config.model,effort:x.config.reasoningEffort})),[0,1].map(()=>({provider:route.provider,model:route.model,effort:route.reasoningEffort})));
  assert(h.calls.every(x=>!x.input.tools&&!x.input.sessionId));
  assert(!JSON.stringify(runtime.lobbyProviderState()).includes('token'));
});

test('missing login, unavailable owner and route changes fail closed without using another API key',async t=>{
  const h=host(),runtime=runtimeFixture(t,h);await runtime.start();
  h.setStatus('signed-out');await runtime.refreshLobbyAccount({force:true});assert.equal(runtime.lobbyProviderState().reason,'account-signed-out');
  assert.equal(providerGetter({runtime})(),null);assert.equal(h.calls.length,0);
  h.setStatus('checking');await runtime.refreshLobbyAccount({force:true});assert.equal(runtime.lobbyProviderState().reason,'account-unavailable');
  h.setStatus('credential-stored');await runtime.refreshLobbyAccount({force:true});const old=providerGetter({runtime})();
  await runtime.saveApi({protocol:'openai-compatible',baseUrl:'https://model.example.invalid/v1',model:'same-api-model',requestTimeoutMs:5000,maxOutputTokens:256,key:{action:'replace',value:'synthetic-private-api-key'}});
  await assert.rejects(runModel(old,publicInput()),{code:'provider_changed'});
  const configs=[];const current=providerGetter({runtime,createChatApiProvider:config=>{configs.push(config);return {async *stream(){yield {type:'delta',text:'API回复'};yield {type:'complete'};}};}})();
  assert.equal(await runModel(current,publicInput()),'API回复');assert.equal(configs[0].config.model,runtime.settings.model);
  assert.equal(await configs[0].getApiKey(),'synthetic-private-api-key');assert.equal(h.calls.length,0);
  await runtime.selectBackend('neko');assert.equal(providerGetter({runtime})(),null);
});

test('public and private account requests have separate locks, cancellation, context, and the same credit route',async()=>{
  const h=host();try{
    const privateRun=h.privateBridge.send({requestId:'companion-held',text:'hold-private',context:'PRIVATE-CONTEXT',history:[],maxTokens:123});
    while(!h.waits.has('hold-private'))await tick();
    const publicRun=h.publicBridge.send({requestId:'lobby-held',text:'hold-public',context:'公共身份',history:[],maxTokens:123});
    while(!h.waits.has('hold-public'))await tick();
    assert.deepEqual(h.publicBridge.cancel({requestId:'companion-held'}),{accepted:false});
    assert.deepEqual(h.privateBridge.cancel({requestId:'lobby-held'}),{accepted:false});
    h.publicBridge.cancel({requestId:'lobby-held'});await assert.rejects(publicRun,/取消/);
    assert.equal(h.calls[0].signal.aborted,false,'canceling the public request never cancels the private turn');
    h.waits.get('hold-private')();assert.deepEqual(await privateRun,{text:'私聊回复'});
    assert.deepEqual(h.calls.map(x=>x.config),[{...route,maxTokens:123},{...route,maxTokens:123}]);
    assert(h.calls[1].input.messages.every(x=>!JSON.stringify(x).includes('PRIVATE')));assert(!h.calls[1].input.system.includes('PRIVATE'));
    await assert.rejects(h.publicBridge.send({requestId:'companion-forged',text:'public',maxTokens:10}),/内容无效/);
    await assert.rejects(h.publicBridge.send({requestId:'lobby-forged',text:'public',history:[{role:'user',text:'PRIVATE'}],maxTokens:10}),/私聊历史/);
  }finally{h.dispose();}
});

test('public adapter only accepts its fixed namespace and isolated public input; status never prepares a model',async()=>{
  const h=host();try{
    assert.throws(()=>createCompanionAccountProvider(h.rpc,{namespace:'arbitrary'}),/namespace/);
    const p=createCompanionAccountProvider(h.rpc,{namespace:'lobby'});assert.deepEqual(await p.status(),{status:'signed-in'});assert.equal(h.calls.length,0);
    for(const messages of [[{role:'user',text:'private',conversationId:'private'}],[{role:'user',text:'private',conversationId:'lobby'},{role:'user',text:'extra',conversationId:'lobby'}]]){
      await assert.rejects(async()=>{for await(const event of p.stream({messages,signal:new AbortController().signal,persona:{id:'bigfish'},maxOutputTokens:10})){};},/Public account context/);
    }
    assert.equal(h.rpcCalls.filter(x=>x.method.endsWith('-chat')).length,0);
  }finally{h.dispose();}
});

test('switching the selected route aborts only its public generator and drops a late answer',async()=>{
  const h=host();try{
    const listeners=new Set();const runtime={backend:'deepseek-account',closed:false,lobbyAccountStatus:'signed-in',lobbyProviderEpoch:1,lobbyAccountProvider:createCompanionAccountProvider(h.rpc,{namespace:'lobby'}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
    const old=providerGetter({runtime})();const run=runModel(old,publicInput('hold-public'));
    while(!h.waits.has('hold-public'))await tick();runtime.backend='chat-api';runtime.lobbyProviderEpoch++;for(const fn of listeners)fn();
    await assert.rejects(run,{code:'provider_changed'});assert.equal(h.calls[0].signal.aborted,true);assert.equal(listeners.size,0);
  }finally{h.dispose();}
});

test('account route public memory excludes private and mixed provenance and stops on unsupported backend',async()=>{
  const runtime={closed:false,backend:'deepseek-account',memorySystem:{recall:async()=>[{text:'public',evidenceRefs:['lobby-msg:m1']},{text:'private',evidenceRefs:['chat-msg:m2']},{text:'mixed',evidenceRefs:['lobby-msg:m1','chat-msg:m2']}],recordSharedExperience:async x=>x}};
  const memory=WorkbenchMainChat.prototype.lobbyMemory.call(runtime);assert.deepEqual((await memory.recall('query',100)).map(x=>x.text),['public']);
  assert.deepEqual(await memory.recordSharedExperience({id:'seg-public'}),{id:'seg-public'});runtime.backend='neko';await assert.rejects(memory.recall('query',100));
});
