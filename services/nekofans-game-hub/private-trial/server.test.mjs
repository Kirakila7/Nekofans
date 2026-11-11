import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {request} from 'node:http';
import {createPrivateTrial} from './server.mjs';
import {createPrivateGameWorker} from '../private-game-worker.mjs';
import {createExecutorVerifier,signExecutorRequest} from '../private-relay.mjs';

const origin='https://fixture.trycloudflare.com';
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
 const localFetch=(url,opts={})=>new Promise((resolve,reject)=>{const req=request(base+new URL(url).pathname,{method:opts.method||'GET',headers:{...opts.headers,host:new URL(origin).host}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);if(opts.body)req.write(opts.body);req.end();});
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
