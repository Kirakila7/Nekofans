'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createYuiHomeIpc} = require('../../apps/neko-workbench/yui-home-ipc.cjs');

test('仅可信主窗口可读写家园且重用独立本地存储', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'yui-ipc-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const sent = [];
  const handle = createYuiHomeIpc({userDataDirectory:dir, assertCaller:e=>{if (!e.trusted) throw Error('请从工作台操作');}, publish:state=>sent.push(state.persistence.status)});
  await assert.rejects(handle({trusted:false},{action:'status'}), /工作台/);
  await assert.rejects(handle({trusted:true},{action:'sync'}), /操作无效/);
  await assert.rejects(handle({trusted:true},{action:'status',path:'/other/world.json'}), /参数无效/);
  await handle({trusted:true},{action:'place',x:1,y:2,z:3,material:'glass'});
  assert.deepEqual(sent,['saving','saved']);
  const blocks=(await handle({trusted:true},{action:'status'})).blocks;
  assert.ok(blocks.length > 35);
  assert.ok(blocks.some(b=>b.x===1&&b.y===2&&b.z===3&&b.material==='glass'));
  assert.deepEqual(await fs.readdir(path.join(dir,'yui-home')), ['world.json']);
});

test('异步初始化期间身份失效不会执行写操作', async () => {
  let resolveInit, writes = 0;
  const delayed = new Promise(resolve=>{resolveInit=resolve;});
  const handle = createYuiHomeIpc({userDataDirectory:'/unused', assertCaller:e=>{if(!e.trusted) throw Error('身份已失效');},publish:()=>{},createStore:()=>({}),createStorage:()=>delayed});
  const event={trusted:true};
  const result = handle(event,{action:'clear'});
  await Promise.resolve();
  event.trusted=false;
  resolveInit({subscribe:()=>{},command:()=>{writes++;},state:()=>({})});
  await assert.rejects(result,/身份已失效/);
  assert.equal(writes,0);
});

test('纹理只允许可信窗口读取，禁止指定路径并在异步返回前重新鉴权', async () => {
  let finish, calls=0;
  const textureProvider={load:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const handle=createYuiHomeIpc({userDataDirectory:'/unused',assertCaller:e=>{if(!e.trusted)throw Error('身份已失效');},publish:()=>{},textureProvider});
  await assert.rejects(handle({trusted:false},{action:'textures'}),/身份已失效/);
  await assert.rejects(handle({trusted:true},{action:'textures',path:'/other'}),/参数无效/);
  assert.equal(calls,0);
  const event={trusted:true};const pending=handle(event,{action:'textures'});event.trusted=false;
  finish({status:'available',source:'minecraft-local',materials:{}});
  await assert.rejects(pending,/身份已失效/);
  assert.equal(calls,1);
});

test('纹理重试仅允许可信主窗口触发，清除缓存后重新读取且不接受路径', async () => {
  let clearCount=0,loadCount=0,currentSource='minecraft-local',cached;
  const textureProvider={
    clearCache:()=>{clearCount++;cached=undefined;},
    load:async()=>{loadCount++;return cached ||= {status:'available',source:currentSource,materials:{}};},
  };
  const handle=createYuiHomeIpc({userDataDirectory:'/unused',assertCaller:e=>{if(!e.trusted)throw Error('身份已失效');},publish:()=>{},textureProvider});
  const trusted={trusted:true};
  assert.equal((await handle(trusted,{action:'textures'})).source,'minecraft-local');
  currentSource='yui-original';
  assert.equal((await handle(trusted,{action:'textures'})).source,'minecraft-local');
  await assert.rejects(handle({trusted:false},{action:'textures-retry'}),/身份已失效/);
  await assert.rejects(handle(trusted,{action:'textures-retry',path:'/other'}),/参数无效/);
  assert.equal(clearCount,0);
  assert.equal((await handle(trusted,{action:'textures-retry'})).source,'yui-original');
  assert.equal(clearCount,1);
  assert.equal(loadCount,3);
});

test('纹理重试期间身份失效时不向旧窗口返回结果', async () => {
  let finish,clearCount=0;
  const textureProvider={clearCache:()=>{clearCount++;},load:()=>new Promise(resolve=>{finish=resolve;})};
  const handle=createYuiHomeIpc({userDataDirectory:'/unused',assertCaller:e=>{if(!e.trusted)throw Error('身份已失效');},publish:()=>{},textureProvider});
  const event={trusted:true};
  const pending=handle(event,{action:'textures-retry'});
  event.trusted=false;
  finish({status:'available',source:'yui-original',materials:{}});
  await assert.rejects(pending,/身份已失效/);
  assert.equal(clearCount,1);
});

test('预加载只暴露专用入口，订阅可取消', async () => {
  const source = await fs.readFile(path.resolve(__dirname,'../../apps/neko-workbench/workbench-preload.cjs'),'utf8');
  const emitter = new EventEmitter(), exposed = {}, calls = [];
  emitter.invoke=(...args)=>{calls.push(args);return Promise.resolve('ok');};
  vm.runInNewContext(source, {require:name=>{
    assert.equal(name,'electron');
    return {ipcRenderer:emitter, contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}}};
  }});
  await exposed.nekoWorkbench.home({action:'status'});
  assert.equal(calls[0][0], 'workbench:home');
  const values = [];
  const off = exposed.nekoWorkbench.subscribeHome(value=>values.push(value));
  emitter.emit('workbench:home-state',{}, {ok:true});
  off();
  emitter.emit('workbench:home-state',{}, {ok:false});
  assert.deepEqual(values,[{ok:true}]);
});
