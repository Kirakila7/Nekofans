'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');
const {createServer} = require('node:http');
const {setTimeout: delay} = require('node:timers/promises');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {resolveChatConfig,lobbyDataDirectory} = require('../../apps/neko-workbench/lobby-config.cjs');
const {createLobbyController} = require('../../apps/neko-workbench/lobby-controller.cjs');
const {WorkbenchSecretStore} = require('../../apps/neko-workbench/main-chat-secret.cjs');

let WebSocketServer;
try {
  const paths = [__dirname, process.env.NEKO_DOM_DEPS].filter(Boolean);
  ({WebSocketServer} = require(require.resolve('ws',{paths})));
} catch {}

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const channel = {id:id(1),name:'联调频道',topic:'',slow_mode_seconds:0,cats_enabled:false,cat_free_mode_allowed:false};
const people = [2,3].map(n => ({kind:'human',user_id:id(n),name:'新账号'+n,display_name:'新账号'+n,
  avatar:{kind:'hue',hue:180,text:'新'}}));
const token = (kind, user) => `fixture-${kind}-${user.user_id}`;
const opaqueTokens = new Map(people.flatMap(person => [
  [token('access',person),person], [token('refresh',person),person],
]));
const sha = value => createHash('sha256').update(value).digest('base64url');
const fixtureVault = {
  isEncryptionAvailable:()=>true,
  encryptString:value=>Buffer.from(value).reverse(),
  decryptString:value=>Buffer.from(value).reverse().toString(),
};
const store = (profile,config) => new WorkbenchSecretStore(
  path.join(lobbyDataDirectory(profile,config),'secrets','refresh-token.encrypted'),fixtureVault);

function reply(response,status,payload) {
  response.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));
}
async function form(request) {
  const chunks=[];
  for await (const chunk of request) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}
async function waitFor(check,label) {
  for (let index=0;index<220;index++) {
    if (check()) return;
    await delay(20);
  }
  assert.fail('Timed out: '+label);
}

