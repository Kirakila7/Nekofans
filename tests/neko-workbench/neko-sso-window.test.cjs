'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createNekoSsoWindow,officialChatAuthorization}=require('../../apps/neko-workbench/neko-sso-window.cjs');
const {buildAuthorizationUrl}=require('../../apps/neko-workbench/lobby-auth.cjs');
const valid=()=>buildAuthorizationUrl({authUrl:'https://auth.project-neko.cn',clientId:'neko-chat-desktop-prod',redirectUri:'http://127.0.0.1:48921/oauth/callback',state:'s'.repeat(43),challenge:'c'.repeat(43)});
test('SSO window validation loads even when every optional lobby module is absent',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/neko-sso-window.cjs'),'utf8'),module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,URL,require:name=>{assert.equal(name,'./community-config.cjs','optional lobby dependencies cannot become mandatory main-entry imports');return require('../../apps/neko-workbench/community-config.cjs');}});
 assert(module.exports.officialChatAuthorization(valid()));
});
class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.isDestroyed=()=>false;this.webContents.setWindowOpenHandler=f=>this.popup=f;Window.latest=this;}async loadURL(value){this.url=value;}isDestroyed(){return false;}close(){this.emit('closed');}}
test('only the exact official chat OAuth shape uses the existing community partition',async()=>{
 assert(officialChatAuthorization(valid()));for(const change of [['scope','openid offline profile email'],['redirect_uri','http://127.0.0.1:48924/oauth/callback'],['client_id','another-client'],['code_challenge_method','plain']]){const u=new URL(valid());u.searchParams.set(...change);assert.equal(officialChatAuthorization(u.href),null);}
 const external=[],sso=createNekoSsoWindow({BrowserWindow:Window,openExternal:u=>external.push(u)});await sso.open(valid());const win=Window.latest;assert.equal(win.options.webPreferences.partition,'persist:neko-community');assert.equal(win.options.webPreferences.nodeIntegration,false);assert.equal(win.options.webPreferences.sandbox,true);assert.equal(win.options.webPreferences.preload,undefined);assert.equal(win.url,valid());sso.dispose();
});
test('invalid schemes and credentials never reach shell; callback stays in the PKCE receiver and disposal has no late side effects',async()=>{
 const external=[],sso=createNekoSsoWindow({BrowserWindow:Window,openExternal:u=>external.push(u)});await sso.open(valid());const win=Window.latest;
 for(const url of ['javascript:alert(1)','file:///C:/private','data:text/html,test','https://user:secret@auth.project-neko.cn/']){let prevented=false;win.webContents.emit('will-navigate',{preventDefault(){prevented=true;}},url);assert(prevented);}
 await new Promise(r=>setImmediate(r));assert.deepEqual(external,[]);let prevented=false;win.webContents.emit('will-navigate',{preventDefault(){prevented=true;}},'http://127.0.0.1:48921/oauth/callback?code=synthetic&state=synthetic');assert.equal(prevented,false);
 sso.dispose();await assert.rejects(sso.open(valid()),/已关闭/);await assert.rejects(sso.open('javascript:alert(1)'));assert.deepEqual(external,[]);
});
