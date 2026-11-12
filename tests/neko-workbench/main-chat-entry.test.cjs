'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const appEntry=path.resolve(__dirname,'../../apps/neko-workbench/main.cjs');

if(!process.argv.includes('--entry-harness')){
  const test=require('node:test'),{execFile}=require('node:child_process');
  function runFixture(...args){
    return new Promise((resolve,reject)=>execFile(process.execPath,[__filename,'--entry-harness',...args],{timeout:15000,maxBuffer:2e6},(error,stdout,stderr)=>{
      if(error)return reject(new Error(`${stdout}\n${stderr}`));
      try{assert.match(stdout,/workbench main IPC fixture passed/);resolve();}catch(err){reject(err);}
    }));
  }
  test('actual workbench main registers trusted IPC for settings, one chat/store path, memory and clean quit',()=>runFixture());
  test('workbench discovers and binds an existing N.E.K.O. role through the settings window',()=>runFixture('--native-role-only'));
}else{
  (async()=>{
    const fs=require('node:fs'),os=require('node:os'),Module=require('node:module'),{EventEmitter}=require('node:events'),{createServer}=require('node:http');
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'neko-main-entry-'));
    Object.assign(process.env,{NEKO_WORKBENCH_DATA_DIR:path.join(temporary,'data'),NEKO_WORKBENCH_WORKSPACE:path.join(temporary,'work'),NEKO_WORKBENCH_DSH_CLI:path.join(temporary,'not-installed-dsh'),NEKO_WORKBENCH_DSH_MODULES:path.join(temporary,'not-installed-modules')});
    const handlers=new Map(),windows=[],menus=[];let quit=false;
    const app=new EventEmitter();app.setName=()=>{};app.setPath=()=>{};app.getPath=()=>temporary;app.requestSingleInstanceLock=()=>true;app.whenReady=()=>Promise.resolve();app.focus=()=>{};
    app.quit=()=>{let prevented=false;app.emit('before-quit',{preventDefault:()=>prevented=true});if(!prevented){quit=true;app.emit('quit');}};
    class Window extends EventEmitter{
      constructor(options){super();this.options=options;this.destroyed=false;this.visible=false;const contents=new EventEmitter();contents.url='';contents.mainFrame={url:''};contents.getURL=()=>contents.url;contents.send=()=>{};contents.setWindowOpenHandler=handler=>contents.openHandler=handler;contents.isDestroyed=()=>this.destroyed;contents.isLoading=()=>false;contents.setZoomFactor=value=>contents.zoom=value;this.webContents=contents;windows.push(this);}
      isDestroyed(){return this.destroyed;}show(){this.visible=true;}showInactive(){this.visible=true;}isVisible(){return this.visible;}hide(){this.visible=false;}focus(){}setTitle(){}setAlwaysOnTop(){}setVisibleOnAllWorkspaces(){}getPosition(){return[this.options.x||0,this.options.y||0];}setPosition(x,y){Object.assign(this.options,{x,y});}setBounds(bounds){Object.assign(this.options,bounds);}
      loadURL(url){this.webContents.url=url;this.webContents.mainFrame.url=url;setImmediate(()=>this.webContents.emit('did-finish-load'));return Promise.resolve();}
      destroy(){this.destroyed=true;this.emit('closed');}close(){this.destroy();}
      static fromWebContents(contents){return windows.find(window=>window.webContents===contents);}
    }
    class Tray extends EventEmitter{setTitle(){}setToolTip(){}popUpContextMenu(){}}
    const electron={app,BrowserWindow:Window,ipcMain:Object.assign(new EventEmitter(),{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)}),screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1440,height:1000}})},
      shell:{openExternal:()=>Promise.resolve(),openPath:()=>Promise.resolve()},Menu:{buildFromTemplate:template=>({template,popup(){menus.push(template);}}),setApplicationMenu(){}},Tray,
      nativeImage:{createEmpty:()=>({}),createFromPath:()=>({isEmpty:()=>false})},dialog:{showErrorBox(){},showMessageBox:()=>Promise.resolve(),showOpenDialog:()=>Promise.resolve({canceled:true})},nativeTheme:{shouldUseDarkColors:false},
      safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',encryptString:value=>Buffer.from('cipher:'+Buffer.from(value).toString('base64')),decryptString:bytes=>Buffer.from(bytes.toString().slice(7),'base64').toString()}};
    let runtime;
    const original=Module._load;Module._load=function(name,...args){if(name==='electron')return electron;if(name==='./main-chat-runtime.cjs'){const originalRuntime=original.call(this,name,...args);return {...originalRuntime,WorkbenchMainChat:class extends originalRuntime.WorkbenchMainChat{constructor(options){super({...options,memoryWorker:{request:async()=>{throw Error('fixture offline');},stop:async()=>{},close:async()=>{}}});runtime=this;}}};}return original.call(this,name,...args);};
    const wait=async predicate=>{for(let n=0;n<500;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('fixture wait timed out');};
    const invoke=(window,method,params={})=>handlers.get('pet:call')({sender:window.webContents,senderFrame:window.webContents.mainFrame},method,params);
    let requests=0;
    const roleOnly=process.argv.includes('--native-role-only'),sockets=[];
    const roleBaseUrl='http://127.0.0.1:48911';
    if(roleOnly){
      globalThis.fetch=async(url,options)=>{
        assert.equal(url,roleBaseUrl+'/api/characters');
        assert.equal(options.method||'GET','GET');
        return Response.json({'猫娘':{'旧角色':{},'另一只鱼':{}}});
      };
      globalThis.WebSocket=class extends EventTarget{
        constructor(url){super();sockets.push(url);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
        close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
      };
    }
    const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests++;if(requests>1){assert.equal(JSON.parse(body).messages.at(-1).content,'故障回归');res.writeHead(503);res.end();return;}assert.equal(JSON.parse(body).messages.at(-1).content,'我喜欢红茶');res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'我记住了。'}}]})+'\n\ndata: [DONE]\n\n');});});
    try{
      if(!roleOnly)await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      require(appEntry);
      await wait(()=>windows.length>0&&handlers.has('pet:call'));const pet=windows[0];await wait(async()=>!!(await invoke(pet,'state')).mainChat?.ready);
      assert.equal((await invoke(pet,'state')).actors[0].chatBackend,'deepseek-account','an unconfigured installation defaults to the workbench account');
      assert.equal(fs.existsSync(path.join(temporary,'data/main-chat/app-config.json')),false,'the default does not write over user configuration');
      await invoke(pet,'menu');const menu=menus.at(-1),fish=menu.find(item=>item.label==='养鱼');assert(fish);const memoryOptions=fish.submenu.find(item=>item.label==='N.E.K.O. 记忆').submenu;assert(memoryOptions.some(item=>item.label==='记忆与模型设置…'));assert(!memoryOptions.some(item=>item.type==='radio'||item.type==='checkbox'));
      fish.submenu.find(item=>item.label==='聊天 API 设置…').click();const settings=windows.find(window=>window.options.title==='聊天 API 设置');assert(settings);
      if(roleOnly){
        await invoke(settings,'chat-open-neko-settings');
        const picker=windows.find(window=>window.options.title==='接回 N.E.K.O. 角色');
        const baseUrl=roleBaseUrl;
        assert.deepEqual(await invoke(picker,'neko-list-characters',{baseUrl}),{baseUrl,names:['旧角色','另一只鱼']});
        assert.equal((await invoke(pet,'state')).actors[0].chatBackend,'deepseek-account','discovery does not switch chat backends');
        await assert.rejects(invoke(pet,'neko-list-characters',{baseUrl}),/请从 N.E.K.O. 聊天设置操作/);
        await assert.rejects(invoke(picker,'neko-settings',{baseUrl,character:'大肥鱼'}),/选择已有/);
        assert.equal(sockets.length,0);
        await invoke(picker,'neko-settings',{baseUrl,character:'旧角色'});
        assert.deepEqual(sockets,[baseUrl.replace('http:','ws:')+'/ws/'+encodeURIComponent('旧角色')]);
        const saved=JSON.parse(fs.readFileSync(path.join(temporary,'data/state.json'),'utf8'));
        assert.equal(saved.neko.character,'旧角色');
        assert.equal(saved.neko.baseUrl,baseUrl);
        assert.equal(saved.actors[0].chatBackend,'neko');
        app.quit();await wait(()=>quit);console.log('workbench main IPC fixture passed');return;
      }
      assert.equal((await invoke(settings,'chat-use-deepseek-account')).backend,'deepseek-account','the account backend may be selected explicitly');
      await assert.rejects(invoke(pet,'prompt',{id:'main',text:'未登录测试'}),/工作台账号状态暂不可用/);
      assert.equal((await runtime.history()).length,0,'preflight failure must not store a user message');
      const payload={protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-only',requestTimeoutMs:5000,maxOutputTokens:256,key:{action:'replace',value:'entry-fixture-key'}};
      await assert.rejects(handlers.get('pet:call')({sender:settings.webContents,senderFrame:{url:settings.webContents.getURL()}},'chat-settings-save',payload));
      await invoke(settings,'chat-settings-save',payload);const projection=await invoke(settings,'chat-settings-read');assert.equal(projection.backend,'chat-api','saving explicit API settings switches to the independent API');assert.equal(projection.hasKey,true);assert(!JSON.stringify(projection).includes('entry-fixture-key'));
      const accepted=await invoke(pet,'prompt',{id:'main',text:'我喜欢红茶'});assert.equal(accepted.backend,'chat-api');await wait(async()=>{const state=await invoke(pet,'state');return state.mainChat.chat.phase==='idle'&&state.actors[0].messages.some(message=>message.role==='assistant');});assert.equal(requests,1);
      await invoke(settings,'chat-open-memory');const memory=windows.find(window=>window.options.title==='聊天记忆');assert(memory);const snapshot=await invoke(memory,'chat-memory-read');assert.equal(snapshot.items.length,0);assert.equal(snapshot.replication.mode,'neko');assert(snapshot.replication.records.some(row=>row.value?.kind==='episode'));
      assert((await invoke(memory,'chat-memory-read')).replication.pending>0);assert.equal((await invoke(memory,'chat-history')).length,2);
      await invoke(pet,'menu');menus.at(-1).find(item=>item.label==='工作台选项').submenu.find(item=>item.label==='任务备注…').click();const notes=windows.find(window=>window.options.title==='任务备注');await invoke(notes,'memory',{text:'仅任务便签'});assert(!(await invoke(memory,'chat-memory-read')).items.some(item=>item.text.includes('仅任务便签')));
      await invoke(pet,'prompt',{id:'main',text:'故障回归'});await wait(async()=>(await invoke(pet,'state')).mainChat.chat.phase==='error');await wait(async()=>(await invoke(pet,'state')).actors[0].chatReply===null);const failed=await invoke(pet,'state');assert(failed.actors[0].notice?.text);assert.equal(failed.actors[0].chatReply,null,'failed turn must not restore an older assistant reply');
      const persisted=JSON.parse(fs.readFileSync(path.join(temporary,'data/state.json'),'utf8'));assert.deepEqual(persisted.actors.find(actor=>actor.id==='main').messages,[]);assert(!JSON.stringify(persisted).includes('entry-fixture-key'));
      await assert.rejects(invoke(pet,'chat-use-deepseek-account'),/请从聊天设置操作/);
      await assert.rejects(handlers.get('pet:call')({sender:settings.webContents,senderFrame:{url:settings.webContents.getURL()}},'chat-use-deepseek-account'));
      const accountProjection=await invoke(settings,'chat-use-deepseek-account');
      assert.equal(accountProjection.backend,'deepseek-account');assert.equal(accountProjection.hasKey,true);
      const historyBefore=await runtime.history();
      await assert.rejects(invoke(pet,'prompt',{id:'main',text:'隔离账号测试'}),/工作台账号状态暂不可用/);
      assert.equal((await runtime.history()).length,historyBefore.length,'a failed preflight must not store a user turn');
      const accountState=await invoke(pet,'state');assert.equal(accountState.actors[0].chatBackend,'deepseek-account');assert.equal(accountState.neko.enabled,false);
      app.quit();await wait(()=>quit);console.log('workbench main IPC fixture passed');
    }finally{if(!quit){app.quit();await wait(()=>quit);}Module._load=original;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
