'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createStoryPrototypeLauncher}=require('../../apps/neko-workbench/story-prototype-launcher.cjs');

test('starts only the designated local project, keeps bridge token out of result, and stops it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-story-test-'));
  fs.writeFileSync(path.join(root,'server.js'),"if(!process.env.NEKO_AI_BRIDGE_TOKEN)process.exit(1); console.log('127.0.0.1:8787（仅本机'); setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));");
  const token='a'.repeat(64);let stops=0;
  const relay={stop:async()=>{stops++;},start:async()=>({status:'started',token,baseUrl:'http://127.0.0.1:1234/v1',model:'fixture',label:'fixture'})};
  const launcher=createStoryPrototypeLauncher({projectDir:root,executable:process.execPath,relay});
  t.after(async()=>{await launcher.stop();fs.rmSync(root,{recursive:true,force:true});});
  const result=await launcher.start();
  assert.deepEqual(result,{status:'started',origin:'http://127.0.0.1:8787'});
  assert(!JSON.stringify(result).includes(token));
  assert.equal((await launcher.start()).status,'running');
  await launcher.stop();assert(stops>=2);
});

test('the one-click path creates and binds one local story room, then reopens it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'neko-story-open-'));
  fs.writeFileSync(path.join(root,'server.js'),"console.log('127.0.0.1:8787（仅本机'); setInterval(()=>{},1000);");
  const origin='http://127.0.0.1:8787',roomId='r-0123abcd',url=origin+'/room/'+roomId+'?token=white-fixture';
  let bound=null,creates=0;const opened=[];
  const relay={
    stop:async()=>{bound=null;},
    start:async()=>({status:'started',token:'bridge-fixture',baseUrl:origin,model:'fixture',label:'fixture'}),
    status:()=>({status:'running',bound:!!bound,roomId:bound}),
    bind:async({roomId:id,prototypeOrigin})=>{assert.equal(prototypeOrigin,origin);bound=id;return {status:'bound'};},
  };
  const launcher=createStoryPrototypeLauncher({projectDir:root,executable:process.execPath,relay,fetchImpl:async(path,options)=>{
    creates++;assert.equal(path,origin+'/api/rooms');assert.equal(options.redirect,'error');
    assert.equal(JSON.parse(options.body).scenario,'story-v1');
    return Response.json({ok:true,roomId,links:{white:url,black:'black-fixture',goddess:'goddess-fixture'}});
  }});
  t.after(async()=>{await launcher.stop();fs.rmSync(root,{recursive:true,force:true});});
  const open=async link=>{assert.equal(bound,roomId);opened.push(link);};
  for(let n=0;n<2;n++)assert.deepEqual(await launcher.openRoom(open),{status:'opened',roomId});
  assert.equal(creates,1);assert.deepEqual(opened,[url,url]);
});

test('unconfigured or relative project directories never start the relay', async () => {
  const relay = {
    status: () => ({status:'idle'}),
    start: () => assert.fail('the relay must not start'),
    stop: () => assert.fail('the relay must not be touched'),
  };
  for (const projectDir of [undefined, '.']) {
    const launcher = createStoryPrototypeLauncher({projectDir, executable:process.execPath, relay});
    assert.deepEqual(await launcher.start(), {status:'missing-project'});
    assert.deepEqual(await launcher.openRoom(() => assert.fail('the browser must not open')), {status:'missing-project'});
  }
});