test('two new users authorize and chat in the independent deployment, with official grants untouched',
  {skip:!WebSocketServer && 'ws is required for the loopback WebSocket fixture',timeout:20000},async t=>{
  const temporary=await fs.realpath(os.tmpdir());
  const profile=await fs.mkdtemp(path.join(temporary,'nekofans-chat-'));
  const controllers=[], audit=[], history=[], codes=new Map(), sockets=new Map();
  let origin;
  const server=createServer((request,response)=>void route(request,response).catch(()=>reply(response,500,{})));
  const ws=new WebSocketServer({server,path:'/ws/channels/'+channel.id});
  t.after(async()=>{
    for (const controller of controllers) controller.dispose();
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    if (path.dirname(await fs.realpath(profile))===temporary) await fs.rm(profile,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  const own={...resolveChatConfig({NEKO_WORKBENCH_CHAT_DEPLOYMENT:'nekofans',NEKO_WORKBENCH_CHAT_URL:origin,
    NEKO_WORKBENCH_CHAT_AUTH_URL:origin,NEKO_WORKBENCH_CHAT_CLIENT_ID:'neko-chat-desktop-dev'}),oauthPorts:null};

  async function route(request,response) {
    const {pathname,searchParams}=new URL(request.url,origin);
    if (pathname==='/oauth2/auth') {
      const person=people[Number(searchParams.get('fixture'))];
      if (!person || searchParams.get('code_challenge_method')!=='S256') return reply(response,400,{});
      const code=randomUUID(), redirect=new URL(searchParams.get('redirect_uri'));
      codes.set(code,{person,challenge:searchParams.get('code_challenge'),redirect:redirect.href});
      redirect.searchParams.set('code',code);
      redirect.searchParams.set('state',searchParams.get('state'));
      response.writeHead(303,{location:redirect.href}).end();
      return;
    }
    if (pathname==='/oauth2/token') {
      const fields=await form(request),kind=fields.get('grant_type'),code=fields.get('code'),grant=codes.get(code);
      const person=kind==='refresh_token'?opaqueTokens.get(fields.get('refresh_token'))
        : grant && sha(fields.get('code_verifier')||'')===grant.challenge && fields.get('redirect_uri')===grant.redirect && grant.person;
      if (!person || fields.get('client_id')!=='neko-chat-desktop-dev') return reply(response,400,{error:'invalid_grant'});
      codes.delete(code);
      audit.push(kind);
      return reply(response,200,{access_token:token('access',person),refresh_token:token('refresh',person),
        token_type:'Bearer',expires_in:3600,scope:'openid profile offline'});
    }
    if (pathname==='/oauth2/revoke') { await form(request);audit.push('revoke');return reply(response,200,{}); }
    const person=people.find(user=>request.headers.authorization==='Bearer '+token('access',user));
    if (!person) return reply(response,401,{detail:'invalid_token'});
    if (pathname==='/api/v1/me') return reply(response,200,{user:person,role:'member',is_admin:false,cat:null});
    if (pathname==='/api/v1/channels/lobby') return reply(response,200,{...channel,last_seq:history.length});
    const routeBase='/api/v1/channels/'+channel.id;
    if (pathname===routeBase+'/messages') return reply(response,200,{messages:history,next_before_seq:null,has_more:false});
    if (pathname===routeBase+'/members') return reply(response,200,{members:people.map(member=>({...member,role:'member',online:true}))});
    return reply(response,404,{});
  }
  ws.on('connection',socket=>{
    socket.on('message',raw=>{
      const frame=JSON.parse(raw);
      if (frame.type==='auth') {
        const person=people.find(user=>token('access',user)===frame.token);
        if (!person) return socket.close(4401);
        sockets.set(socket,person);
        socket.send(JSON.stringify({type:'hello',user_id:person.user_id,token_expires_at:Date.now()+3600000,last_event_seq:history.length}));
      }
      if (frame.type==='message.send') {
        const author=sockets.get(socket);
        if (!author) return socket.close(4401);
        const seq=history.length+1;
        const message={id:id(100+seq),seq,channel_id:channel.id,created_at:Date.now(),text:frame.text,
          deleted:false,origin:'human',label:author.name,author,mentions:[],reply_to:null,cat_depth:0};
        history.push(message);
        socket.send(JSON.stringify({type:'ack',client_message_id:frame.client_message_id,message_id:message.id,seq,duplicate:false}));
        for (const peer of sockets.keys()) peer.send(JSON.stringify({type:'message.new',event_seq:seq,message}));
      }
    });
    socket.once('close',()=>sockets.delete(socket));
  });

  async function start(index,{login=true}={}) {
    const directory=path.join(profile,String(index));
    const official=store(directory,resolveChatConfig({}));
    if (login) await official.set('fixture-official-credential');
    const credentials=store(directory,own);
    const controller=createLobbyController({config:own, dataDir:lobbyDataDirectory(directory,own),secretStore:credentials,
      sharedExperience:false,openExternal:async value=>{
        const url=new URL(value);
        assert.equal(url.origin,origin);
        url.searchParams.set('fixture',String(index));
        assert.equal((await fetch(url)).status,200);
      }});
    controllers.push(controller);
    if (login) {
      assert.equal(controller.snapshot().auth.status,'signed-out');
      assert.equal(credentials.has(),false);
      assert.equal((await controller.request({action:'sign-in'})).ok,true);
    }
    assert.equal((await controller.request({action:'open'})).ok,true);
    await waitFor(()=>controller.snapshot().connection==='online','channel connected');
    assert.equal(controller.snapshot().me.user_id,people[index].user_id);
    assert.equal(await official.get(),'fixture-official-credential');
    return {controller,official,credentials};
  }
  const [a,b]=await Promise.all([start(0),start(1)]);
  for (const [sender,peer,text] of [[a,b,'第一条联调'],[b,a,'第二条联调']]) {
    assert.equal((await sender.controller.request({action:'send',text,origin:'human'})).ok,true);
    await waitFor(()=>peer.controller.snapshot().messages.some(message=>message.text===text),'peer receives the message');
  }
  await b.controller.request({action:'close'});
  await b.controller.request({action:'open'});
  await waitFor(()=>b.controller.snapshot().connection==='online'&&b.controller.snapshot().messages.length===2,'history after reconnect');
  b.controller.dispose();
  const restored=await start(1,{login:false});
  assert.equal(audit.filter(kind=>kind==='authorization_code').length,2);
  assert.ok(audit.includes('refresh_token'));
  assert.equal((await restored.controller.request({action:'sign-out'})).ok,true);
  assert.equal(restored.credentials.has(),false);
  assert.ok(audit.includes('revoke'));
  assert.equal(await restored.official.get(),'fixture-official-credential');
  assert.equal(a.controller.snapshot().auth.status,'signed-in');
});
