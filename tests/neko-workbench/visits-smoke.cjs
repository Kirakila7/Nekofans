'use strict';
// Integration smoke: real production controllers, HTTP clients, generator/SSE,
// Ed25519 verification, SQLite, and two Electron/WebRTC clients. Only upstream
// account/Verse/Connect/model services are local test doubles, explicitly labelled.
// Usage: node visits-smoke.cjs <repositoryRoot> <electron.exe>
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const USER = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
const peer = side => side === 'a' ? 'b' : 'a';
function rtcToken(subject, room, role) {
  const now = Math.floor(Date.now() / 1000);
  const value = [{ alg: 'HS256', typ: 'JWT' }, { iss: 'devkey', sub: subject, nbf: now - 5, exp: now + 600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true,
      canPublishSources: role === 'host' ? ['microphone'] : ['camera', 'microphone'] } }]
    .map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${value}.${crypto.createHmac('sha256', 'secret').update(value).digest('base64url')}`;
}
function createServices() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const now = Math.floor(Date.now()/1000);
  const pubkeys = { revoked: [], keys: [{ kid: 'smoke-key', alg: 'Ed25519',
    pub: keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url'), not_before:now-60, not_after:now+3600 }] };
  const notices = { a: [], b: [] }, presence = { a:'online', b:'online' }, rooms = new Map();
  const stats = { credentials:0, invited:0, accepted:0, endRequests:0, cancelRequests:0, modelCalls:0, modelBySide:{a:0,b:0},
    privateContextAbsent:true, legacyRequests:true, routes:[] };
  function ticket(claims) {
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${encoded}.${crypto.sign(null,Buffer.from(encoded),keys.privateKey).toString('base64url')}`;
  }
  const server = http.createServer(async(req,res)=>{
    try {
      const url = new URL(req.url,'http://127.0.0.1');
      const pieces=[]; for await(const p of req){pieces.push(p);if(Buffer.concat(pieces).length>200000)throw Error('body limit');}
      const body = pieces.length ? JSON.parse(Buffer.concat(pieces).toString()) : {};
      const side = req.headers.authorization === 'Bearer smoke-a' ? 'a' : req.headers.authorization === 'Bearer smoke-b' ? 'b' : null;
      const json = (value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
      stats.routes.push(`${req.method} ${url.pathname}`);
      if(url.pathname==='/api/visit/pubkeys')return json(pubkeys);
      if(url.pathname==='/v1/chat/completions'){
        const modelSide = body.model === 'smoke-model-a' ? 'a' : body.model === 'smoke-model-b' ? 'b' : null;
        if(!modelSide||req.headers.authorization!==`Bearer smoke-model-key-${modelSide}`)return json({error:'model_auth'},401);
        stats.modelCalls++;stats.modelBySide[modelSide]++;
        const system = body.messages?.find(m=>m.role==='system')?.content || '';
        stats.privateContextAbsent &&= !('tools' in body) && !JSON.stringify(body).includes('PRIVATE_SMOKE_MARKER')
          && system.includes('没有主人私聊') && !system.includes('用户确认过的记忆');
        const count=stats.modelBySide[modelSide];
        const reply=`${modelSide==='a'?'悠悠':'梨花'}第${count}句：${['来你家坐坐真开心，今天一起聊聊窗边的小鸟吧～','我也喜欢晒太阳，下次带一份小鱼干来分享吧～','今天聊得很开心，下次再来串门，拜拜喵～'][count-1]||'再见～'}`;
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
        const middle=Math.floor(reply.length/2);
        for(const text of [reply.slice(0,middle),reply.slice(middle)])res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content:text}}]})}\n\n`);
        res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      if(!side)return json({error:'unauthorized'},401);
      if(url.pathname==='/api/users/me')return json({user:{id:USER[side]}});
      if(url.pathname===`/api/users/${USER[side]}/following`)return json({total:1,items:[{id:USER[peer(side)],display_name:peer(side)==='a'?'悠悠的主人':'梨花的主人',is_mutual:true,online:true,presence_status:'online'}]});
      if(url.pathname==='/api/users/me/presence'){if(req.method==='PUT')presence[side]=body.status;return json({presence_status:presence[side]});}
      if(url.pathname==='/api/notifications')return json({items:notices[side]});
      if(url.pathname===`/api/users/${USER[peer(side)]}/visit-invite`){
        if(!rooms.has(body.visit_id))return json({error:'no_room'},404);
        stats.invited++;
        const notice={id:crypto.randomUUID(),payload:{type:'visit_invite',visit_id:body.visit_id,actor_id:USER[side],actor_display_name:side==='a'?'悠悠的主人':'梨花的主人',expires_at:body.expires_at}};
        notices[peer(side)].push(notice);return json(notice);
      }
      if(/^\/api\/notifications\/[a-f0-9-]+\/visit-response$/.test(url.pathname)){
        const id=url.pathname.split('/')[3]; const n=notices[side].find(n=>n.id===id);if(!n)return json({error:'not_found'},404);
        n.payload.response=body.accepted?'accepted':'declined';stats.accepted+=body.accepted?1:0;
        notices[peer(side)].push({id:crypto.randomUUID(),payload:{type:'visit_invite_response',visit_id:n.payload.visit_id,actor_id:USER[side],accepted:body.accepted}});
        return json({ok:true});
      }
      if(url.pathname==='/api/visit/credentials'){
        stats.credentials++;stats.legacyRequests &&= !('mode' in body);
        if('mode' in body)return json({code:'invalid_request'},400);
        let room=rooms.get(body.visit_id);
        if(body.role==='host'){if(body.target_user_id!==USER[peer(side)])return json({error:'not_friend'},403);room={host:side,target:peer(side)};rooms.set(body.visit_id,room);}
        else if(!room||room.target!==side)return json({error:'not_invited'},403);
        const vid=`cat-${side}-${body.visit_id.slice(0,8)}`,time=Math.floor(Date.now()/1000),exp=time+600;
        // Match deployed Connect: no top-level visit_id/role/mode, no publish.video,
        // no signed mode claim; media grants exist but this client never uses them.
        return json({vid,transport:'livekit',expires_at:exp,vendor_expires_at:exp,publish:{audio:true},
          ...(body.role==='host'?{direct:true,target_user_id:body.target_user_id,direct_invite_expires_at:exp}:{}),
          identity_ticket:ticket({v:1,kid:'smoke-key',iss:'neko-servers',aud:'neko-visit',visit_id:body.visit_id,vid,role:body.role,transport:'livekit',
            sub:crypto.createHash('sha256').update(USER[side]).digest('hex').slice(0,24),char_tag:body.char_tag,jti:crypto.randomBytes(16).toString('base64url'),iat:time,exp}),
          vendor:{livekit:{url:'ws://127.0.0.1:17880',token:rtcToken(vid,body.visit_id,body.role)}}});
      }
      if(/^\/api\/visit\/rooms\/[A-Za-z0-9_-]+\/(end|cancel)$/.test(url.pathname)){
        if(url.pathname.endsWith('/end')){stats.endRequests++;return json({code:'not_found'},404);}
        stats.cancelRequests++;return json({ok:true});
      }
      return json({error:'unknown_test_endpoint'},404);
    }catch{res.writeHead(500);res.end('{"error":"test_service_error"}');}
  });
  return {server,stats,rooms};
}

async function client() {
  const {app,BrowserWindow,ipcMain}=require('electron');
  const side=process.env.NEKO_VISIT_SMOKE_SIDE, repositoryRoot=process.env.NEKO_VISIT_SMOKE_REPOSITORY,
    baseUrl='http://127.0.0.1:17883',dataDir=process.env.NEKO_VISIT_SMOKE_DATA;
  process.send?.({type:'phase',side,phase:'starting'});
  const visitsDir=path.join(repositoryRoot,'apps/neko-workbench/visits');
  const {createVisitsController}=require(path.join(visitsDir,'controller.cjs'));
  const {createSocialClient}=require(path.join(visitsDir,'social-client.cjs'));
  const {createRtcTransport}=require(path.join(visitsDir,'rtc-transport.cjs'));
  app.setPath('userData',path.join(dataDir,'electron'));app.disableHardwareAcceleration();await app.whenReady();
  process.send?.({type:'phase',side,phase:'app-ready'});
  let signedIn=false;
  // OAuth account identity is the sole injected auth boundary; every subsequent
  // friend/invite/grant/key/model operation goes through the real HTTP clients.
  const oauth={async login(){signedIn=true;},async logout(){signedIn=false;},async getAccessToken(){return signedIn?`smoke-${side}`:null;},close(){}};
  const social=createSocialClient({baseUrl,getAccessToken:()=>oauth.getAccessToken(),clientId:crypto.randomUUID(),allowLoopbackForTests:true});
  let panel=null;
  const controller=createVisitsController({dataDir,repositoryRoot,oauth,social,
    getModelConfig:()=>({protocol:'openai-compatible',baseUrl:`${baseUrl}/v1`,model:`smoke-model-${side}`,requestTimeoutMs:5000,maxOutputTokens:512}),
    getModelSecret:()=>`smoke-model-key-${side}`,
    createTransport:(grant,signal)=>createRtcTransport({BrowserWindow,ipcMain,grant,signal}),
    pollMs:1000,
    onChange:state=>{process.send({type:'state',side,state});if(panel&&!panel.isDestroyed())panel.webContents.send('workbench:visits-state',state);},
  });
  ipcMain.handle('workbench:visits',async(event,input)=>{
    if(event.sender!==panel?.webContents||event.senderFrame!==panel.webContents.mainFrame)throw Error('invalid panel');
    return controller.action(input);
  });
  panel=new BrowserWindow({show:false,width:1000,height:1040,title:`串门测试 ${side}`,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(visitsDir,'panel-preload.cjs')}});
  await panel.loadFile(path.join(visitsDir,'panel.html'));
  process.on('message',async message=>{
    try{
      if(message.type==='action'){const result=await controller.action(message.input);process.send({type:'result',id:message.id,result});}
      if(message.type==='capture'){await new Promise(r=>setTimeout(r,150));const image=await panel.webContents.capturePage();fs.writeFileSync(message.file,image.toPNG());process.send({type:'result',id:message.id,result:{captured:true}});}
      if(message.type==='close'){await controller.close();panel.destroy();app.quit();}
    }catch(error){process.send({type:'result',id:message.id,error:error.code||error.message});}
  });
  process.send({type:'ready',side});
}

async function run() {
  const [repositoryRoot,executable]=process.argv.slice(2);
  if(!repositoryRoot||!fs.existsSync(executable||''))throw Error('Usage: visits-smoke.cjs <repositoryRoot> <electron.exe>');
  const artifactDir=path.join(repositoryRoot,'apps/neko-workbench/visits/_smoke',`controller-${crypto.randomUUID()}`);
  fs.mkdirSync(artifactDir,{recursive:true});
  const services=createServices();
  await new Promise((resolve,reject)=>{services.server.once('error',reject);services.server.listen(17883,'127.0.0.1',resolve);});
  console.log('Mock Verse/Connect/OpenAI test service: http://127.0.0.1:17883; process-owned, closed in finally');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const children={},pending=new Map(),states={},waiters=[];let next=0;
  function tick(){for(const item of [...waiters]){if(item.predicate()){waiters.splice(waiters.indexOf(item),1);clearTimeout(item.timer);item.resolve();}}}
  function waitFor(predicate,label,ms=45000){if(predicate())return Promise.resolve();return new Promise((resolve,reject)=>{const item={predicate,resolve,reject,timer:setTimeout(()=>reject(Error(`timeout_${label}`)),ms)};waiters.push(item);});}
  function rpc(side,type,fields={}){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(`rpc_timeout_${side}_${type}`));},35000);pending.set(id,{resolve,reject,timer});children[side].send({id,type,...fields});});}
  const action=(side,input)=>rpc(side,'action',{input});
  try{
    for(const side of ['a','b']){
      const dataDir=path.join(artifactDir,side);fs.mkdirSync(dataDir,{recursive:true});
      const child=spawn(executable,[__filename],{env:{...env,NEKO_VISIT_SMOKE_SIDE:side,NEKO_VISIT_SMOKE_REPOSITORY:repositoryRoot,NEKO_VISIT_SMOKE_DATA:dataDir},windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
      children[side]=child;
      child.stderr.on('data',chunk=>{
        // Only startup failure categories, never SDK lines or request payloads.
        for(const line of chunk.toString().split(/\r?\n/))if(/Error:|ERROR:|ERR_|bad option|Cannot find|SyntaxError/.test(line)&&!(/token|Bearer|userSig|privateMapKey/i.test(line)))console.log(`test child ${side}: ${line.slice(0,400)}`);
      });
      child.on('exit',code=>{console.log(`test child ${side}: exit=${code}`);if(code)for(const item of waiters)item.reject(Error(`child_${side}_exit_${code}`));});
      child.on('error',error=>{console.error(`test child ${side}: spawn_failed`);});
      child.on('message',message=>{
        if(message.type==='phase')console.log(`test child ${side}: ${message.phase}`);
        if(message.type==='ready'){states[side]={ready:true};tick();}
        if(message.type==='state'){const previous=states[side]?.state;states[side]={...states[side],state:message.state};
          if(message.state.session?.phase!==previous?.session?.phase)console.log(`controller ${side}: ${message.state.session?.phase||'idle'}`);tick();}
        if(message.type==='result'){const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error)):item.resolve(message.result);}}
        if(message.type==='failed')console.error(`test child ${side}: ${message.code}`);
      });
    }
    await waitFor(()=>states.a?.ready&&states.b?.ready,'ready');
    await Promise.all(['a','b'].map(side=>action(side,{action:'login'})));
    await action('a',{action:'savePersona',name:'悠悠',description:'喜欢晒太阳和分享小鱼干的猫娘。'});
    await action('b',{action:'savePersona',name:'梨花',description:'喜欢看窗边小鸟，期待好友来玩的猫娘。'});
    const inviting=await action('a',{action:'invite',userId:USER.b});
    const refreshed=await action('b',{action:'refresh'});if(refreshed.invitations.length!==1)throw Error('invitation_missing');
    await action('b',{action:'accept',notificationId:refreshed.invitations[0].notificationId});
    await waitFor(()=>['a','b'].every(side=>['ended','error'].includes(states[side]?.state?.session?.phase)),'six_turns',45000);
    for(const side of ['a','b'])if(states[side].state.session.phase!=='ended')throw Error(`session_${side}_${states[side].state.session.reason}`);
    const visitId=inviting.session.visitId;
    const histories=await Promise.all(['a','b'].map(side=>action(side,{action:'history',visitId})));
    const first=histories[0].history,second=histories[1].history;
    if(first.messages.length!==6||JSON.stringify(first.messages)!==JSON.stringify(second.messages))throw Error('histories_diverged');
    if(services.stats.modelCalls!==6||!services.stats.privateContextAbsent)throw Error('model_or_privacy_assertion_failed');
    if(!services.stats.legacyRequests||services.stats.endRequests!==0)throw Error('unsupported_endpoint_used');
    for(const side of ['a','b'])await rpc(side,'capture',{file:path.join(artifactDir,`panel-${side}.png`)});
    // Close the real controllers before reopening SQLite, proving persisted history
    // survives renderer/process teardown and is not a snapshot-only UI result.
    for(const side of ['a','b'])children[side].send({type:'close'});
    await Promise.all(Object.values(children).map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);})));
    if(services.stats.endRequests!==0)throw Error('unsupported_endpoint_used_during_cleanup');
    const {DatabaseSync}=require('node:sqlite');
    const persisted=['a','b'].map(side=>{
      const file=path.join(artifactDir,side,'visits/accounts',USER[side],'visits.sqlite');const db=new DatabaseSync(file,{readOnly:true});
      const visits=db.prepare('SELECT phase,reason FROM visits').all();const count=db.prepare('SELECT COUNT(*) AS n FROM visit_messages').get().n;db.close();
      if(visits.length!==1||visits[0].phase!=='ended'||count!==6)throw Error('persisted_history_failed');return{side,messages:count,phase:visits[0].phase,reason:visits[0].reason};
    });
    const result={ok:true,real:['controller','social HTTP client','Ed25519 verifier','generator/provider SSE HTTP','LiveKit RTC','two Electron processes','separate SQLite histories','panel renderer'],
      mocked:['OAuth account session','Verse/Connect service endpoints','OpenAI model responses'],messages:6,identicalHistories:true,modelCalls:services.stats.modelCalls,
      invited:services.stats.invited,accepted:services.stats.accepted,endRequests:services.stats.endRequests,
      serverContract:'deployed legacy credentials; no mode or end endpoint',legacyRequests:services.stats.legacyRequests,
      mediaPolicy:'client-only',cloudRoomEndConfirmed:false,privateContextAbsent:true,persisted,artifactDir};
    fs.writeFileSync(path.join(artifactDir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{
    for(const item of waiters)clearTimeout(item.timer);for(const item of pending.values())clearTimeout(item.timer);
    await Promise.all(Object.values(children).map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});if(child.connected)child.send({type:'close'});else child.kill();})));
    services.server.closeAllConnections();await new Promise(resolve=>services.server.close(resolve));
  }
}
(process.versions.electron?client():run()).catch(error=>{if(process.send){process.send({type:'failed',code:error.message});require('electron').app.exit(1);}else{console.error(error.message);process.exitCode=1;}});
