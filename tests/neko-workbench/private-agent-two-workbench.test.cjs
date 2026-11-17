'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {once}=require('node:events'),{request}=require('node:http');
const {createPrivateGameRuntime}=require('../../apps/neko-workbench/private-game-runtime.cjs');
const {createPrivateAgentSession}=require('../../apps/neko-workbench/private-agent-session.cjs');
const root=path.resolve(__dirname,'../..'),origin='https://fixture.trycloudflare.com';
test('two local workbenches join by invitation, submit private rules and switch between agents and manual play',async t=>{
 const {createPrivateTrial}=await import('../../services/nekofans-game-hub/private-trial/server.mjs');
 const dirs=[0,1].map(()=>fs.mkdtempSync(path.join(os.tmpdir(),'neko-agent-integration-')));
 const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:s=>Buffer.from('encrypted:'+s),decryptString:b=>b.toString().slice(10)};
 let base;
 const seenTokens=new Set();let joins=0;
 const fetchImpl=(url,opts={})=>new Promise((resolve,reject)=>{if(url.endsWith('/join'))joins++;if(opts.headers?.authorization)seenTokens.add(opts.headers.authorization.slice(7));const req=request(base+new URL(url).pathname,{method:opts.method||'GET',headers:{...opts.headers,host:new URL(origin).host}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);if(opts.body)req.write(opts.body);req.end();});
 const accountRequests=[[],[]];
 const rpcFor=i=>async(method,input)=>{
  if(['game-account-status','game-player-account-status'].includes(method))return {status:'signed-in'};
  if(['game-account-chat','game-player-account-chat'].includes(method)){
   const value=JSON.parse(input.text);accountRequests[i].push({method,...value});
   return {text:value.view?JSON.stringify({action:i?'b8c6':'g1f3'}):'{"kind":"opponent-piece-ban","piece":"n","turns":1}'};
  }
  if(['game-account-cancel','game-player-account-cancel'].includes(method))return {};throw Error('unexpected route');
 };
 const runtimes=dirs.map((dataDir,i)=>createPrivateGameRuntime({rpc:rpcFor(i),repositoryRoot:root,dataDir,safeStorage,fetchImpl,getOwnPersona:async()=>({id:'pet-'+i,name:'本方主 Agent',prompt:'玩家的本地主 Agent'})}));
 const server=createPrivateTrial({publicOrigin:origin,publicKey:await runtimes[0].publicKey()});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await Promise.all(runtimes.map(x=>x.stop()));await new Promise(resolve=>server.close(resolve));dirs.forEach(d=>fs.rmSync(d,{recursive:true,force:true}));});
 const created=await runtimes[0].create({url:origin}),inviteUrl=created.inviteUrl;
 assert.equal(created.status,'created');assert.equal(runtimes[0].status().connected,true);
 for(const bad of [created.ownerUrl,inviteUrl+'&seat=hidden',inviteUrl.replace('https://','http://')])assert.equal((await runtimes[1].openOwnSeat({inviteUrl:bad})).status,'invalid-invite');
 assert.equal(joins,0);
 assert.equal((await runtimes[0].readSeatView({inviteUrl})).players,1);
 assert.equal((await runtimes[0].submitOwnRule({inviteUrl,text:'尚未入座'})).status,'waiting-for-player');
 for(let i=0;i<2;i++){
  const first=await runtimes[i].openOwnSeat({inviteUrl}),repeat=await runtimes[i].openOwnSeat({inviteUrl});
  assert.deepEqual(first,{status:'paired',seat:i,roomId:created.roomId});assert.deepEqual(repeat,first);
 }
 assert.equal(joins,1);
 const rules=['白方私有测试规则','黑方私有测试规则'];const submitted=await Promise.all(runtimes.map((runtime,i)=>runtime.submitOwnRule({text:rules[i]})));assert.deepEqual(submitted.map(x=>x.status),['ready','ready']);
 const tokens=[...seenTokens];assert.equal(tokens.length,2);
 const seen=[[],[]],moves=['e2e4','e7e5'];const agents=runtimes.map((runtime,i)=>createPrivateAgentSession({repositoryRoot:root,getOwnSeatSession:runtime.getOwnSeatSession,getOwnRule:runtime.getOwnRule,getOwnPersona:async()=>({id:'pet-'+i,name:'玩家伙伴',prompt:'玩家的主 Agent'}),provider:{async *stream(input){seen[i].push(input);yield {type:'delta',text:JSON.stringify({action:moves[i]})};yield {type:'complete'}}}}));
 assert.equal((await agents[0].run({maxMoves:1})).status,'move-limit');assert.equal((await agents[1].run({maxMoves:1})).status,'move-limit');
 for(let i=0;i<2;i++){const context=JSON.stringify(seen[i][0].messages);assert(context.includes(rules[i]));assert(!context.includes(rules[1-i]));assert(!context.includes(tokens[0]));assert(!context.includes(tokens[1]));}
 const state=await runtimes[0].readSeatView({inviteUrl});assert.deepEqual(state.actions.map(a=>a.action),moves);
 assert.equal(state.players,2);assert(!JSON.stringify(state).includes(rules[0]));assert(!JSON.stringify(state).includes(rules[1]));
 for(const token of tokens)assert(!JSON.stringify(state).includes(token));
 // Exercise the actual workbench runtime start/stop path, still with fixture
 // providers and a local server. No account, UI, or public service is used.
 assert.equal((await runtimes[0].startAgent()).status,'started');assert.equal((await runtimes[1].startAgent()).status,'started');
 let updated;
 for(let i=0;i<40;i++){
  updated=await runtimes[0].getOwnSeatSession().transport.readState({seat:0});
  if(updated.actions.length>=4)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 runtimes.forEach(runtime=>runtime.stopAgent());
 assert.deepEqual(updated.actions.map(a=>a.action),['e2e4','e7e5','g1f3','b8c6']);
 for(let i=0;i<30&&runtimes.some(runtime=>runtime.agentStatus().status==='running');i++)await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal((await runtimes[0].playMove({inviteUrl,expectedVersion:2,action:'d2d4'})).status,'conflict');
 assert.equal((await runtimes[0].playMove({inviteUrl,expectedVersion:4,action:'d2d4'})).status,'applied');
 assert.equal((await runtimes[1].readSeatView({inviteUrl})).actions.at(-1).action,'d2d4');
 for(let i=0;i<2;i++){
  const player=accountRequests[i].find(request=>request.view);
  assert(player);assert.equal(player.method,'game-player-account-chat');assert(accountRequests[0].filter(request=>request.rule).every(request=>request.method==='game-account-chat'));const context=JSON.stringify(player);assert(context.includes(rules[i]));assert(!context.includes(rules[1-i]));assert(!context.includes(tokens[0]));assert(!context.includes(tokens[1]));
 }
});
