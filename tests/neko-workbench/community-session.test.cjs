'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
const source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/community-session-preload.cjs'),'utf8');
const response=user=>({ok:true,status:200,text:async()=>JSON.stringify({user})});
function fixture(t,{origin='https://community.project-neko.cn',fetchImpl,isMainFrame=true}={}){const dom=new JSDOM('<button>登录 / 注册</button>',{url:origin,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,sent=[],handlers={},tasks=[],requests=[];w.process={isMainFrame};w.require=()=>({ipcRenderer:{send:(name,state)=>sent.push([name,state]),on:(name,fn)=>handlers[name]=fn}});w.AbortSignal=AbortSignal;w.TextDecoder=TextDecoder;w.fetch=(...args)=>{requests.push(args);return (fetchImpl|| (async()=>response({id:'user-fixture',display_name:'测试喵'})))(...args);};w.setTimeout=fn=>{tasks.push(fn);return tasks.length;};w.clearTimeout=()=>{};w.setInterval=()=>{};w.eval(source);return {w,sent,handlers,requests,async flush(){tasks.splice(0).at(-1)?.();await new Promise(resolve=>setImmediate(resolve));},async read(){w.dispatchEvent(new w.Event('neko-auth-changed'));await this.flush();}};}
const me='11111111-1111-4111-8111-111111111111';
const friend='22222222-2222-4222-8222-222222222222';
const blocked='33333333-3333-4333-8333-333333333333';
const unreciprocated='44444444-4444-4444-8444-444444444444';
test('friends use the verified community web account and expose only mutual, unblocked contacts',async t=>{
 const f=fixture(t,{fetchImpl:async route=>{
  if(route==='/api/users/me')return Response.json({user:{id:me}});
  if(route.endsWith('offset=0'))return Response.json({total:3,items:[
   {id:blocked,is_mutual:true,blocks_viewer:true},
   {id:unreciprocated,is_mutual:false},
  ]});
  return Response.json({total:3,items:[{id:friend,display_name:'好友',is_mutual:true,online:true,avatar_url:'hue:180',access_token:'private-field'}]});
 }});
 await f.handlers['workbench:community-web-friends']({},1);
 assert.deepEqual(structuredClone(f.sent.at(-1)),['workbench:community-web-friends-result',{id:1,status:'sign-in-required'}]);
 assert.equal(f.requests.length,0);
 f.w.localStorage.setItem('neko_oauth_access_token','shared-web-token');
 await f.handlers['workbench:community-web-friends']({},2);
 assert.deepEqual(structuredClone(f.sent.at(-1)),['workbench:community-web-friends-result',{id:2,status:'ready',userId:me,friends:[{id:friend,displayName:'好友',online:true,avatar:'hue:180'}]}]);
 assert.deepEqual(f.requests.map(([route])=>route),['/api/users/me',`/api/users/${me}/following?limit=100&offset=0`,`/api/users/${me}/following?limit=100&offset=2`]);
 for(const [,init] of f.requests){assert.equal(init.headers.Authorization,'Bearer shared-web-token');assert.equal(init.redirect,'error');}
 assert.doesNotMatch(JSON.stringify(f.sent),/shared-web-token|private-field/);
});
test('a friends response from a former community session is discarded',async t=>{
 let release,started;
 const pending=new Promise(resolve=>started=resolve);
 const f=fixture(t,{fetchImpl:async route=>{
  if(route==='/api/users/me')return Response.json({user:{id:me}});
  return new Promise(resolve=>{release=resolve;started();});
 }});
 f.w.localStorage.setItem('neko_oauth_access_token','old-web-token');
 const read=f.handlers['workbench:community-web-friends']({},1);
 await pending;
 f.w.localStorage.setItem('neko_oauth_access_token','new-web-token');
 release(Response.json({total:1,items:[{id:friend,display_name:'旧账号好友',is_mutual:true}]}));
 await read;
 assert.deepEqual(structuredClone(f.sent.at(-1)),['workbench:community-web-friends-result',{id:1,status:'account-changed'}]);
});
test('a game invitation asks the official session for only a game ticket',async t=>{
 const f=fixture(t,{fetchImpl:async route=>route==='/api/users/me'?response({id:me}):
  Response.json({userId:me,ticket:'fixture.payload.signature',refresh_token:'unrelated-secret'})});
 f.w.localStorage.setItem('neko_oauth_access_token','only-for-community');
 const room='abcdefghijklmnopqrstuvwx';
 await f.handlers['workbench:community-game-ticket']({},42,{op:'send',target:friend,room});
 const [route,request]=f.requests.at(-1);
 assert.equal(route,'/api/game-invites/ticket');
 assert.equal(request.redirect,'error');
 assert.equal(request.headers.Authorization,'Bearer only-for-community');
 assert.deepEqual(JSON.parse(request.body),{op:'send',target:friend,room});
 assert.deepEqual(structuredClone(f.sent.at(-1)),['workbench:community-game-ticket-result',
  {id:42,status:'ready',userId:me,ticket:'fixture.payload.signature'}]);
 assert.doesNotMatch(JSON.stringify(f.sent),/only-for-community|unrelated-secret/);
});
test('community adapter verifies server, projects no credentials, reacts to logout and ignores foreign origins',async t=>{
 const f=fixture(t);f.w.localStorage.setItem('neko_oauth_access_token','synthetic-token');await f.read();assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1)[1])),{status:'signed-in',userId:'user-fixture',name:'测试喵'});assert(!JSON.stringify(f.sent).includes('synthetic-token'));f.w.localStorage.removeItem('neko_oauth_access_token');await f.read();assert.equal(f.sent.at(-1)[1].status,'signed-out');
 const bad=fixture(t,{origin:'https://auth.project-neko.cn'});await bad.read();assert.equal(bad.sent.length,0);assert.equal(Object.keys(bad.handlers).length,0);
});
test('saved token and network failure never masquerade as verified login; stale account reply cannot commit',async t=>{
 const f=fixture(t,{fetchImpl:async()=>({ok:false,status:401})});f.w.localStorage.setItem('neko_oauth_access_token','expired-fixture');await f.read();assert.equal(f.sent.at(-1)[1].status,'signed-out');
 let resolve;const g=fixture(t,{fetchImpl:()=>new Promise(r=>resolve=r)});g.w.localStorage.setItem('neko_oauth_access_token','old-fixture');await g.read();g.w.localStorage.removeItem('neko_oauth_access_token');await g.read();resolve(response({id:'old-user'}));await new Promise(r=>setImmediate(r));assert.equal(g.sent.at(-1)[1].status,'signed-out');
});
test('official nested user contract uses display_name; a flat or malformed identity never becomes signed-in',async t=>{
 const f=fixture(t,{fetchImpl:async()=>response({id:'local-user',display_name:'公开名字',username:'fallback-name',auth_source:'oauth'})});f.w.localStorage.setItem('neko_oauth_access_token','synthetic-token');await f.read();assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1)[1])),{status:'signed-in',userId:'local-user',name:'公开名字'});
 for(const body of [{id:'flat-fixture',nickname:'old-wrong-fixture'},{user:{username:'missing-id'}},{user:{id:42}}]){const g=fixture(t,{fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify(body)})});g.w.localStorage.setItem('neko_oauth_access_token','synthetic-token');await g.read();assert.equal(g.sent.at(-1)[1].status,'unavailable');}
});
test('only effective OAuth is verified; legacy residue and uncommitted continuation credentials never revive a login',async t=>{
 const f=fixture(t);f.w.localStorage.setItem('neko_auth_source','legacy');f.w.localStorage.setItem('neko_access_token','legacy-fixture');f.w.sessionStorage.setItem('neko_servers_oauth_pending_access','pending-fixture');await f.read();assert.equal(f.sent.at(-1)[1].status,'signed-out');assert.equal(f.requests.length,0);
 // The official kC/Fa migration removes legacy, then emits its real auth event.
 f.w.localStorage.removeItem('neko_access_token');f.w.localStorage.removeItem('neko_auth_source');f.w.localStorage.setItem('neko_oauth_access_token','effective-fixture');await f.read();assert.equal(f.sent.at(-1)[1].status,'signed-in');assert.equal(f.requests[0][1].headers.Authorization,'Bearer effective-fixture');
 f.w.localStorage.setItem('neko_access_token','leftover-legacy-fixture');await f.read();assert.equal(f.requests.at(-1)[1].headers.Authorization,'Bearer effective-fixture');assert(!JSON.stringify(f.sent).includes('effective-fixture'));
});
test('background checks of one verified session do not flap checking; failed verification still clears availability',async t=>{
 let fail=false;const f=fixture(t,{fetchImpl:async()=>{if(fail)throw Error('private synthetic diagnostic');return response({id:'user-fixture'});}});f.w.localStorage.setItem('neko_oauth_access_token','same-fixture');await f.read();const count=f.sent.length;
 f.handlers['workbench:community-web-state']();await f.flush();assert.deepEqual(f.sent.slice(count).map(x=>x[1].status),['signed-in']);fail=true;await f.read();assert.equal(f.sent.at(-1)[1].status,'unavailable');assert(!JSON.stringify(f.sent).includes('private synthetic'));
});
test('same-token responses cannot commit after a source/session generation change and foreign frames install no bridge',async t=>{
 let release;const f=fixture(t,{fetchImpl:()=>new Promise(resolve=>{release=resolve;})});f.w.localStorage.setItem('neko_oauth_access_token','same-fixture');f.w.localStorage.setItem('neko_auth_generation','old');await f.read();f.w.localStorage.setItem('neko_auth_generation','new');release(response({id:'old-user'}));await new Promise(resolve=>setImmediate(resolve));assert(!f.sent.some(x=>x[1].status==='signed-in'));
 const sub=fixture(t,{isMainFrame:false});await sub.read();assert.equal(sub.sent.length,0);assert.equal(Object.keys(sub.handlers).length,0);
});
test('login command finds the official accessible entry after async mount without requiring exact decorative text',async t=>{
 const f=fixture(t);f.w.document.body.replaceChildren();f.handlers['workbench:community-web-login']();let clicks=0;const b=f.w.document.createElement('button');b.textContent='图标 登录 / 注册 登录';b.getClientRects=()=>[{}];b.onclick=()=>clicks++;f.w.document.body.append(b);await new Promise(r=>setImmediate(r));assert.equal(clicks,1);f.w.document.body.append(f.w.document.createElement('div'));await new Promise(r=>setImmediate(r));assert.equal(clicks,1);
});
test('verified login never clicks a stale SPA login entry and canceled attempts cannot click a late entry',async t=>{
 const f=fixture(t);f.w.localStorage.setItem('neko_oauth_access_token','synthetic-token');let clicks=0;const button=f.w.document.querySelector('button');button.getClientRects=()=>[{}];button.onclick=()=>clicks++;
 await f.handlers['workbench:community-web-login']();await new Promise(resolve=>setImmediate(resolve));assert.equal(clicks,0);assert.equal(f.sent.at(-1)[1].status,'signed-in');
 const g=fixture(t);g.w.document.body.replaceChildren();await g.handlers['workbench:community-web-login']();g.handlers['workbench:community-web-login-cancel']();
 const late=g.w.document.createElement('button');late.textContent='登录 / 注册';late.getClientRects=()=>[{}];late.onclick=()=>clicks++;g.w.document.body.append(late);await new Promise(resolve=>setImmediate(resolve));await g.flush();assert.equal(clicks,0);
});
test('cancel during server verification invalidates only the pending login click, not verified account state',async t=>{
 let release;const f=fixture(t,{fetchImpl:()=>new Promise(resolve=>{release=resolve;})});f.w.localStorage.setItem('neko_oauth_access_token','synthetic-token');const button=f.w.document.querySelector('button');button.getClientRects=()=>[{}];let clicks=0;button.onclick=()=>clicks++;
 const pending=f.handlers['workbench:community-web-login']();f.handlers['workbench:community-web-login-cancel']();release(response({id:'verified-user'}));await pending;await new Promise(resolve=>setImmediate(resolve));assert.equal(clicks,0);assert.equal(f.sent.at(-1)[1].status,'signed-in');
});
