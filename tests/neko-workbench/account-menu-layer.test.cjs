'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS,'node_modules/jsdom'));
const base=path.resolve(__dirname,'../../apps/neko-workbench');

test('account menu geometry follows open, resize, native login dialog and cleanup without sending account data',async t=>{
 const dom=new JSDOM('<div data-slot="settings.launcher"><button aria-haspopup="menu" aria-expanded="false" data-collapsed="true" data-signed-out="true">账号</button></div>',{url:'http://127.0.0.1/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,requests=[],flush=()=>new Promise(resolve=>w.setTimeout(resolve,5));let resize;
 w.ResizeObserver=class{constructor(fn){resize=fn;}observe(){}disconnect(){}};
 w.eval(fs.readFileSync(path.join(base,'embedded-dsh/account-habitat-source.js'),'utf8'));
 const bridge={getAccounts:async()=>({neko:{community:{status:'signed-out'},lobby:{status:'signed-out'}}}),accountMenuLayer:async request=>requests.push(JSON.parse(JSON.stringify(request)))};
 const ctx={locale:{getSnapshot:()=>({active:'zh-CN'})},remote:{account:{getState:async()=>({ok:true,value:{status:'signed-out'}}),getBalance:async()=>{throw Error('signed-out test must not read balance');}}}};
 const stop=w.installNekoAccountHabitat(ctx,{document:d,window:w,accountsBridge:bridge});t.after(()=>{stop();w.close();});await flush();
 assert.deepEqual(requests.at(-1),{rect:null});
 const menu=d.createElement('div');menu.dataset.menuMaterial='';menu.setAttribute('role','menu');menu.innerHTML='<div role="presentation"><button role="menuitem">设置</button><button role="menuitem">意见反馈</button><button role="menuitem">登录</button></div>';
 let geometry={left:74,top:320,width:340,height:460};menu.getBoundingClientRect=()=>({...geometry});d.body.append(menu);d.querySelector('[aria-haspopup]').setAttribute('aria-expanded','true');await flush();await flush();
 assert.deepEqual(requests.at(-1),{rect:{x:74,y:320,width:340,height:460}});
 const before=requests.length;resize();w.dispatchEvent(new w.Event('resize'));await flush();assert.equal(requests.length,before,'unchanged geometry is coalesced');
 geometry={...geometry,top:280,height:500};resize();assert.equal(requests.at(-1).rect.y,280);
 d.querySelector('[aria-haspopup]').setAttribute('aria-expanded','false');menu.remove();await flush();assert.deepEqual(requests.at(-1),{rect:null});
 const dialog=d.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>开始使用</h2><button>登录</button><button>添加 API Key</button>';let dialogHeight=400;dialog.getBoundingClientRect=()=>({left:300,top:180,width:500,height:dialogHeight});d.body.append(dialog);await flush();assert.deepEqual(requests.at(-1),{rect:{x:300,y:180,width:500,height:400}});dialogHeight=480;resize();assert.equal(requests.at(-1).rect.height,480,'native login dialog keeps its geometry observer after the account menu closes');
 stop();assert.deepEqual(requests.at(-1),{rect:null});assert(requests.every(request=>Object.keys(request).join(',')==='rect'));
});

test('menu layer IPC accepts only the current trusted workbench main frame and bounded rectangles',()=>{
 const main=fs.readFileSync(path.join(base,'main.cjs'),'utf8'),handlers=new Map(),calls=[];
 const contents={mainFrame:{url:'http://127.0.0.1:59099/coding'}},host={webContents:contents,isDestroyed:()=>false};
 const validation=main.slice(main.indexOf('function isWorkbenchOrigin'),main.indexOf('function rolesState'));
 const route=main.slice(main.indexOf("ipcMain.handle('workbench:account-menu-layer'"),main.indexOf("ipcMain.handle('workbench:native-composer'"));
 vm.runInNewContext(validation+route,{URL,dshWindow:host,dshLaunchUrl:'http://127.0.0.1:59099/',ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},nativeComposerController:{setAccountMenuRect:r=>calls.push(['composer',r])},videoFloatController:{setAccountMenuRect:r=>calls.push(['video',r])}});
 const action=handlers.get('workbench:account-menu-layer'),event={sender:contents,senderFrame:contents.mainFrame},rect={x:50,y:100,width:350,height:480};
 assert.equal(action(event,{rect}).ok,true);assert.equal(calls.length,2);
 for(const request of [null,[],{}, {rect:undefined},{rect,extra:true},{rect:{...rect,x:Infinity}},{rect:{...rect,width:0}},{rect:{...rect,height:100000}},{rect:{...rect,token:'PRIVATE'}}])assert.throws(()=>action(event,request));
 assert.throws(()=>action({...event,sender:{}},{rect}));assert.throws(()=>action({...event,senderFrame:{url:contents.mainFrame.url}},{rect}));
 contents.mainFrame.url='https://community.project-neko.cn/';assert.throws(()=>action(event,{rect}));contents.mainFrame.url='http://127.0.0.1:59099/coding';
 action(event,{rect:null});assert.equal(calls.length,4);assert.equal(calls.at(-1)[1],null);
});