test('the bundled three-seat story can be played through to a guessed-rule victory', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-bundled-story-'));
  const hostToken = 'a'.repeat(64);
  const relay = {
    start: async () => ({status: 'started', token: hostToken, baseUrl: 'http://127.0.0.1:1234/v1'}),
    stop: async () => {},
    status: () => ({status: 'running'}),
    bind: async () => ({status: 'account-unavailable'}),
  };
  const launcher = createStoryPrototypeLauncher({
    projectDir: path.resolve(__dirname, '../../services/nekofans-game-hub/story-trial'),
    dataDir,
    executable: process.execPath,
    relay,
  });
  t.after(async () => {
    await launcher.stop();
    fs.rmSync(dataDir, {recursive: true, force: true});
  });

  const links = {};
  const roomIds = new Set();
  for (const side of ['white', 'black', 'goddess']) {
    const result = await launcher.openRoom(url => {links[side] = new URL(url);}, side);
    assert.equal(result.status, 'opened');
    assert.equal(result.modelConnected, false);
    assert.deepEqual(Object.keys(result).sort(), ['modelConnected', 'roomId', 'status']);
    roomIds.add(result.roomId);
    const page = await fetch(links[side]);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /棋局/);
  }
  assert.equal(roomIds.size, 1);
  const [roomId] = roomIds;
  const base = links.white.origin + '/api/rooms/' + roomId;
  assert.equal((await fetch(links.white.origin + '/api/rooms', {method: 'POST'})).status, 403);
  assert.equal((await fetch(base + '/enable-model' + links.white.search, {method: 'POST'})).status, 403);

  async function call(side, action, body) {
    const response = await fetch(base + '/' + action + links[side].search, {
      ...(body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {}),
    });
    const value = await response.json();
    assert.equal(response.status, 200, value.error);
    return value;
  }

  const rules = {white: '开源，共享退场棋子的走法', black: '抹除笔记，知道真名才可以移除'};
  for (const side of ['white', 'black']) {
    await call(side, 'rule', {text: rules[side]});
    await call('goddess', 'goddess/rule', {seat: side, action: 'approve'});
  }
  await call('goddess', 'goddess/settings', {reviewMode: false});
  await call('goddess', 'goddess/start', {});
  assert.doesNotMatch(JSON.stringify(await call('white', 'state')), /抹除笔记|梁文峰|梁武帝/);
  assert.doesNotMatch(JSON.stringify(await call('black', 'state')), /开源，共享/);
  await call('white', 'move', {from: 'e2', to: 'e4'});
  assert.equal((await call('black', 'extra', {target: 'e1', name: '梁武帝'})).result, 'failed');
  await call('black', 'move', {from: 'e7', to: 'e5'});
  await call('white', 'move', {from: 'g1', to: 'f3'});
  await call('goddess', 'goddess/private-field', {square: 'b1', name: '测试白马'});
  assert.equal((await call('black', 'extra', {target: 'b1', name: '测试白马'})).result, 'success');
  await call('black', 'move', {from: 'b8', to: 'c6'});
  const afterBorrow = await call('white', 'special', {type: 'n', from: 'a1', to: 'b3'});
  assert.equal(afterBorrow.state.game.moves.at(-1).kind, 'special');
  await call('black', 'special', {type: 'n', from: 'h8', to: 'g6'});
  await call('white', 'guess', {text: '对方能用棋子的真名把它抹掉'});
  const {state: host} = await call('goddess', 'state');
  await call('goddess', 'goddess/judge-guess', {guessId: host.goddess.guesses[0].id, correct: true});
  for (const side of ['white', 'black']) {
    const {state} = await call(side, 'state');
    assert.equal(state.phase, 'finished');
    assert.equal(state.game.result.winner, 'white');
    assert.equal(state.game.result.reason, 'guess');
    assert.equal(state.revealed.black.text, rules.black);
    assert.doesNotMatch(JSON.stringify(state.game), /梁文峰|测试白马/);
  }
});

test('the bundled white seat passes only its own context to a bound account relay', async t => {
  const {createPrototypeModelRelay} = require('../../apps/neko-workbench/prototype-model-relay.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-story-model-'));
  const playerCalls = [];
  const relay = createPrototypeModelRelay({
    rpc: async (method, args) => {
      if (method.endsWith('-status')) return {status: 'signed-in'};
      assert.equal(method, 'game-player-account-chat');
      playerCalls.push(args.text);
      return {text: '{"kind":"move","actionId":"normal:1"}'};
    },
    getOwnPersona: async () => ({id: 'fixture', name: '大肥鱼', prompt: '测试队友'}),
  });
  const launcher = createStoryPrototypeLauncher({
    projectDir: path.resolve(__dirname, '../../services/nekofans-game-hub/story-trial'),
    dataDir, executable: process.execPath, relay,
  });
  t.after(async () => {
    await launcher.stop();
    fs.rmSync(dataDir, {recursive: true, force: true});
  });

  const links = {};
  for (const side of ['white', 'black', 'goddess']) {
    const result = await launcher.openRoom(url => {links[side] = new URL(url);}, side);
    assert.equal(result.status, 'opened');
    assert.equal(result.modelConnected, true);
  }
  assert.equal(playerCalls.length, 0);

  async function post(side, action, body) {
    const link = links[side];
    const response = await fetch(link.origin + '/api' + link.pathname.replace('/room/', '/rooms/') +
      '/' + action + link.search, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, value.error);
    return value;
  }
  for (const [seat, nickname] of [['white', 'WHITE-ONLY'], ['black', 'BLACK-ONLY']]) {
    await post(seat, 'rule', {text: nickname});
    await post('goddess', 'goddess/rule', {seat, action: 'approve'});
  }
  await post('goddess', 'goddess/settings', {reviewMode: false});
  await post('goddess', 'goddess/start', {});
  const result = await post('white', 'teammate/decide', {});
  assert.equal(result.applied, true);
  assert.equal(result.state.game.moves.length, 1);
  assert.equal(playerCalls.length, 1);
  assert.match(playerCalls[0], /WHITE-ONLY/);
  assert.doesNotMatch(playerCalls[0], /BLACK-ONLY|梁文峰|梁武帝|达里奥|token/i);
});
