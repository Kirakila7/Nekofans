import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {generateKeyPairSync,sign} from 'node:crypto';
import {request} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {createPrivateTrial} from './server.mjs';
import {createPrivateGameWorker} from '../private-game-worker.mjs';
import {createExecutorVerifier,signExecutorRequest} from '../private-relay.mjs';
import {createGameStudio} from '../game-studio.mjs';
import {createFriendInviteIssuer} from '../friend-invites.mjs';
import workbenchGameRuntime from '../../../apps/neko-workbench/private-game-runtime.cjs';

const origin='https://fixture.trycloudflare.com';
function loopbackFetch(base,virtualOrigin=origin){
 return (url,opts={})=>new Promise((resolve,reject)=>{const req=request(base+new URL(url).pathname,{method:opts.method||'GET',headers:{...opts.headers,host:new URL(virtualOrigin).host}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);if(opts.body)req.write(opts.body);req.end();});
}

test('a room host invites one N.E.K.O. friend, who joins directly without a lobby login or a copied link',async t=>{
 const gameOrigin='https://play.nekofans.games',issuer='https://community.project-neko.cn';
 const host='11111111-1111-4111-8111-111111111111',guest='22222222-2222-4222-8222-222222222222',stranger='33333333-3333-4333-8333-333333333333';
 const key=generateKeyPairSync('ed25519');
 const dataDir=mkdtempSync(join(tmpdir(),'neko-invite-room-'));
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',
  encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
 let now=Date.now(),localFetch;
 const ticket=(sub,input,override={})=>{
  const iat=Math.floor(now/1000);
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload=encode({iss:issuer,aud:gameOrigin,sub,iat,exp:iat+45,name:'测试房主',...input,...override});
  const unsigned=encode({alg:'EdDSA',typ:'neko-game-invite+jwt'})+'.'+payload;
  return unsigned+'.'+sign(null,Buffer.from(unsigned),key.privateKey).toString('base64url');
 };
 const issue=createFriendInviteIssuer({issuerKey:key.privateKey,now:()=>now,
  authenticate:async authorization=>{
   const id=authorization?.slice(7);
   return [host,guest,stranger].includes(id)?{id,name:'测试房主'}:null;
  },
  mayInvite:async(sender,target)=>sender===host&&target===guest,
 });
 function runtime(userId){
  let account=userId;
  const instance=workbenchGameRuntime.createPrivateGameRuntime({
   dataDir:join(dataDir,userId),safeStorage,repositoryRoot:fileURLToPath(new URL('../../../',import.meta.url)),
   fetchImpl:(...args)=>localFetch(...args),rpc:async()=>{throw Error('quick rules require no model');},
   getSeatOwner:async()=>{if(userId!==host)throw Error('guest should not require the public lobby grant');return host;},
   getCommunityOwner:()=>account,getInviteTicket:body=>issue({authorization:'Bearer '+account,body}),
  });
  return {instance,switchAccount(next){account=next;instance.communitySeatOwnerChanged(next);}};
 }
 const publisher=runtime(host).instance,guestApp=runtime(guest),receiver=guestApp.instance,observer=runtime(stranger).instance;
 const server=createPrivateTrial({publicOrigin:gameOrigin,publicKey:await publisher.publicKey(),friendInvitePublicKey:key.publicKey,now:()=>now});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 localFetch=loopbackFetch('http://127.0.0.1:'+server.address().port,gameOrigin);
 assert.deepEqual(await receiver.friendInviteStatus(),{enabled:true});
 assert.deepEqual(await receiver.readFriendInvites(),{status:'ready',invitations:[]});
 const room=await publisher.create({gameId:'tic-tac-toe'});
 assert.equal(room.status,'created');
 const roomPath='/rooms/'+room.roomId;
 async function api(path,{method='GET',proof,seat}={}){
  const response=await localFetch(gameOrigin+path,{method,headers:{...(proof?{authorization:'Bearer '+proof}:{}),...(seat?{'x-neko-room-seat':seat}:{})}});
  return {code:response.status,body:await response.json()};
 }
 assert.equal((await api('/invitations')).code,401);
 assert.equal((await api('/invitations',{proof:ticket(guest,{op:'inbox'},{aud:'https://elsewhere.invalid'})})).code,401);
 assert.equal((await api('/invitations',{proof:ticket(guest,{op:'inbox'},{exp:Math.floor(now/1000)-1})})).code,401);
 assert.equal((await api(roomPath+'/invite',{method:'POST',proof:ticket(host,{op:'send',room:room.roomId,target:guest})})).code,403);
 assert.deepEqual(await publisher.sendFriendInvite({inviteUrl:room.inviteUrl,friendId:stranger}),{status:'forbidden'});
 assert.deepEqual(await publisher.sendFriendInvite({inviteUrl:room.inviteUrl,friendId:guest}),{status:'sent'});
 const inbox=await receiver.readFriendInvites();
 assert.equal(inbox.invitations.length,1);
 const invite=inbox.invitations[0],acceptPath='/invitations/'+invite.id+'/accept';
 assert.deepEqual(invite,{id:invite.id,sender:'测试房主',title:'井字棋',accepted:false});
 assert.deepEqual(await publisher.sendFriendInvite({inviteUrl:room.inviteUrl,friendId:guest}),{status:'sent'});
 assert.deepEqual(await receiver.readFriendInvites(),inbox,'double-click keeps the same invitation');
 assert.deepEqual(await observer.readFriendInvites(),{status:'ready',invitations:[]});
 assert.deepEqual(await observer.acceptFriendInvite(invite.id),{status:'not-found'});
 assert.deepEqual(await api(roomPath+'/join',{method:'POST'}),{code:409,body:{status:'invite-reserved'}});
 const joined=await receiver.acceptFriendInvite(invite.id);
 assert.deepEqual(joined,{status:'joined',inviteUrl:room.inviteUrl});
 assert.deepEqual(await receiver.acceptFriendInvite(invite.id),joined,'retry reuses the same authenticated seat');
 assert.equal((await api(acceptPath,{method:'POST',proof:ticket(stranger,{op:'inbox'})})).code,404);
 assert.equal((await receiver.openOwnSeat({inviteUrl:joined.inviteUrl})).seat,1);
 assert.equal((await receiver.readSeatView({inviteUrl:joined.inviteUrl})).players,2);
 assert.equal((await publisher.readSeatView({inviteUrl:room.inviteUrl})).players,2);
 assert.equal((await receiver.readFriendInvites()).invitations[0].accepted,true);
 guestApp.switchAccount(stranger);
 assert.deepEqual(await receiver.readSeatView({inviteUrl:joined.inviteUrl}),{status:'not-paired'});
 assert.deepEqual(await receiver.readFriendInvites(),{status:'ready',invitations:[]});
 const another=await publisher.create({gameId:'tic-tac-toe'});
 assert.deepEqual(await publisher.sendFriendInvite({inviteUrl:another.inviteUrl,friendId:guest}),{status:'sent'});
 now+=15*60*1000+1;
 assert.equal((await api('/rooms/'+another.roomId+'/join',{method:'POST'})).code,201,'expired invitation releases the open seat');
});
test('executor requests are signed, expire, cannot be altered or replayed',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const verify=createExecutorVerifier({publicKey,now:()=>100000});
 const s=signExecutorRequest({privateKey,method:'POST',path:'/executor/next',body:'{}',timestamp:100000});
 assert.equal(verify({method:'POST',path:'/executor/result',body:'{}',...s}),false);
 assert.equal(verify({method:'POST',path:'/executor/next',body:'{}',...s}),true);
 assert.equal(verify({method:'POST',path:'/executor/next',body:'{}',...s}),false);
 const old=signExecutorRequest({privateKey,method:'POST',path:'/executor/next',body:'{}',timestamp:1});
 assert.equal(verify({method:'POST',path:'/executor/next',body:'{}',...old}),false);
});

