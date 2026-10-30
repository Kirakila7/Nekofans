'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createYuiHomeFileStore, createYuiHomeStorage} = require('../../apps/neko-workbench/yui-home-storage.cjs');

test('首次打开保存新家，已有空存档不重新生成房屋', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yui-home-starter-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const store = createYuiHomeFileStore(dir);
  const first = await createYuiHomeStorage({store});
  const initial = first.state().blocks;
  assert.ok(initial.length > 35);
  assert.equal(JSON.parse(await store.load()).blocks.length, initial.length);
  await first.command({action:'place', x:0,y:0,z:0,material:'stone'});
  const reloaded = await createYuiHomeStorage({store});
  assert.equal(reloaded.state().blocks.find(b=>b.x===0&&b.y===0&&b.z===0).material, 'stone');
  assert.equal(reloaded.state().blocks.length, initial.length);
  await reloaded.command({action:'clear'});
  assert.deepEqual((await createYuiHomeStorage({store})).state().blocks, []);
});

test('首次保存失败可无修改重试，恢复后重新打开仍是小屋', async () => {
  let fail=true, saved=null;
  const store={load:async()=>saved, save:async text=>{if(fail) throw Error('disk full'); saved=text;}};
  const world=await createYuiHomeStorage({store});
  assert.equal(world.state().persistence.status, 'save-error');
  assert.equal(saved,null);
  const initial=world.state().blocks;
  fail=false;
  await world.command({action:'retry-save'});
  assert.equal(world.state().persistence.status,'saved');
  assert.deepEqual(world.state().blocks,initial);
  assert.deepEqual((await createYuiHomeStorage({store})).state().blocks,initial);
});

test('首次创建时已有新存档出现则保留并加载它', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yui-home-race-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const actual=createYuiHomeFileStore(dir);
  const other=await createYuiHomeStorage({store:actual});
  await other.command({action:'clear'});
  const store={...actual,load:async()=>null};
  let first=true;
  store.load=async()=>{if(first){first=false;return null;}return actual.load();};
  const world=await createYuiHomeStorage({store});
  assert.equal(world.state().persistence.status,'saved');
  assert.deepEqual(world.state().blocks,[]);
});

test('独立存档可重启恢复，原家园与 Minecraft 路径不会被访问', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yui-home-test-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const store = createYuiHomeFileStore(dir);
  const first = await createYuiHomeStorage({store});
  assert.ok(first.state().blocks.length > 35);
  await first.command({action:'clear'});
  const notifications = [];
  first.subscribe(s => notifications.push(s.persistence.status));
  await first.command({action:'place', x:1,y:2,z:3,material:'glass'});
  await first.command({action:'camera', azimuth:15,elevation:35,zoom:1.2});
  assert.deepEqual(notifications, ['saving','saved','saving','saved']);
  const restored = await createYuiHomeStorage({store});
  const state = restored.state();
  assert.equal(state.storage, 'workbench-local');
  assert.equal(state.synced, false);
  assert.equal(state.persistence.status, 'saved');
  assert.deepEqual(state.blocks, [{x:1,y:2,z:3,material:'glass'}]);
  assert.deepEqual(state.camera, {azimuth:15,elevation:35,zoom:1.2});
  assert.deepEqual(await fs.readdir(path.join(dir,'yui-home')), ['world.json']);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'yui-home','world.json'),'utf8')).version, 1);
});

test('存档损坏时禁止覆盖并提供可显示的错误', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yui-home-corrupt-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  await fs.mkdir(path.join(dir, 'yui-home'));
  const target = path.join(dir, 'yui-home', 'world.json');
  await fs.writeFile(target, '{bad json');
  const world = await createYuiHomeStorage({store:createYuiHomeFileStore(dir)});
  assert.equal(world.state().persistence.status, 'load-error');
  assert.match(world.state().persistence.error, /原文件已保留/);
  await assert.rejects(world.command({action:'place',x:0,y:0,z:0,material:'stone'}), /暂不能修改/);
  assert.equal(await fs.readFile(target,'utf8'), '{bad json');
});

test('保存失败明确提示未保存，可重试后恢复', async () => {
  let fail = true, saved;
  const store = {load:async()=>null, save:async text=>{if (fail) throw Error('disk full'); saved = text;}};
  const world = await createYuiHomeStorage({store});
  const initialCount = world.state().blocks.length;
  await assert.rejects(world.command({action:'place',x:0,y:0,z:0,material:'stone'}), /尚未保存/);
  assert.equal(world.state().persistence.status, 'save-error');
  assert.equal(world.state().blocks.length, initialCount);
  fail = false;
  await world.command({action:'place',x:1,y:0,z:0,material:'glass'});
  assert.equal(world.state().persistence.status, 'saved');
  assert.equal(JSON.parse(saved).blocks.length, initialCount);
});

test('并发变更按顺序保存，不回滚后一个状态', async () => {
  let saved;
  const store = {load:async()=>null, save:async text=>{await new Promise(r=>setTimeout(r,5)); saved = text;}};
  const world = await createYuiHomeStorage({store});
  const initialCount = world.state().blocks.length;
  await Promise.all([
    world.command({action:'place',x:0,y:0,z:0,material:'stone'}),
    world.command({action:'place',x:1,y:0,z:0,material:'glass'}),
  ]);
  assert.equal(JSON.parse(saved).blocks.length, initialCount);
  assert.equal(world.state().persistence.status, 'saved');
});
