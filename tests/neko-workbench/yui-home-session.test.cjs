'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createYuiHomeSession} = require('../../apps/neko-workbench/yui-home-session.cjs');

test('方块状态可增删替换，观察者收到独立副本', () => {
  const world = createYuiHomeSession({empty:true});
  const updates = [];
  const unsubscribe = world.subscribe(s => updates.push(s));
  const placed = world.command({action:'place', x:1, y:2, z:-3, material:'oak_planks'});
  assert.deepEqual(placed.blocks, [{x:1, y:2, z:-3, material:'oak_planks'}]);
  placed.blocks[0].material = 'invalid';
  assert.equal(world.state().blocks[0].material, 'oak_planks');
  updates[0].blocks.length = 0;
  assert.equal(world.state().blocks.length, 1);
  world.command({action:'place', x:1, y:2, z:-3, material:'glass'});
  assert.equal(world.state().blocks.length, 1);
  assert.equal(world.state().blocks[0].material, 'glass');
  world.command({action:'remove', x:1, y:2, z:-3});
  assert.deepEqual(world.state().blocks, []);
  assert.equal(updates.length, 3);
  unsubscribe();
  world.command({action:'place', x:0, y:0, z:0, material:'stone'});
  assert.equal(updates.length, 3);
});

test('新会话隔离，状态明确未同步，禁止个人家园及 Minecraft 操作', () => {
  const world = createYuiHomeSession({empty:true});
  world.command({action:'place', x:0, y:0, z:0, material:'stone'});
  const state = createYuiHomeSession({empty:true}).state();
  assert.equal(state.storage, 'session');
  assert.equal(state.synced, false);
  assert.equal(state.toolsConnected, false);
  assert.deepEqual(state.blocks, []);
  for (const action of ['sync', 'export', 'open_game', 'chat_send', 'remember', 'collaborate']) {
    assert.throws(() => world.command({action}), /尚未.*开放/);
  }
  assert.equal(world.state().blocks.length, 1);
});

test('非法方块和视角输入不会修改状态', () => {
  const world = createYuiHomeSession();
  const before = world.state();
  for (const input of [
    {action:'place', x:1.5, y:0, z:0, material:'stone'},
    {action:'place', x:65, y:0, z:0, material:'stone'},
    {action:'place', x:0, y:0, z:0, material:'arbitrary'},
    {action:'camera', azimuth:NaN},
    {action:'avatar', position:{mode:'world', position:{x:Infinity,y:0,z:0}}},
  ]) assert.throws(() => world.command(input));
  assert.deepEqual(world.state(), before);
  const after = world.command({action:'camera', elevation:200, zoom:0});
  assert.equal(after.camera.elevation, 80);
  assert.equal(after.camera.zoom, 0.4);
});

test('临时角色状态和第一视角与原场景接口兼容', () => {
  const world = createYuiHomeSession();
  world.command({action:'avatar_checkpoint', position:{mode:'world', control:'manual', form:'cat', position:{x:1.25,y:2,z:3}}});
  const state = world.command({action:'perspective', mode:'yui'});
  assert.equal(state.perspective, 'yui');
  assert.equal(state.avatar.form, 'cat');
  assert.equal(state.avatar.position.x, 1.25);
  assert.equal(state.avatarRevision, 1);
  assert.equal(world.command({action:'avatar_reset'}).avatar.form, 'human');
});

test('新世界有木地板、墙、窗和可通行的门洞', () => {
  const state = createYuiHomeSession().state();
  const at = (x,y,z)=>state.blocks.find(b=>b.x===x&&b.y===y&&b.z===z);
  assert.equal(at(0,0,0).material,'oak_planks');
  assert.equal(at(-3,1,0).material,'oak_planks');
  assert.equal(at(-3,2,0).material,'glass');
  assert.equal(at(0,1,2),undefined);
  assert.equal(at(0,2,2),undefined);
  assert.equal(at(0,3,2).material,'oak_planks');
});