test('two private seats cross a signed relay and enforced effects remain hidden',async t=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),seen=[];
 const server=createPrivateTrial({publicOrigin:origin,publicKey});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const localFetch=loopbackFetch(base);
 const provider={async *stream(input){seen.push(input.messages[0].text);yield {type:'delta',text:'{"kind":"opponent-piece-ban","piece":"n","turns":1}'};yield {type:'complete'};}};
 const worker=createPrivateGameWorker({origin,privateKey,provider,fetchImpl:localFetch});
 assert.deepEqual(await worker.runOnce(),{status:'idle'});const created=await worker.createRoom();assert.equal(created.status,'created');
 const id=created.roomId,owner=new URLSearchParams(new URL(created.ownerUrl).hash.slice(1)).get('seat');
 async function call(path,method='GET',body,token){const r=await localFetch(origin+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return [r.status,await r.json()];}
 const p='/rooms/'+id;assert.equal((await call('/publisher/rooms','POST',{}))[0],401);assert.equal((await call(p+'/state'))[0],401);
 const [,guest]=await call(p+'/join','POST');assert.equal((await call(p+'/join','POST'))[0],409);
 assert.equal((await call(p+'/pair','POST',{}))[0],401);
 const [,ownerPair]=await call(p+'/pair','POST',{},owner),[,guestPair]=await call(p+'/pair','POST',{},guest.token);
 const [ownerStatus,ownerRedeemed]=await call(p+'/redeem','POST',{code:ownerPair.code});
 const [guestStatus,guestRedeemed]=await call(p+'/redeem','POST',{code:guestPair.code});
 assert.equal(ownerStatus,200);assert.deepEqual(ownerRedeemed,{seat:0,token:owner});
 assert.equal(guestStatus,200);assert.deepEqual(guestRedeemed,{seat:1,token:guest.token});
 assert.equal((await call(p+'/redeem','POST',{code:guestPair.code}))[0],400);
 async function submit(rule,seat){const pending=call(p+'/rule','POST',{rule},seat);for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,5));const result=await worker.runOnce();if(result.status==='processed')break;}return pending;}
 assert.equal((await submit('甲方第一回合不能动马',owner))[0],201);assert.equal((await submit('乙方第一回合不能动马',guest.token))[0],201);
 assert.equal(seen.length,2);assert(!seen[0].includes('乙方第一'));assert(!seen[1].includes('甲方第一'));
 const [,v0]=await call(p+'/state','GET',null,owner),[,v1]=await call(p+'/state','GET',null,guest.token);
 assert.equal(v0.ready,true);assert.equal(v1.ready,true);assert(!JSON.stringify(v0).includes('规则'));assert(!JSON.stringify(v1).includes('piece'));
 assert.equal((await call(p+'/actions','POST',{expectedVersion:0,action:'g1f3'},owner))[0],400);
 assert.equal((await call(p+'/actions','POST',{expectedVersion:0,action:'e2e4'},owner))[0],201);
 assert.equal((await call(p+'/actions','POST',{expectedVersion:1,action:'g8f6'},guest.token))[0],400);
 assert.equal((await call(p+'/actions','POST',{expectedVersion:1,action:'e7e5'},guest.token))[0],201);
});

