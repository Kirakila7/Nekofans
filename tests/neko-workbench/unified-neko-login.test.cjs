'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createUnifiedNekoLogin}=require('../../apps/neko-workbench/unified-neko-login.cjs');
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function fixture(t,initial={}){
 let community=initial.community||{status:'signed-out'},lobby=initial.lobby||{auth:{status:'signed-out'}},userId=initial.userId||'same-user',counts={community:0,signIn:0,reauthorize:0,cancel:0,closed:0},gate=null;
 const states=[],flow=createUnifiedNekoLogin({getCommunity:()=>community,getLobby:()=>lobby,requestCommunityLogin:()=>counts.community++,signInLobby:async()=>{counts.signIn++;if(gate)await gate;lobby={auth:{status:'signed-in'}};return {ok:true};},reauthorizeLobby:async()=>{counts.reauthorize++;if(gate)await gate;return {ok:true};},verifyLobbyIdentity:async()=>({userId,...(initial.lobbyIdentity?{identity:initial.lobbyIdentity}:{})}),cancelLobby:()=>{counts.cancel++;},closeAuthorization:()=>counts.closed++,onState:s=>states.push(s)});t.after(()=>flow.dispose());
 return {flow,counts,states,setCommunity(value){community=value;flow.communityChanged(value);},setLobby(value){lobby=value;flow.lobbyChanged();},setId(value){userId=value;},setGate(value){gate=value;}};
}
test('one entry waits for verified community login then authorizes the independent lobby grant once',async t=>{
 const f=fixture(t);assert.equal(f.flow.begin().state.status,'community');f.flow.begin();assert.equal(f.counts.community,1);assert.equal(f.counts.signIn,0);f.setCommunity({status:'checking'});assert.equal(f.counts.signIn,0);f.setCommunity({status:'signed-in',userId:'same-user'});await tick();assert.equal(f.counts.signIn,1);assert.equal(f.flow.snapshot().status,'connected');assert.equal(f.flow.snapshot().lobbyAvailable,true);assert.equal(f.flow.snapshot().identityStatus,'unverified');assert(!JSON.stringify(f.states).includes('same-user'));
});
test('service-local identity differences preserve existing grants and only an explicit request reauthorizes',async t=>{
 const f=fixture(t,{community:{status:'signed-in',userId:'community-user'},lobby:{auth:{status:'signed-in'}},userId:'old-lobby-user'});f.flow.begin();await tick();assert.equal(f.counts.reauthorize,0);assert.equal(f.flow.snapshot().status,'connected');assert(f.flow.snapshot().lobbyAvailable);f.flow.begin({reauthorize:true});await tick();assert.equal(f.counts.reauthorize,1);f.setId('community-user');f.flow.begin();await tick();assert.equal(f.counts.reauthorize,1);assert.equal(f.flow.snapshot().status,'connected','even equal service-local IDs do not prove a shared principal');assert.equal(f.flow.snapshot().identityStatus,'unverified');
});
test('valid independent grants are reused across repeated entry clicks without another official consent flow',async t=>{
 const f=fixture(t,{community:{status:'signed-in',userId:'community-local'},lobby:{auth:{status:'signed-in'}},userId:'chat-local'});
 for(let i=0;i<3;i++){f.flow.begin({source:'account'});await tick();}
 assert.deepEqual({community:f.counts.community,signIn:f.counts.signIn,reauthorize:f.counts.reauthorize},{community:0,signIn:0,reauthorize:0});
 assert.equal(f.flow.snapshot().lobbyAvailable,true);assert.equal(f.flow.snapshot().identityStatus,'unverified');assert.equal(f.flow.snapshot().status,'connected');
 const g=fixture(t,{lobby:{auth:{status:'signed-in'}},userId:'chat-local'});g.flow.begin({source:'lobby'});assert.equal(g.counts.community,1);
 g.setCommunity({status:'signed-in',userId:'community-local'});await tick();assert.equal(g.counts.signIn,0);assert.equal(g.counts.reauthorize,0);assert.equal(g.flow.snapshot().lobbyAvailable,true);
});
test('cancel and community account changes reject late completions without signing existing owners out',async t=>{
 const f=fixture(t);let release;f.setGate(new Promise(r=>release=r));f.flow.begin();f.setCommunity({status:'signed-in',userId:'same-user'});await tick();assert.equal(f.flow.snapshot().status,'chatroom');f.flow.cancel();release();await tick();assert.equal(f.flow.snapshot().status,'canceled');assert.equal(f.counts.cancel,1);
 const g=fixture(t);let done;g.setGate(new Promise(r=>done=r));g.flow.begin();g.setCommunity({status:'signed-in',userId:'same-user'});await tick();g.setCommunity({status:'signed-in',userId:'other-user'});done();await tick();assert.equal(g.flow.snapshot().status,'partial');assert.equal(g.counts.cancel,1);
});
test('async community login rejection and throwing cancellation callbacks stay contained',async()=>{
 const f=createUnifiedNekoLogin({getCommunity:()=>({status:'signed-out'}),getLobby:()=>({}),requestCommunityLogin:()=>Promise.reject(Error('private URL or secret')),cancelCommunityLogin:()=>{throw Error('private');},closeAuthorization:()=>{throw Error('private');}});f.begin();await tick();assert.equal(f.snapshot().status,'error');assert(!JSON.stringify(f.snapshot()).includes('private'));assert.doesNotThrow(()=>f.cancel());f.dispose();
});
test('an immediate retry waits for canceled owner rollback before starting a fresh authorization',async t=>{
 let calls=0,finishFirst,finishCancel,auth={status:'signed-out'};const rollback=new Promise(r=>finishCancel=r);
 const flow=createUnifiedNekoLogin({getCommunity:()=>({status:'signed-in',userId:'same'}),getLobby:()=>({auth}),signInLobby:async()=>{calls++;if(calls===1)return new Promise(r=>finishFirst=r);auth={status:'signed-in'};return {ok:true};},verifyLobbyIdentity:async()=>({userId:'same'}),reauthorizeLobby:async()=>({ok:true}),cancelLobby:()=>{finishFirst({ok:false});return rollback;}});t.after(()=>flow.dispose());
 flow.begin();await tick();assert.equal(calls,1);flow.cancel();flow.begin();await tick();assert.equal(calls,1);finishCancel();await tick();assert.equal(calls,2);assert.equal(flow.snapshot().status,'connected');
});

