'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createSocialClient}=require('../../apps/neko-workbench/visits/social-client.cjs');
const {createCommunityDaily}=require('../../apps/neko-workbench/community-daily.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
async function server(t,handler){
 const errors=[],s=http.createServer(async(req,res)=>{try{let raw='';for await(const b of req)raw+=b;await handler(req,res,raw);}catch(e){errors.push(e);res.writeHead(500);res.end('{}');}});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>{s.close(r);s.closeAllConnections();});assert.deepEqual(errors,[]);});return `http://127.0.0.1:${s.address().port}`;
}
const json=(res,value)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
const client=(baseUrl,extra={})=>createSocialClient({baseUrl,clientId:'synthetic-workbench',getAccessToken:async()=> 'fixture-bearer',allowLoopbackForTests:true,...extra});
const post={ownerId:A,title:'大肥鱼今日小记',body:'今天和主人整理了玩偶。大肥鱼 · AI日常'};
test('real HTTP verifies identity then sends public multipart to the observed community API',async t=>{
 const calls=[];let tokens=0;const base=await server(t,(req,res,raw)=>{calls.push(req.url);assert.equal(req.headers.authorization,'Bearer fixture-bearer');assert.equal(req.headers['x-client-id'],'synthetic-workbench');
  if(req.url==='/api/users/me')return json(res,{user:{id:A}});
  assert.equal(req.url,'/api/posts');assert.equal(req.method,'POST');assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
  for(const [name,value]of Object.entries({title:post.title,body:post.body,visibility:'public',tags:'[]',image_ids:'[]',image_crops:'[]'}))assert(raw.includes(`name="${name}"\r\n\r\n${value}\r\n`));
  assert(!raw.includes('fixture-bearer'));json(res,{id:'created-fixture'});
 });
 assert.deepEqual(await client(base,{getAccessToken:async()=>{tokens++;return 'fixture-bearer';}}).publishDaily(post),{id:'created-fixture'});assert.equal(tokens,1);assert.deepEqual(calls,['/api/users/me','/api/posts']);
});
for(const mode of ['wrong-owner','fence','abort','redirect','unauthorized'])test(`HTTP ${mode} prevents a public write`,async t=>{
 let writes=0;const controller=new AbortController();
 const base=await server(t,(req,res)=>{if(req.url==='/api/posts'){writes++;return json(res,{id:'unexpected'});}
  if(mode==='redirect'){res.writeHead(302,{Location:'/api/posts'});return res.end();}if(mode==='unauthorized'){res.writeHead(401);return res.end('{}');}
  if(mode==='abort')controller.abort();json(res,{user:{id:mode==='wrong-owner'?B:A}});
 });
 await assert.rejects(client(base).publishDaily({...post,signal:controller.signal,assertCurrent:()=>{if(mode==='fence')throw Error('account_changed');}}));assert.equal(writes,0);
});
test('invalid account/content/token cannot reach HTTP',async t=>{
 let calls=0;const base=await server(t,(_req,res)=>{calls++;json(res,{});});const api=client(base);
 await assert.rejects(api.publishDaily({...post,ownerId:'invalid'}));await assert.rejects(api.publishDaily({...post,body:'x'.repeat(501)}));
 await assert.rejects(client(base,{getAccessToken:async()=> 'bad token'}).publishDaily(post));assert.equal(calls,0);
});
test('a failed account check or refused write can be retried the same day; an accepted write is sent once',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-daily-http-'));
 let mode='expired',writes=0;
 const base=await server(t,(req,res)=>{
  if(req.url==='/api/users/me'){
   if(mode==='expired'){res.writeHead(401);return res.end('{}');}
   return json(res,{user:{id:A}});
  }
  assert.equal(req.url,'/api/posts');writes++;
  if(mode==='forbidden'){res.writeHead(403);return res.end('{}');}
  return json(res,{id:'accepted-fixture'});
 });
 const api=client(base),now=Date.parse('2026-11-06T12:10:00Z');
 const daily=createCommunityDaily({dataDir,now:()=>now,getIdentity:()=>({userId:A,epoch:1}),
  getInteractions:()=>[{role:'user',text:'今天给小窝添了窗帘。',createdAt:now}],
  generate:async()=>post.body,publish:request=>api.publishDaily({...request,ownerId:request.identity.userId})});
 t.after(()=>{daily.dispose();fs.rmSync(dataDir,{recursive:true,force:true});});
 daily.configure(true);
 await daily.tick();assert.equal(writes,0);assert.equal(daily.status().today,'none');assert.match(daily.status().error,/重新登录/);
 mode='forbidden';await daily.tick({force:true});assert.equal(writes,1);assert.equal(daily.status().today,'none');assert.match(daily.status().error,/发帖权限/);
 mode='allowed';await daily.tick({force:true});assert.equal(writes,2);assert.equal(daily.status().today,'published');
 await daily.tick({force:true});assert.equal(writes,2);
});