test('separate game types share the room API and a browser seat can finish a private-rule game without a model',async t=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const server=createPrivateTrial({publicOrigin:origin,publicKey});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const localFetch=loopbackFetch('http://127.0.0.1:'+server.address().port);
 const worker=createPrivateGameWorker({origin,privateKey,fetchImpl:localFetch,provider:{async *stream(){throw Error('quick rules must not call the model');}}});
 async function call(p,{body,headers={}}={}){
  const res=await localFetch(origin+p,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {code:res.status,json:await res.json(),cookie:res.headers.get('set-cookie')};
 }
 assert.deepEqual((await call('/games')).json.games.map(x=>x.id),['chess','tic-tac-toe']);
 const chess=await worker.createRoom();
 const grid=await worker.createRoom({gameId:'tic-tac-toe'});
 assert.equal(chess.status,'created');assert.equal(grid.status,'created');
 const room='/rooms/'+grid.roomId;
 assert.equal((await call(room+'/info')).json.game.id,'tic-tac-toe');
 assert.equal((await call('/rooms/'+chess.roomId+'/info')).json.game.id,'chess');
 assert.equal((await call(room+'/game')).code,401);
 assert.equal((await call(room+'/join',{body:{browser:true}})).code,403);
 const joined=await call(room+'/join',{body:{browser:true},headers:{origin}});
 assert.equal(joined.code,201);assert.deepEqual(joined.json,{seat:1});
 assert.match(joined.cookie,/Secure; HttpOnly; SameSite=Strict/);
 const cookie=joined.cookie.split(';')[0],guestHeaders={cookie,origin};
 assert.equal((await call(room+'/join',{body:{browser:true},headers:guestHeaders})).code,200);
 const ownerHeaders={authorization:'Bearer '+new URLSearchParams(new URL(grid.ownerUrl).hash.slice(1)).get('seat')};
 assert.match((await call(room+'/game',{headers:guestHeaders})).json.html,/井字棋/);
 assert.equal((await call(room+'/rule',{headers:{cookie},body:{preset:{choice:'corners',turns:1}}})).code,403);
 assert.equal((await call(room+'/rule',{headers:ownerHeaders,body:{preset:{choice:'center',turns:1}}})).code,201);
 assert.equal((await call(room+'/rule',{headers:guestHeaders,body:{preset:{choice:'corners',turns:1}}})).code,201);
 for(const headers of [ownerHeaders,guestHeaders])assert.equal((await call(room+'/state',{headers})).json.ready,true);
 const move=(headers,expectedVersion,action)=>call(room+'/actions',{headers,body:{expectedVersion,action}});
 assert.equal((await move(ownerHeaders,0,'0')).code,400);
 assert.equal((await move(ownerHeaders,0,'1')).code,201);
 assert.equal((await move(guestHeaders,1,'4')).code,400);
 for(const [i,action] of ['3','4','6','7'].entries())assert.equal((await move(i%2?ownerHeaders:guestHeaders,i+1,action)).code,201);
 assert.equal((await move(guestHeaders,5,'0')).code,400);
 const x=(await call(room+'/state',{headers:ownerHeaders})).json,o=(await call(room+'/state',{headers:guestHeaders})).json;
 assert.deepEqual(x.actions,o.actions);
 assert.doesNotMatch(JSON.stringify([x,o]),/center|corners/);
});

