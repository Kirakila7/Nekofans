'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{execFile}=require('node:child_process');
if(!process.argv.includes('--harness')){
 test('actual main projects three real tiers, keeps background tasks, opens exact task and promotes late child identity',async()=>{
  await new Promise((resolve,reject)=>execFile(process.execPath,[__filename,'--harness'],{timeout:15000,maxBuffer:2e6},(error,stdout,stderr)=>{
   if(error)return reject(new Error(stdout+'\n'+stderr));assert.match(stdout,/three-tier main passed/);resolve();
  }));
 });
}else{
 (async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'neko-task-main-')),data=path.join(temporary,'data'),modules=path.join(temporary,'modules'),cli=path.join(temporary,'dsh');
  fs.writeFileSync(cli,'fixture');for(const name of ['dsh-llm','dsh-scope']){fs.mkdirSync(path.join(modules,name,'lib'),{recursive:true});fs.writeFileSync(path.join(modules,name,'lib/index.js'),'');}
  Object.assign(process.env,{NEKO_WORKBENCH_DATA_DIR:data,NEKO_WORKBENCH_WORKSPACE:path.join(temporary,'work'),NEKO_WORKBENCH_DSH_CLI:cli,NEKO_WORKBENCH_DSH_MODULES:modules,PET_OPEN_WORKBENCH:'0',PET_WORKBENCH_ONLY:'0'});
  const handlers=new Map(),windows=[],menus=[],requests=[];let stopped=false,stopFailure=false,stopRejected=false,selectedImage=null,now=Date.now();const originalNow=Date.now;Date.now=()=>now;
  const app=new EventEmitter();Object.assign(app,{setName(){},setPath(){},getPath:()=>temporary,requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),focus(){},quit(){let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(!prevented)stopped=true;}});
  const child=new EventEmitter();Object.assign(child,{pid:123,killed:false,stdout:new PassThrough(),stderr:new PassThrough(),kill(){child.killed=true;child.emit('close',0);}});
  const emit=(method,params)=>child.stdout.write(JSON.stringify({method,params})+'\n');
  child.stdin=new EventEmitter();child.stdin.write=line=>{const request=JSON.parse(line);requests.push(request);setImmediate(()=>child.stdout.write(JSON.stringify(stopFailure&&request.method==='stop'?{id:request.id,error:'private stop failure'}:{id:request.id,result:stopRejected&&request.method==='stop'?{accepted:false}:request.method==='init'?{sessionId:'root',uiUrl:'http://127.0.0.1:12345/'}:request.method==='fish-care'?{enabled:false,phase:request.params.action==='start'?'login-required':'paused',reason:'fixture'}:request.method==='qqbot-care'?{enabled:false,phase:'paused',reason:'fixture',bound:false,connected:false,scopeConfigured:false}:{accepted:true}})+'\n'));};child.stdin.end=()=>child.emit('close',0);
  class Window extends EventEmitter{
   constructor(options){super();this.options=options;this.bounds={x:options.x||0,y:options.y||0,width:options.width,height:options.height};this.destroyed=false;this.visible=false;const wc=new EventEmitter();Object.assign(wc,{url:'',mainFrame:{url:''},getURL:()=>wc.url,send(){},executeJavaScript:async()=>({width:512,height:512,stillDataUrl:'data:image/png;base64,'+fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/assets/neko-cat/still.png')).toString('base64')}),isDestroyed:()=>this.destroyed,isLoading:()=>false,setWindowOpenHandler(){},setZoomFactor:value=>wc.zoom=value,getZoomFactor:()=>wc.zoom||1,session:{cookies:{set:async()=>{}}}});this.webContents=wc;windows.push(this);}
   isDestroyed(){return this.destroyed;}show(){this.visible=true;}showInactive(){this.visible=true;}isVisible(){return this.visible;}hide(){this.visible=false;}focus(){}setTitle(value){this.title=value;}setAlwaysOnTop(){}setVisibleOnAllWorkspaces(){}getPosition(){return[this.bounds.x,this.bounds.y];}setPosition(x,y){this.bounds.x=x;this.bounds.y=y;}setBounds(value){Object.assign(this.bounds,value);}
   async loadURL(url){this.webContents.url=url;this.webContents.mainFrame.url=url;setImmediate(()=>this.webContents.emit('did-finish-load'));}destroy(){this.destroyed=true;this.emit('closed');}close(){this.destroy();}static fromWebContents(wc){return windows.find(w=>w.webContents===wc);}
  }
  class Tray extends EventEmitter{setTitle(){}setToolTip(){}popUpContextMenu(){}}
  const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1600,height:1000}})},shell:{openExternal:async()=>{},openPath:async()=>{}},Menu:{buildFromTemplate:template=>({template,popup(){menus.push(template);}}),setApplicationMenu(){}},Tray,nativeImage:{createEmpty:()=>({}),createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:512,height:512}),toPNG:()=>fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/assets/neko-cat/still.png'))})},dialog:{showErrorBox(){},showMessageBox:async()=>{},showOpenDialog:async()=>selectedImage?{canceled:false,filePaths:[selectedImage]}:{canceled:true,filePaths:[]}},nativeTheme:{shouldUseDarkColors:false},safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()}};
  const originalLoad=Module._load;Module._load=function(name,...args){if(name==='electron')return electron;if(name==='node:child_process')return{spawn(){setImmediate(()=>emit('ready',{}));return child;}};return originalLoad.call(this,name,...args);};
  const wait=async check=>{for(let n=0;n<500;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('fixture timed out');};
  const invoke=(w,method,params={})=>handlers.get('pet:call')({sender:w.webContents,senderFrame:w.webContents.mainFrame},method,params);
  const read=()=>invoke(windows[0],'state');
  const task=(id,patch={})=>({source:'dsh-task-session',sessionId:id,name:'真实任务',title:'真实任务',task:'处理资料',running:true,backgroundJobs:0,...patch});
  try{
   require('../../apps/neko-workbench/main.cjs');await wait(()=>windows.length&&handlers.has('pet:call'));await wait(async()=>(await read()).connection==='ready');
   emit('task-roster',{source:'dsh-task-session',sessionIds:['task-session']});emit('task-meta',task('task-session'));await wait(async()=>(await read()).helperDisplay.tasks===1);
   let s=await read(),a=s.actors.find(x=>x.kind==='task');const taskWindow=windows.find(w=>new URL(w.webContents.url).searchParams.get('actor')===a.id);assert(taskWindow);assert.equal(a.stageWidth,323);
   emit('agent-roster',{source:'dsh-subagent-catalog',sessionIds:['child']});emit('agent-meta',{source:'dsh-subagent-catalog',sessionId:'child',parentSessionId:'task-session',name:'真实帮手',mode:'continuable',running:true});await wait(async()=>(await read()).helperDisplay.subagents===1);s=await read();assert.equal(s.actors[0].stageWidth,462);assert.equal(s.actors.find(x=>x.sessionId==='child').stageWidth,239);assert.equal(s.actors[0].chatBackend,'chat-api');
   await invoke(windows[0],'menu');let settingsMenu=menus.at(-1).find(item=>item.label==='设置').submenu;
   settingsMenu.find(item=>item.label==='任务默认形象').submenu.find(item=>item.label==='N.E.K.O. 跑动小猫').click();
   s=await read();assert.equal(s.preferences.taskAppearance,'neko-cat');assert.equal(s.preferences.subagentAppearance,'dsh-original');assert.equal(s.actors[0].appearanceId,undefined);
   const childWindow=windows.find(w=>new URL(w.webContents.url).searchParams.get('actor')==='subagent-child');
   await invoke(childWindow,'menu');menus.at(-1).find(item=>item.label==='形象').submenu.find(item=>item.label==='N.E.K.O. 跑动小猫').click();
   await invoke(taskWindow,'menu');menus.at(-1).find(item=>item.label==='形象').submenu.find(item=>item.label==='大肥鱼 · 原有角色').click();
   const persisted=JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8'));assert.equal(persisted.preferences.taskAppearance,'neko-cat');assert.equal(persisted.actors.find(x=>x.sessionId==='child').appearanceId,'neko-cat');assert.equal(persisted.actors.find(x=>x.kind==='task').appearanceId,'dsh-original');
   await invoke(windows[0],'menu');menus.at(-1).find(item=>item.label==='形象').submenu.find(item=>item.label==='Claude 娘').click();
   s=await read();assert.equal(s.actors[0].appearanceId,'claude-girl');assert.equal(s.actors[0].chatBackend,'chat-api');assert.equal(s.actors[0].sessionId,null);assert(windows[0].bounds.width<478);assert(windows[0].bounds.height<379);
   await invoke(taskWindow,'menu');menus.at(-1).find(item=>item.label==='形象').submenu.find(item=>item.label==='Gemini 小猫').click();
   for(const [w,label]of [[windows[0],'Claude 娘 · 像素 Q 版'],[taskWindow,'Gemini 小猫 · 像素 Q 版'],[childWindow,'Claude 娘 · 像素 Q 版']]){await invoke(w,'menu');menus.at(-1).find(item=>item.label==='形象').submenu.find(item=>item.label===label).click();}
   s=await read();assert.equal(s.actors[0].appearanceId,'claude-pixel');assert.equal(s.actors.find(x=>x.kind==='task').appearanceId,'gemini-pixel');assert.equal(s.actors.find(x=>x.sessionId==='child').appearanceId,'claude-pixel');assert.equal(s.actors.find(x=>x.sessionId==='child').parentSessionId,'task-session');assert.equal(s.actors[0].chatBackend,'chat-api');
   await invoke(windows[0],'menu');settingsMenu=menus.at(-1).find(item=>item.label==='设置').submenu;
   for(const label of ['主角色默认形象','任务默认形象','子代理默认形象'])settingsMenu.find(item=>item.label===label).submenu.find(item=>item.label==='Gemini 小猫 · 像素 Q 版').click();
   const pixelSaved=JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8'));assert.deepEqual([pixelSaved.preferences.mainAppearance,pixelSaved.preferences.taskAppearance,pixelSaved.preferences.subagentAppearance],['gemini-pixel','gemini-pixel','gemini-pixel']);assert.equal(pixelSaved.actors[0].appearanceId,'claude-pixel');
   selectedImage=path.join(temporary,'my-character.gif');fs.copyFileSync(path.resolve(__dirname,'../../apps/neko-workbench/assets/neko-cat/cat-idle-cat4-3.gif'),selectedImage);
   await invoke(childWindow,'menu');await menus.at(-1).find(item=>item.label==='形象').submenu.find(item=>item.label==='导入自定义动图…').click();
   s=await read();assert.equal(s.actors.find(x=>x.sessionId==='child').appearanceId,'custom');assert(s.actors.find(x=>x.sessionId==='child').customAppearance.dataUrl.startsWith('data:image/gif;base64,'));assert(!JSON.stringify(s).includes(selectedImage));
   const beforeScaleHeight=childWindow.bounds.height;await invoke(childWindow,'menu');menus.at(-1).find(item=>item.label==='形象').submenu.find(item=>item.label==='形象大小').submenu.find(item=>item.label==='55%').click();assert.equal((await read()).actors.find(x=>x.sessionId==='child').appearanceScale,.55);assert(childWindow.bounds.height<beforeScaleHeight);
   await invoke(windows[0],'menu');await menus.at(-1).find(item=>item.label==='开始养鱼').click();s=await read();assert.equal(s.fish.phase,'login-required');assert.equal(s.actors[0].chatBackend,'chat-api');assert.equal(s.actors[0].sessionId,null);
   const fishWorkbench=windows.find(w=>w.options.title==='N.E.K.O. 工作台');const fishView=await handlers.get('workbench:call')({sender:fishWorkbench.webContents,senderFrame:fishWorkbench.webContents.mainFrame},'state');assert(fishView.navigation.fishSettingsRevision>0);
   const fileMenu=menus.at(-1).find(item=>item.label==='产出文件');assert(!fileMenu.submenu.some(item=>item.label?.includes('bili-whale.config.json')));
   await handlers.get('workbench:call')({sender:fishWorkbench.webContents,senderFrame:fishWorkbench.webContents.mainFrame},'fish','pause');assert.equal((await read()).fish.phase,'paused');
   await invoke(taskWindow,'open-task');const workbench=windows.find(w=>w.options.title==='N.E.K.O. 工作台');assert(workbench);const nav=await handlers.get('workbench:call')({sender:workbench.webContents,senderFrame:workbench.webContents.mainFrame},'state');assert.equal(nav.navigation.sessionId,'task-session');await assert.rejects(invoke(windows[0],'open-task'));
   emit('task-meta',task('task-session',{backgroundJobs:1}));emit('event',{sessionId:'task-session',event:{type:'turn/end',data:{reason:{kind:'completed'}}}});await wait(async()=>(await read()).actors.find(x=>x.kind==='task').backgroundJobs===1);assert.equal((await read()).actors.find(x=>x.kind==='task').active,true);
   emit('task-meta',task('task-session',{running:false,backgroundJobs:0,outcome:'completed'}));await wait(async()=>(await read()).actors.find(x=>x.kind==='task').active===false);
   now+=11000;emit('task-roster',{source:'dsh-task-session',sessionIds:['task-session']});await wait(async()=>(await read()).actors.find(x=>x.kind==='task').present===false);
   for(const [outcome,status] of [['killed','stopped'],['failed','error'],['unknown','idle']]){
    emit('task-meta',task('task-session',{backgroundJobs:1}));emit('event',{sessionId:'task-session',event:{type:'turn/end',data:{reason:{kind:'completed'}}}});emit('task-meta',task('task-session',{running:false,backgroundJobs:0,outcome}));
    await wait(async()=>(await read()).actors.find(x=>x.kind==='task').status===status);assert.equal((await read()).actors.find(x=>x.kind==='task').present,true);
   }
   for(const [reason,status] of [['failed','error'],['cancelled','stopped']]){
    emit('task-meta',task('task-session',{outcome:'completed'}));emit('event',{sessionId:'task-session',event:{type:'turn/end',data:{reason:{kind:reason}}}});
    await wait(async()=>(await read()).actors.find(x=>x.kind==='task').status===status);
   }
   emit('task-meta',task('task-session'));await wait(async()=>(await read()).actors.find(x=>x.kind==='task').active);stopFailure=true;
   await invoke(taskWindow,'menu');await menus.at(-1).find(item=>item.label==='停止当前任务').click();
   s=await read();assert.equal(s.connection,'ready');assert.equal(s.actors.find(x=>x.kind==='task').active,true);assert.match(s.actors.find(x=>x.kind==='task').notice.text,/未能停止/);assert(!JSON.stringify(s).includes('private stop failure'));stopFailure=false;
   stopRejected=true;await invoke(taskWindow,'menu');await menus.at(-1).find(item=>item.label==='停止当前任务').click();s=await read();assert.notEqual(s.actors.find(x=>x.kind==='task').status,'stopping');assert.equal(s.actors.find(x=>x.kind==='task').stopRequested,false);assert.equal(s.connection,'ready');stopRejected=false;
   emit('agent-meta',{source:'dsh-subagent-catalog',sessionId:'task-session',parentSessionId:'root',name:'真实委派身份',mode:'continuable',running:true});emit('agent-roster',{source:'dsh-subagent-catalog',sessionIds:['task-session','child']});await wait(async()=>(await read()).actors.some(x=>x.id==='subagent-task-session'));
   s=await read();assert.equal(s.actors.filter(x=>x.sessionId==='task-session').length,1);assert.equal(s.actors.find(x=>x.sessionId==='task-session').kind,'subagent');assert.equal(s.actors.find(x=>x.sessionId==='task-session').appearanceId,'gemini-pixel');assert.equal(taskWindow.destroyed,true);
   app.quit();await wait(()=>stopped);console.log('three-tier main passed');
  }finally{Module._load=originalLoad;Date.now=originalNow;fs.rmSync(temporary,{recursive:true,force:true});}
 })().catch(error=>{console.error(error);process.exitCode=1;});
}
