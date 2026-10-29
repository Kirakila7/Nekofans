'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { deflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const directory = path.resolve(__dirname, '../../apps/neko-workbench/visits');
const { validateGrant, frameText, createRtcTransport } = require(path.join(directory, 'rtc-transport.cjs'));
const sandbox = { module: { exports: {} }, TextEncoder, TextDecoder, Uint8Array, DataView, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(directory, 'rtc-renderer.js'), 'utf8'), sandbox);
const { fragment, createReceiver, createAdapter } = sandbox.module.exports;
function grant() {
  const body = { sub: 'cat-a', exp: Math.floor(Date.now() / 1000) + 100,
    video: { room: 'visit-a', roomJoin: true, canPublish: false, canSubscribe: false, canPublishData: true } };
  return { mode: 'text', role: 'host', vid: 'cat-a', visit_id: 'visit-a', transport: 'livekit',
    vendor: { livekit: { url: 'wss://rtc.example.test', token: `header.${Buffer.from(JSON.stringify(body)).toString('base64url')}.sig` } } };
}
test('text grant rejects media rights, expired or mismatched tokens and insecure endpoints', () => {
  assert.equal(validateGrant(grant()).mode, 'text');
  for (const patch of [ { canPublish: true }, { canSubscribe: true }, { canPublishData: false }, { room: 'other' } ]) {
    const g = grant(); const payload = JSON.parse(Buffer.from(g.vendor.livekit.token.split('.')[1], 'base64url'));
    Object.assign(payload.video, patch); g.vendor.livekit.token = `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
    assert.throws(() => validateGrant(g), /invalid_credentials/);
  }
  for (const field of ['mode', 'vid', 'visit_id']) { const g = grant(); g[field] = 'other'; assert.throws(() => validateGrant(g)); }
  const g = grant(); g.vendor.livekit.url = 'ws://remote.example.test'; assert.throws(() => validateGrant(g));
});
test('TRTC permissions are decoded from privateMapKey and media bits rejected', () => {
  const g = { ...grant(), transport: 'trtc', vendor: {} };
  const user = Buffer.from(g.vid), room = Buffer.from(g.visit_id);
  const buf = Buffer.alloc(3 + user.length + 22 + room.length); buf[0] = 1; buf.writeUInt16BE(user.length, 1); user.copy(buf, 3);
  const offset = 3 + user.length; buf.writeUInt32BE(123, offset); buf.writeUInt32BE(Math.floor(Date.now()/1000)+100, offset+8);
  buf.writeUInt32BE(3, offset+12); buf.writeUInt16BE(room.length, offset+20); room.copy(buf, offset+22);
  const key = () => deflateSync(JSON.stringify({ 'TLS.userbuf': buf.toString('base64') })).toString('base64').replace(/\+/g,'*').replace(/\//g,'-').replace(/=/g,'_');
  g.vendor.trtc = { sdk_app_id:123, user_id:g.vid, str_room_id:g.visit_id, private_map_key:key() };
  validateGrant(g); buf.writeUInt32BE(19, offset+12); g.vendor.trtc.private_map_key=key(); assert.throws(()=>validateGrant(g));
  g.mediaPolicy='client-only';g.role='guest';validateGrant(g);
  for(const [role,bits] of [['host',35],['host',47],['guest',19],['guest',31]]){
    g.role=role;buf.writeUInt32BE(bits,offset+12);g.vendor.trtc.private_map_key=key();validateGrant(g);
  }
  for(const [role,bits] of [['host',19],['guest',35],['host',63],['host',99],['guest',127],['host',34]]){
    g.role=role;buf.writeUInt32BE(bits,offset+12);g.vendor.trtc.private_map_key=key();assert.throws(()=>validateGrant(g));
  }
  g.role='host';buf.writeUInt32BE(35,offset+12);buf.writeUInt32BE(0,offset+8);g.vendor.trtc.private_map_key=key();assert.throws(()=>validateGrant(g));
});
test('explicit client-only policy accepts deployed LiveKit sources but rejects broadened or mismatched credentials',()=>{
  function legacy(role='host',patch={},claims={}) {
    const g=grant();g.role=role;g.mediaPolicy='client-only';
    const payload=JSON.parse(Buffer.from(g.vendor.livekit.token.split('.')[1],'base64url'));
    Object.assign(payload,claims);Object.assign(payload.video,{canPublish:true,canSubscribe:true,canPublishSources:role==='host'?['microphone']:['camera','microphone']},patch);
    g.vendor.livekit.token=`h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;return g;
  }
  validateGrant(legacy());validateGrant(legacy('guest'));
  for(const patch of [{roomAdmin:true},{roomCreate:true},{roomList:true},{roomRecord:true},{ingressAdmin:true},{destinationRoom:'other'},{canPublishSources:[]},{canPublishSources:['screen_share']},{canPublishSources:['camera']},{room:'other'},{canPublishData:false}]){
    assert.throws(()=>validateGrant(legacy('host',patch)));
  }
  for(const claims of [{sub:'wrong'},{exp:0},{exp:null},{exp:'not-a-time'},{nbf:Math.floor(Date.now()/1000)+60}])assert.throws(()=>validateGrant(legacy('host',{},claims)));
  const strict=legacy();delete strict.mediaPolicy;assert.throws(()=>validateGrant(strict));
  const invalid=legacy();invalid.mode='media';assert.throws(()=>validateGrant(invalid));
});
test('fragmentation handles UTF8 split boundaries and binds sender to vendor event', () => {
  const output=[]; const receive=createReceiver((x)=>output.push(x));
  const frame={text:'猫'.repeat(1200),senderVid:'forged'}; const parts=fragment(JSON.stringify(frame),5);
  assert.ok(parts.every(p=>p.length<=909));
  for (const p of [...parts].reverse()) receive('actual-vendor-id', p);
  assert.equal(output.length,1); assert.equal(output[0].senderVid,'actual-vendor-id'); assert.equal(output[0].frame.text,frame.text);
  assert.throws(()=>frameText({text:'猫'.repeat(1500)}),/too_large/);
});
test('reassembly rejects cross-sender mixing, duplicate indexes, invalid and oversized payloads', () => {
  const output=[]; const receive=createReceiver((x)=>output.push(x)); const parts=fragment(JSON.stringify({text:'x'.repeat(1900)}),5);
  receive('a',parts[0]); receive('a',parts[0]); receive('b',parts[1]); receive('a',parts[2]); assert.equal(output.length,0);
  receive('a',parts[1]); assert.equal(output.length,1);
  receive('bad sender',parts[0]); receive('a',new Uint8Array(5000)); assert.equal(output.length,1);
});
test('LiveKit legacy media grant still connects without subscriptions and only publishes data', async () => {
  let instance; const calls=[]; const output=[];
  class Room extends EventEmitter { constructor(){super();instance=this;this.localParticipant={publishData:(data,options)=>calls.push({data,options})};}
    async connect(url,token,options){calls.push({url,options});} async disconnect(){calls.push('disconnect');} }
  const sdk={Room,RoomEvent:{DataReceived:'data',Reconnecting:'reconnecting',Reconnected:'reconnected',Disconnected:'disconnected',ParticipantDisconnected:'peer-left'}};
  let disconnected=0;
  const legacy=grant();legacy.mediaPolicy='client-only';
  const payload=JSON.parse(Buffer.from(legacy.vendor.livekit.token.split('.')[1],'base64url'));
  Object.assign(payload.video,{canPublish:true,canSubscribe:true,canPublishSources:['microphone']});
  legacy.vendor.livekit.token=`h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;validateGrant(legacy);
  const a=await createAdapter({grant:legacy,sdk,onFrame:v=>output.push(v),onStatus:()=>{},onDisconnect:()=>{disconnected++;},sleep:async()=>{}});
  assert.equal(calls[0].options.autoSubscribe,false); await a.send(JSON.stringify({text:'hi'}));
  assert.equal(calls[1].options.reliable,true);
  instance.emit('data',calls[1].data,{identity:'cat-b'},0,'neko.visit.text.v1'); assert.equal(output[0].senderVid,'cat-b');
  instance.emit('peer-left',{identity:'cat-a'});assert.equal(disconnected,0);
  instance.emit('peer-left',{identity:'cat-b'});assert.equal(disconnected,1);
  await a.close(); await assert.rejects(a.send('{}'),/closed/); assert.equal(calls.at(-1),'disconnect');
});
test('TRTC stays data-only, applies pacing and never invokes media methods', async () => {
  const rtc=new EventEmitter(); const sent=[]; let options;
  rtc.enterRoom=async(o)=>{options=o;};rtc.sendCustomMessage=(v)=>sent.push(v);rtc.exitRoom=async()=>{};rtc.destroy=()=>{};
  const sdk={create:()=>rtc,TYPE:{SCENE_RTC:0,ROLE_ANCHOR:'anchor'},EVENT:{CUSTOM_MESSAGE:'message',KICKED_OUT:'kick',CONNECTION_STATE_CHANGED:'state',REMOTE_USER_EXIT:'peer-left'}};
  const waits=[]; const g={...grant(),transport:'trtc',vendor:{trtc:{}}};
  let disconnected=0;
  const a=await createAdapter({grant:g,sdk,onFrame:()=>{},onStatus:()=>{},onDisconnect:()=>{disconnected++;},sleep:async(ms)=>waits.push(ms)});
  assert.equal(options.autoReceiveAudio,false);assert.equal(options.autoReceiveVideo,false);
  await a.send(JSON.stringify({text:'猫'.repeat(700)})); assert.ok(sent.length>1); assert.ok(sent.every(v=>v.data.byteLength<=909));assert.ok(waits.every(ms=>ms===160));
  rtc.emit('peer-left',{userId:'cat-a',reason:1});assert.equal(disconnected,0);
  rtc.emit('peer-left',{userId:'cat-b',reason:1});assert.equal(disconnected,1);
  await a.close();rtc.emit('peer-left',{userId:'cat-b',reason:1});assert.equal(disconnected,1);
});
test('isolated IPC rejects other windows/subframes, bounds frames, and destroys resources', async () => {
  const ipcMain=new EventEmitter(); let instance; const config=[];
  class Window extends EventEmitter {
    constructor(options){super();instance=this;config.push(options);this.destroyed=false;this.webContents=new EventEmitter();
      const wc=this.webContents;wc.mainFrame={url:''};wc.session={setPermissionRequestHandler(fn){this.request=fn;},setPermissionCheckHandler(fn){this.check=fn;}};
      wc.setWindowOpenHandler=()=>{};wc.send=(channel,message)=>{if(message.type==='connect') queueMicrotask(()=>ipcMain.emit(channel,{sender:wc,senderFrame:wc.mainFrame},{type:'joined'}));
        if(message.type==='send')queueMicrotask(()=>ipcMain.emit(channel,{sender:wc,senderFrame:wc.mainFrame},{type:'sent',id:message.id,ok:true}));};
    }
    async loadURL(url){this.webContents.mainFrame.url=url;this.channel='neko-visit-rtc:'+config[0].webPreferences.additionalArguments[0].split('=')[1];
      ipcMain.emit(this.channel,{sender:this.webContents,senderFrame:this.webContents.mainFrame},{type:'ready'});}
    isDestroyed(){return this.destroyed;}destroy(){this.destroyed=true;this.emit('closed');}
  }
  const transport=await createRtcTransport({BrowserWindow:Window,ipcMain,grant:grant()});const received=[];transport.onMessage(v=>received.push(v));
  const msg={type:'frame',senderVid:'cat-b',frame:{text:'hi'}};
  ipcMain.emit(instance.channel,{sender:{},senderFrame:instance.webContents.mainFrame},msg);
  ipcMain.emit(instance.channel,{sender:instance.webContents,senderFrame:{url:instance.webContents.mainFrame.url}},msg);assert.equal(received.length,0);
  ipcMain.emit(instance.channel,{sender:instance.webContents,senderFrame:instance.webContents.mainFrame},msg);assert.equal(received.length,1);
  assert.equal(config[0].webPreferences.sandbox,true);assert.equal(instance.webContents.session.check(),false);
  await transport.send({text:'hi'});transport.close();assert.equal(instance.destroyed,true);assert.equal(ipcMain.listenerCount(instance.channel),0);
});
test('bundled SDK bytes match reviewed pinned hashes',()=>{
  for(const [name,sha] of [['trtc.js','9a79b7f20e258aed4579d352d59ac2482d58937e534417a68b2e61e98f4a6c25'],['livekit-client.umd.js','7fa17e37af5e996d8a25f15a637dcc0620215bc01b394e5d209f726afe7dc04d']]) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(directory,'vendor',name))).digest('hex'),sha);
  }
});
test('aborting a pending join immediately destroys its private window and IPC', async () => {
  const controller=new AbortController();const ipcMain=new EventEmitter();let instance;
  class Window extends EventEmitter {
    constructor(){super();instance=this;this.destroyed=false;this.webContents=new EventEmitter();
      Object.assign(this.webContents,{mainFrame:{url:''},session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},setWindowOpenHandler(){}});
    }
    async loadURL(){queueMicrotask(()=>controller.abort());}
    isDestroyed(){return this.destroyed;}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  await assert.rejects(createRtcTransport({BrowserWindow:Window,ipcMain,grant:grant(),signal:controller.signal}),/connect_failed/);
  assert.equal(instance.destroyed,true);assert.equal(ipcMain.eventNames().length,0);
  await assert.rejects(createRtcTransport({BrowserWindow:Window,ipcMain,grant:grant(),signal:controller.signal}),/aborted/);
});