test('an authored revision becomes a playable room with its own title, moves and endings',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'neko-authored-room-'));
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',
  encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
 let fetchImpl;
 const runtime=workbenchGameRuntime.createPrivateGameRuntime({dataDir,safeStorage,
  repositoryRoot:fileURLToPath(new URL('../../../',import.meta.url)),fetchImpl:(...args)=>fetchImpl(...args),
  rpc:async()=>{throw Error('authoring and quick rules do not use the Goddess');},
 });
 const server=createPrivateTrial({publicOrigin:origin,publicKey:await runtime.publicKey()});
 t.after(()=>server.emit('close'));
 // Exercise the real request handler without an external listener or account.
 fetchImpl=(url,options={})=>new Promise(resolve=>{
  const req=Object.assign(Readable.from(options.body?[Buffer.from(options.body)]:[]),{
   url:new URL(url).pathname,method:options.method||'GET',
   headers:{...options.headers,host:new URL(origin).host},socket:{remoteAddress:'127.0.0.1'},
  });
  let status,headers;
  server.emit('request',req,{
   writeHead(code,fields){status=code;headers=fields;},
   end(body){resolve(new Response(body,{status,headers}));},
  });
 });
 const game={title:'月球基地',description:'轮流选择如何保住基地。',nodes:[
  {text:'沙尘暴就要到了。',seat:0,choices:[{label:'先救供电',next:1},{label:'先修天线',next:2}]},
  {text:'电力回来了一半。',seat:1,choices:[{label:'保住灯塔',next:3},{label:'关闭电源',next:4}]},
  {text:'天线重新上线。',seat:1,choices:[{label:'请求支援',next:5}]},
  {text:'守住了灯塔。',winner:0},
  {text:'电池保存到天亮。',winner:1},
  {text:'双方一起获救。',winner:'draw'},
 ]};
 const provider={async *stream(){
  yield {type:'delta',text:JSON.stringify(game)};
  yield {type:'complete'};
 }};
 const studio=createGameStudio({provider});
 const draft=await studio.propose({prompt:'做一个双人月球基地游戏'});
 assert.equal(draft.status,'draft');
 const room=await runtime.create({url:origin,gameId:'studio',definition:studio.inspect(draft.revisionId).game});
 assert.equal(room.status,'created');
 assert.equal((await runtime.readSeatView({inviteUrl:room.inviteUrl})).game.title,game.title);
 assert.match((await runtime.boardHtml({inviteUrl:room.inviteUrl})).html,/月球基地/);
 const root='/rooms/'+room.roomId;
 const owner='Bearer '+new URLSearchParams(new URL(room.ownerUrl).hash.slice(1)).get('seat');
 const requestRoom=(suffix,{body,authorization}={})=>fetchImpl(origin+root+suffix,{
  method:body===undefined?'GET':'POST',
  headers:authorization?{authorization}:{},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
 });
 assert.deepEqual((await (await requestRoom('/info')).json()).definition,game);
 const guest='Bearer '+(await (await requestRoom('/join',{body:{}})).json()).token;
 assert.match((await (await requestRoom('/game',{authorization:guest})).json()).html,/月球基地/);
 for(const [authorization,choice] of [[owner,'none'],[guest,'last']]){
  assert.equal((await requestRoom('/rule',{authorization,body:{preset:{choice,turns:1}}})).status,201);
 }
 assert.equal((await (await requestRoom('/state',{authorization:owner})).json()).ready,true);
 const play=(authorization,expectedVersion,action)=>requestRoom('/actions',{authorization,body:{expectedVersion,action}});
 assert.equal((await play(guest,0,'0')).status,400);
 assert.equal((await play(owner,0,'1')).status,400);
 assert.equal((await play(owner,0,'0')).status,201);
 assert.equal((await play(guest,1,'1')).status,201);
 const ended=await (await requestRoom('/state',{authorization:owner})).json();
 assert.equal(ended.finished,true);
 assert.deepEqual(ended.actions.map(({action})=>action),['0','1']);
 assert.doesNotMatch(JSON.stringify(ended),/none|last/);
 assert.equal((await play(owner,2,'0')).status,409);
 const bad=structuredClone(game);bad.nodes[1].choices[0].next=0;
 assert.equal((await runtime.create({url:origin,gameId:'studio',definition:bad})).status,'unavailable');
});