test('verified community login skips community navigation and preserves source and flow identity until completion',async t=>{
 const f=fixture(t,{community:{status:'signed-in',userId:'same-user'}}),started=f.flow.begin({source:'lobby'});
 assert.equal(started.state.status,'chatroom');assert.equal(started.state.source,'lobby');assert(Number.isSafeInteger(started.state.flowId));assert.equal(f.counts.community,0);
 await tick();assert.equal(f.flow.snapshot().status,'connected');assert(f.flow.snapshot().lobbyAvailable);assert.equal(f.flow.snapshot().flowId,started.state.flowId);assert.equal(f.flow.snapshot().source,'lobby');
});

test('checking waits for the existing observer and only requests community login after confirmed sign-out',async t=>{
 const f=fixture(t,{community:{status:'checking'}});assert.equal(f.flow.begin({source:'lobby'}).state.status,'checking');assert.equal(f.counts.community,0);
 f.setCommunity({status:'signed-in',userId:'same-user'});await tick();assert.equal(f.counts.community,0);assert.equal(f.counts.signIn,1);
 const g=fixture(t,{community:{status:'checking'}});g.flow.begin({source:'account'});g.setCommunity({status:'signed-out'});g.setCommunity({status:'signed-out'});assert.equal(g.counts.community,1);assert.equal(g.flow.snapshot().status,'community');
});

test('unavailable community state is an explicit failure and cannot claim either signed-out or unified success',async t=>{
 const f=fixture(t,{community:{status:'unavailable'}});assert.equal(f.flow.begin({source:'lobby'}).state.status,'error');assert.equal(f.counts.community,0);assert.equal(f.counts.signIn,0);
 const g=fixture(t,{community:{status:'checking'}});g.flow.begin({source:'lobby'});g.setCommunity({status:'unavailable'});assert.equal(g.flow.snapshot().status,'error');assert.match(g.flow.snapshot().error,/暂不可读取/);
});

test('one login owner retains its caller and cancellation does not let a later request inherit its flow id',async t=>{
 const f=fixture(t),first=f.flow.begin({source:'lobby'});assert.deepEqual(f.flow.begin({source:'account'}).state,first.state);const canceled=f.flow.cancel().state;assert.equal(canceled.source,'lobby');assert.equal(canceled.flowId,first.state.flowId);
 const second=f.flow.begin({source:'account'});assert.equal(second.state.source,'account');assert(second.state.flowId>first.state.flowId);
 for(const value of [{source:'foreign'},{source:'lobby',url:'https://other.invalid'},null,[]])assert.throws(()=>f.flow.begin(value),/来源无效/);
});

test('same-account success requires two explicitly verified principals with the same issuer and subject',async t=>{
 const shared={verified:true,issuer:'https://auth.example.test/',subject:'principal-1'};
 const good=fixture(t,{community:{status:'signed-in',userId:'local-a',identity:shared},lobbyIdentity:shared,userId:'local-b'});good.flow.begin();await tick();assert.equal(good.flow.snapshot().status,'signed-in');assert.equal(good.flow.snapshot().identityStatus,'verified');
 const foreign=fixture(t,{community:{status:'signed-in',userId:'equal-local',identity:shared},lobbyIdentity:{...shared,issuer:'https://another.example.test/'},userId:'equal-local'});foreign.flow.begin();await tick();assert.equal(foreign.flow.snapshot().status,'partial');assert.equal(foreign.flow.snapshot().identityStatus,'different');
 const unverified=fixture(t,{community:{status:'signed-in',userId:'equal-local',identity:{...shared,verified:false}},lobbyIdentity:shared,userId:'equal-local'});unverified.flow.begin();await tick();assert.equal(unverified.flow.snapshot().status,'connected');assert.equal(unverified.flow.snapshot().identityStatus,'unverified');
});
test('a revoked lobby grant invalidates the usable connected state without revoking the community owner',async t=>{
 const f=fixture(t,{community:{status:'signed-in',userId:'community-local'},lobby:{auth:{status:'signed-in'}}});f.flow.begin();await tick();assert.equal(f.flow.snapshot().status,'connected');
 f.setLobby({auth:{status:'signed-out'}});assert.equal(f.flow.snapshot().status,'partial');assert.equal(f.flow.snapshot().lobbyAvailable,false);assert.equal(f.counts.community,0);
});
