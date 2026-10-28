'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createScreenShare}=require('../../apps/neko-workbench/screen-share-controller.cjs');
const target={protocol:'openai-compatible',baseUrl:'https://example.com/v1',model:'image-model'};
class Contents extends EventEmitter{
 constructor(){super();this.mainFrame={url:''};this.session={setPermissionCheckHandler:fn=>this.check=fn,setPermissionRequestHandler:fn=>this.permission=fn,setDisplayMediaRequestHandler:fn=>this.display=fn};}
 isDestroyed(){return !!this.closed;}getURL(){return this.mainFrame.url;}loadURL(url){this.mainFrame.url=url;return Promise.resolve();}setWindowOpenHandler(fn){this.popup=fn;}send(_name,value){this.last=value;}focus(){}close(){this.closed=true;}
}
function fixture(t,extra={}){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-share-'));let view;const calls=[];let getter;let rows=[{id:'window:12:0',name:'test window'},{id:'screen:1:0',name:'whole desktop'}];
 class View{constructor(options){this.options=options;this.webContents=new Contents();view=this;}setBounds(value){this.bounds=value;}}
 const host=new EventEmitter();host.webContents=new Contents();host.webContents.executeJavaScript=async()=>({left:250,bottom:750});host.webContents.getZoomFactor=()=>1;host.isDestroyed=()=>false;host.getContentSize=()=>[1100,780];host.contentView={addChildView(){},removeChildView(){}};
 const chat={settings:{baseUrl:'https://example.com/v1',model:'image-model',protocol:'openai-compatible'},secretStore:{has:()=>true},opened:{}};
 const feature=createScreenShare({WebContentsView:View,desktopCapturer:{getSources:async options=>{calls.push(options);return getter ? getter(options) : rows;}},systemPreferences:{getMediaAccessStatus:()=> 'granted'},dataDir:directory,repositoryRoot:path.resolve(__dirname,'../..'),safeStorage:{},getChat:()=>chat,getHost:()=>host,onReply(){},...extra});
 t.after(()=>{feature.dispose();fs.rmSync(directory,{recursive:true,force:true});});
 return {feature,host,calls,get view(){return view;},event(){return {sender:view.webContents,senderFrame:view.webContents.mainFrame};},setRows:value=>rows=value,setGetter:fn=>getter=fn};}
