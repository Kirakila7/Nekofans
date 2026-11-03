'use strict';
// Opt-in real sandboxed Electron, offline official-origin responses and a fresh
// isolated profile. Never opens a user's browser, account, or network connection.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.versions.electron||process.env.NEKO_COMMUNITY_SESSION_QA_CHILD!=='1'){
 const {spawnSync}=require('node:child_process'),os=require('node:os');
 const runtime=process.env.NEKO_COMMUNITY_QA_ELECTRON;
 if(!runtime||!path.isAbsolute(runtime))throw Error('Set NEKO_COMMUNITY_QA_ELECTRON to an absolute Electron executable');
 const temporaryRoot=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(temporaryRoot,'neko-community-session-native-'));
 try{
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'neko-community-session-offline-qa',version:'1.0.0',main:'bootstrap.cjs'}));
  fs.writeFileSync(path.join(dir,'bootstrap.cjs'),'require('+JSON.stringify(__filename)+');\n');
  const env={...process.env,NEKO_COMMUNITY_SESSION_QA_CHILD:'1',NEKO_COMMUNITY_SESSION_QA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(runtime,[dir],{cwd:dir,env,encoding:'utf8',timeout:30000,windowsHide:true});
  if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  if(result.error)throw result.error;process.exitCode=result.status===0?0:1;
 }finally{assert.equal(path.dirname(path.resolve(dir)),temporaryRoot);assert(path.basename(dir).startsWith('neko-community-session-native-'));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}else{
 const {app,BrowserWindow,WebContentsView,session,ipcMain}=require('electron');
 const dir=process.env.NEKO_COMMUNITY_SESSION_QA_DIR;
 assert(dir&&path.isAbsolute(dir));
 app.setName('Neko Offline Community Session QA');
 app.setPath('home',dir);app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'session'));
 for(const flag of ['disable-background-networking','disable-component-update','disable-sync','no-first-run','disable-default-apps'])app.commandLine.appendSwitch(flag);
 app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
 const {createSocialController,COMMUNITY_PARTITION}=require('../../apps/neko-workbench/community-config.cjs');
 const origin='https://community.project-neko.cn',fixtureToken='offline-synthetic-access-only';
 const messages=[],environments=[],verified=[],requests=[];
 const waitFor=async fn=>{const deadline=Date.now()+8000;while(!fn()){if(Date.now()>deadline)throw Error('Offline community fixture timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
 async function run(){
  const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/community-session-preload.cjs'),'utf8');
  const preload=path.join(dir,'observed-preload.cjs');
  fs.writeFileSync(preload,"require('electron').ipcRenderer.send('qa:sandbox',{isMainFrame:process.isMainFrame,sandboxed:process.sandboxed,contextIsolated:process.contextIsolated,isTop:window.top===window});\n"+source);
  const isolated=session.fromPartition(COMMUNITY_PARTITION);
  await isolated.protocol.handle('https',request=>{
   const url=new URL(request.url);assert.equal(url.origin,origin,'all responses remain in the local official-origin fixture');
   if(url.pathname==='/api/users/me'){
    assert.equal(request.headers.get('authorization'),'Bearer '+fixtureToken);
    requests.push({path:url.pathname,verifiedSyntheticAuthorization:true});
    return new Response(JSON.stringify({user:{id:'community-local-fixture-user',display_name:'离线测试喵',username:'fixture-handle',auth_source:'oauth'},token_balance:1}),{headers:{'content-type':'application/json'}});
   }
   return new Response('<!doctype html><html><head><title>Offline fixture</title><script>localStorage.setItem("neko_oauth_access_token",'+JSON.stringify(fixtureToken)+');window.dispatchEvent(new Event("neko-auth-changed"));</script></head><body><button onclick="document.body.dataset.loginClicked=\'yes\'">登录 / 注册</button></body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
  });
  await isolated.protocol.handle('http',()=>new Response('offline',{status:403}));
  const host=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  host.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')}));
  const controller=createSocialController({WebContentsView:class extends WebContentsView{constructor(options){super({...options,webPreferences:{...options.webPreferences,preload,backgroundThrottling:false}});}},
   env:{},openExternal:()=>{throw Error('External navigation is forbidden in this fixture');},onAccountState:value=>verified.push(value)});
  ipcMain.on('qa:sandbox',(_event,value)=>environments.push(value));
  ipcMain.on('workbench:community-web-account',(event,value)=>{
   messages.push(value);assert(controller.acceptAccountState(event,value),'actual sandbox IPC must pass the real sender and top-frame checks');
  });
  try{
   await host.loadURL('data:text/html,<title>Isolated%20host</title>');
   await controller.action(host,{action:'open',site:'community',bounds:{x:0,y:0,width:800,height:600}});
   await waitFor(()=>controller.accountState.status==='signed-in');
   assert(environments.some(x=>x.isMainFrame===true&&x.sandboxed===true&&x.contextIsolated===true&&x.isTop===true));
   assert.deepEqual(controller.accountState,{status:'signed-in',userId:'community-local-fixture-user',name:'离线测试喵'});
   assert(!JSON.stringify(messages).includes(fixtureToken));assert(!JSON.stringify(verified).includes('token_balance'));
   const contents=controller.view.webContents,before=messages.length,count=requests.length;
   contents.send('workbench:community-web-state');await waitFor(()=>requests.length>count&&messages.length>before);
   assert(!messages.slice(before).some(x=>x.status==='checking'),'same verified session does not flap during a status request');
   controller.requestLogin();const loginRead=requests.length;await waitFor(()=>requests.length>loginRead);
   assert.equal(await contents.executeJavaScript("document.body.dataset.loginClicked||''"),'','verified login must not click a stale SPA sign-in button');
   await contents.executeJavaScript('localStorage.removeItem("neko_oauth_access_token");window.dispatchEvent(new Event("neko-auth-changed"));true;');
   await waitFor(()=>controller.accountState.status==='signed-out');
   assert.equal(controller.acceptAccountState({sender:host.webContents,senderFrame:host.webContents.mainFrame},{status:'signed-in',userId:'forged'}),false);
   controller.dispose();assert.equal(controller.accountState.status,'unknown');assert.equal(verified.at(-1).status,'unknown');
   console.log(JSON.stringify({ok:true,electron:process.versions.electron,realSandboxMainFrame:true,officialNestedUser:true,actualIpcAuthenticated:true,noCredentialsProjected:true,authEventCrossesIsolation:true,steadyBackgroundStatus:true,verifiedLoginNotRedirected:true,disposedIdentityUnknown:true,syntheticRequests:requests.length}));
  }finally{controller.dispose();host.destroy();}
 }
 app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(error.stack||String(error));app.exit(1);});
}