test('isolated local panel enumerates names only; selection grants exact source once without audio',async t=>{
 const f=fixture(t);await f.feature.open();assert.equal(f.view.options.webPreferences.sandbox,true);assert.equal(f.view.options.webPreferences.nodeIntegration,false);
 const rows=await f.feature.action(f.event(),'sources');assert.equal(rows.length,2);assert.equal(f.calls[0].thumbnailSize.width,0);
 await f.feature.action(f.event(),'start',{target,sourceId:'window:12:0'});let granted;
 await f.view.webContents.display({frame:f.view.webContents.mainFrame,videoRequested:true,audioRequested:false},value=>granted=value);
 assert.equal(f.view.webContents.check(f.view.webContents,'media','',{}),false);assert.equal(f.view.webContents.check(f.view.webContents,'display-capture','',{isMainFrame:true}),true);
 assert.equal(granted.video.id,'window:12:0');assert.equal(granted.audio,undefined);
 await f.view.webContents.display({frame:f.view.webContents.mainFrame,videoRequested:true},value=>granted=value);assert.deepEqual(granted,{});
 f.host.emit('hide');assert.equal(f.feature.read().phase,'paused');assert.equal(f.feature.isOpen,false);
});
test('source loss never falls back to screen and cross-frame callers are rejected',async t=>{
 const f=fixture(t);await f.feature.open();await f.feature.action(f.event(),'sources');await f.feature.action(f.event(),'start',{target,sourceId:'window:12:0'});f.setRows([{id:'screen:1:0',name:'whole desktop'}]);let granted;
 await f.view.webContents.display({frame:f.view.webContents.mainFrame,videoRequested:true},value=>granted=value);assert.deepEqual(granted,{});assert.equal(f.feature.read().phase,'paused');
 await assert.rejects(f.feature.action({...f.event(),senderFrame:{}},'state'),/面板/);f.feature.hide();await assert.rejects(f.feature.action(f.event(),'start',{target,sourceId:'window:12:0'}),/面板/);
});
test('audio capture requests and external navigation are denied',async t=>{
 const f=fixture(t);await f.feature.open();await f.feature.action(f.event(),'sources');await f.feature.action(f.event(),'start',{target,sourceId:'window:12:0'});let granted;
 await f.view.webContents.display({frame:f.view.webContents.mainFrame,videoRequested:true,audioRequested:true},value=>granted=value);assert.deepEqual(granted,{});
 let blocked=false;f.view.webContents.emit('will-navigate',{preventDefault(){blocked=true;}},'https://example.com');assert(blocked);assert.equal(f.view.webContents.popup().action,'deny');
});
test('legacy screen permission only accepts empty mediaTypes while a selected grant is pending',async t=>{
 const f=fixture(t);await f.feature.open();await f.feature.action(f.event(),'sources');await f.feature.action(f.event(),'start',{target,sourceId:'window:12:0'});
 const c=f.view.webContents,check=(types)=>{let allowed;c.permission(c,'media',value=>allowed=value,{isMainFrame:true,requestingUrl:c.getURL(),mediaTypes:types});return allowed;};
 assert.equal(check([]),true);assert.equal(check(['video']),false);assert.equal(check(['audio']),false);f.feature.hide();assert.equal(check([]),false);
});
test('late selection lookup cannot pause or grant access to a newly chosen source',async t=>{
 const f=fixture(t);await f.feature.open();await f.feature.action(f.event(),'sources');await f.feature.action(f.event(),'start',{target,sourceId:'window:12:0'});
 let resolve;f.setGetter(()=>new Promise(r=>resolve=r));let granted;
 const old=f.view.webContents.display({frame:f.view.webContents.mainFrame,videoRequested:true},value=>granted=value);
 await f.feature.action(f.event(),'start',{target,sourceId:'screen:1:0'});resolve([{id:'window:12:0',name:'old'}]);await old;
 assert.deepEqual(granted,{});assert.equal(f.feature.read().phase,'sharing');assert.equal(f.feature.read().source.id,'screen:1:0');
});
test('closing while open awaits another panel cannot attach after cancellation',async t=>{
 let finish;const f=fixture(t,{onOpen:()=>new Promise(r=>finish=r)});const opening=f.feature.open();f.feature.hide();finish();await opening;assert.equal(f.feature.isOpen,false);assert.equal(f.view,undefined);
});
test('private context requires the exact disclosed visual service and model',async t=>{
 const f=fixture(t);await f.feature.open();await f.feature.action(f.event(),'sources');
 await assert.rejects(f.feature.action(f.event(),'start',{target,sourceId:'window:12:0',contextConsent:{protocol:'openai-compatible',baseUrl:'https://other.example/v1',model:'image-model'}}),/重新确认/);
 await assert.rejects(f.feature.action(f.event(),'start',{target,sourceId:'window:12:0',contextConsent:{protocol:'openai-compatible',baseUrl:'https://example.com/v1',model:'different'}}),/重新确认/);
 const state=await f.feature.action(f.event(),'start',{target,sourceId:'window:12:0',contextConsent:{protocol:'openai-compatible',baseUrl:'https://example.com/v1',model:'image-model'}});assert.equal(state.phase,'sharing');
});
test('every sharing start requires the exact target displayed to the user',async t=>{
 const f=fixture(t);await f.feature.open();await f.feature.action(f.event(),'sources');
 for(const candidate of [undefined,{...target,protocol:'anthropic'},{...target,baseUrl:'https://example.com/other'},{...target,model:'other'}])
  await assert.rejects(f.feature.action(f.event(),'start',{sourceId:'window:12:0',target:candidate}),/重新确认/);
 assert.equal(f.feature.read().phase,'idle');
});
