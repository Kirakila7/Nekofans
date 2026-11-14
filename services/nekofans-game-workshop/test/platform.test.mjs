import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { GamePlatform } from '../server/platform.mjs';
import { createApp } from '../server/index.mjs';

const sample = { title: '两个玩家的游戏', mode: 'turns', html: '<h1>测试</h1><script>NekofansGame.connect({})</script>' };
const action = (version, player, extra = {}) => ({ version, actionId: 'action_' + version + '_' + player, action: { type: 'put', index: version }, ...extra });
test('发布固定版本；两人占座；拒绝第三人、抢回合、旧序号；重复提交幂等', () => {
  const p = new GamePlatform(); const game = p.publish(sample);
  assert.equal(p.publish(sample).id, game.id);
  assert.notEqual(p.publish({ ...sample, html: sample.html + 'new' }).id, game.id);
  const a = p.create(game.id, '<script>name</script>'), b = p.join(a.id, '朋友');
  assert.equal(a.player, 0); assert.equal(b.player, 1);
  assert.throws(() => p.join(a.id), /两位玩家/);
  assert.throws(() => p.auth(a.id, b.token + 'x'), /凭证/);
  assert.equal(p.auth(a.id, a.token), 0);
  p.configureRoom(a.id, 0, { type: 'start' }, [true, true]);
  assert.throws(() => p.action(a.id, 1, action(0, 1)), /等待对方/);
  p.action(a.id, 0, action(0, 0));
  p.action(a.id, 0, action(0, 0));
  assert.equal(p.snapshot(a.id).version, 1);
  assert.throws(() => p.action(a.id, 1, action(0, 1)), /已更新/);
  p.action(a.id, 1, action(1, 1));
  const state = p.snapshot(a.id); assert.equal(state.version, 2); assert.equal(state.turn, 0);
  assert.ok(!JSON.stringify(state).includes(a.token)); assert.ok(!JSON.stringify(state).includes('hash'));
});
test('共同操作不强制轮流；未满两人不操作；重启恢复原作品、席位与完整历史', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'neko-games-'));
  try {
    let p = new GamePlatform(directory); const game = p.publish({ ...sample, mode: 'shared' }); const a = p.create(game.id, '甲');
    assert.throws(() => p.action(a.id, 0, action(0, 0)), /请等房主/);
    p.join(a.id, '乙'); p.configureRoom(a.id, 0, { type: 'start' }, [true, true]);
    p.action(a.id, 0, action(0, 0)); p.action(a.id, 0, action(1, 0));
    const before = p.snapshot(a.id); p = new GamePlatform(directory);
    assert.deepEqual(p.snapshot(a.id), before); assert.equal(p.auth(a.id, a.token), 0); assert.equal(p.game(game.id).html, sample.html);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('磁盘写入失败不会吞占席位或留下未保存的操作', () => {
  const p = new GamePlatform(); const game = p.publish(sample); const a = p.create(game.id, '甲');
  const save = p.save; p.save = () => { throw new Error('Disk full'); };
  assert.throws(() => p.join(a.id, '乙'), /Disk full/); assert.equal(p.room(a.id).seats.length, 1);
  p.save = save; p.join(a.id, '乙'); p.configureRoom(a.id, 0, { type: 'start' }, [true, true]);
  p.save = () => { throw new Error('Disk full'); };
  assert.throws(() => p.action(a.id, 0, action(0, 0)), /Disk full/); assert.equal(p.snapshot(a.id).version, 0);
  assert.throws(() => p.publish({ ...sample, title: '未保存作品' }), /Disk full/); assert.equal(p.games.size, 1);
});
function client(url, token) {
  const ws = new WebSocket(url), queue = [], waits = [];
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', raw => { const message = JSON.parse(raw); const index = waits.findIndex(wait => wait.predicate(message)); if (index >= 0) { const [wait] = waits.splice(index, 1); clearTimeout(wait.timer); wait.resolve(message); } else queue.push(message); });
  return { ws, next(predicate = value => value.type === 'state') {
    const index = queue.findIndex(predicate); if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const wait = { predicate, resolve, timer: setTimeout(() => { waits.splice(waits.indexOf(wait), 1); reject(new Error('WebSocket timeout')); }, 4000) }; waits.push(wait); });
  } };
}
test('真实 HTTP/WS：发布授权、建房邀请、两端同局、离线恢复、游戏沙箱', async () => {
  const app = createApp({ directory: null, publishKey: 'test-publisher-only' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function post(route, body, key) { return fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) }); }
  try {
    assert.equal((await post('/api/games', sample)).status, 401);
    assert.equal((await fetch(origin + '/api/rooms', { method: 'POST', headers: { Origin: 'https://wrong.example' }, body: '{}' })).status, 403);
    const game = await (await post('/api/games', sample, 'test-publisher-only')).json();
    assert.ok(game.id); assert.equal(game.html, undefined);
    const a = await (await post('/api/rooms', { gameId: game.id, name: '甲' })).json();
    const url = origin.replace('http:', 'ws:') + `/api/rooms/${a.id}/socket`, first = client(url, a.token);
    assert.equal((await first.next()).players.length, 1);
    first.ws.send(JSON.stringify({ type: 'start' }));
    assert.equal((await first.next(s => s.type === 'error')).status, 409);
    const b = await (await post(`/api/rooms/${a.id}/join`, { name: '乙' })).json(), second = client(url, b.token);
    await first.next(s => s.type === 'state' && s.online.every(Boolean)); await second.next();
    second.ws.send(JSON.stringify({ type: 'start' }));
    assert.equal((await second.next(s => s.type === 'error')).status, 403);
    const alternative = app.platform.publish({ ...sample, title: '第二个项目' });
    second.ws.send(JSON.stringify({ type: 'project', gameId: alternative.id }));
    assert.equal((await second.next(s => s.type === 'error')).status, 403);
    first.ws.send(JSON.stringify({ type: 'project', gameId: alternative.id }));
    await Promise.all([first.next(s => s.gameId === alternative.id), second.next(s => s.gameId === alternative.id)]);
    first.ws.send(JSON.stringify({ type: 'action', ...action(0, 0) }));
    assert.equal((await first.next(s => s.type === 'error')).status, 409);
    first.ws.send(JSON.stringify({ type: 'start' }));
    await Promise.all([first.next(s => s.phase === 'playing'), second.next(s => s.phase === 'playing')]);
    first.ws.send(JSON.stringify({ type: 'project', gameId: game.id }));
    assert.equal((await first.next(s => s.type === 'error')).status, 409);
    first.ws.send(JSON.stringify({ type: 'action', ...action(0, 0) }));
    const [stateA, stateB] = await Promise.all([first.next(s => s.version === 1), second.next(s => s.version === 1)]);
    assert.deepEqual(stateA.events, stateB.events);
    second.ws.close(); await first.next(s => s.type === 'state' && s.online[1] === false);
    const restored = client(url, b.token); const current = await restored.next();
    assert.equal(current.version, 1); assert.deepEqual(current.events, stateA.events);
    restored.ws.send(JSON.stringify({ type: 'action', ...action(1, 1) }));
    assert.equal((await first.next(s => s.version === 2)).events[1].player, 1);
    assert.equal((await post(`/api/rooms/${a.id}/join`, {})).status, 409);
    const frame = await fetch(origin + '/play/' + game.id);
    assert.ok(frame.headers.get('Content-Security-Policy').includes('sandbox allow-scripts'));
    assert.ok(frame.headers.get('Content-Security-Policy').includes("connect-src 'none'"));
    assert.ok((await frame.text()).includes('window.NekofansGame'));
    assert.equal((await fetch(origin + '/server/platform.mjs')).status, 404);
  } finally { await app.close(); }
});
test('SDK：两份独立游戏环境按同样历史恢复同一状态，玩家操作不直接改共享状态', () => {
  const sdk = readFileSync(new URL('../public/game-sdk.js', import.meta.url), 'utf8');
  function sandbox(player) {
    let receive, change; const emitted = [], parent = { postMessage: message => emitted.push(message) };
    const box = { location: { hash: '#channel' }, parent, addEventListener: (_, fn) => { receive = fn; }, window: {} };
    vm.runInNewContext(sdk, box);
    const controller = box.window.NekofansGame.connect({ initialState: { count: 0 }, reducer: (state, action) => ({ count: state.count + action.amount }), onChange: (state, ctx) => { change = { state, ctx }; } });
    return { controller, emitted, get change() { return change; }, update(room) { receive({ source: parent, data: { nekofans: 1, channel: 'channel', type: 'snapshot', player, connected: true, state: room } }); } };
  }
  const one = sandbox(0), two = sandbox(1);
  const room = { version: 2, events: [{ player: 0, seq: 1, action: { amount: 3 } }, { player: 1, seq: 2, action: { amount: 7 } }], players: [{ name: '甲' }, { name: '乙' }], online: [true, true], turn: 0, seed: 'same-seed', game: { mode: 'turns' } };
  one.update(room); two.update(room);
  assert.equal(one.change.state.count, 10); assert.equal(two.change.state.count, 10);
  assert.equal(one.change.ctx.isMyTurn, true); assert.equal(two.change.ctx.isMyTurn, false);
  one.controller.submit({ amount: 5 }); assert.equal(one.controller.getState().count, 10);
  assert.equal(one.emitted.at(-1).type, 'action');
  room.version = 3; room.events.push({ player: 0, seq: 3, action: { amount: 5 } }); one.update(room); two.update(room);
  assert.equal(one.change.state.count, 15); assert.equal(two.change.state.count, 15);
});

test('SDK：Agent 读取本方动作并沿玩家路径提交，拒绝过期版本、重复提交和对方回合', () => {
  const sdk = readFileSync(new URL('../public/game-sdk.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../examples/mushroom-trail.html', import.meta.url), 'utf8');
  const emitted = [];
  const parent = { postMessage: message => emitted.push(message) };
  let receive;
  const element = () => ({ dataset: {}, addEventListener() {} });
  const canvas = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, { get: (object, key) => object[key] ?? (() => {}) });
  const document = { getElementById: () => ({ ...element(), getContext: () => canvas }), querySelectorAll: () => [], addEventListener() {} };
  const box = vm.createContext({ parent, location: { hash:'#test' }, window: {}, document, matchMedia: () => ({ matches:true }),
    cancelAnimationFrame() {}, TextEncoder, addEventListener: (_, fn) => { receive = fn; } });
  vm.runInContext(sdk, box);
  box.NekofansGame = box.window.NekofansGame;
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], box);
  assert.equal(emitted.at(-1).agent, true);
  const send = (type, fields) => receive({ source:parent, data:{ nekofans:1, channel:'test', type, ...fields } });
  const room = { version:0, events:[], players:[{name:'甲'},{name:'乙'}], online:[true,true], turn:0, seed:'test', game:{mode:'shared'} };
  const update = () => send('snapshot', { player:0, connected:true, state:room });
  update();
  send('agent-view', { requestId:'view-1' });
  const view = emitted.at(-1);
  assert.equal(view.status, 'ready');
  assert.equal(view.player, 0);
  assert.equal(view.observation.positions[0], 0);
  const jump = view.choices.find(choice => choice.action.type === 'jump' && choice.action.dir === 1);
  assert.ok(jump);
  send('agent-action', { requestId:'bad-choice', viewId:'view-1', version:0, choiceId:999 });
  assert.equal(emitted.at(-1).status, 'invalid-choice');
  send('agent-action', { requestId:'submit-1', viewId:'view-1', version:0, choiceId:jump.id });
  assert.equal(emitted.at(-1).status, 'submitted');
  const delegated = emitted.at(-2);
  vm.runInContext('room.submit({type:"jump",dir:1})', box);
  assert.equal(delegated.agentRequestId, 'submit-1');
  const { agentRequestId, ...sameAction } = delegated;
  assert.equal(JSON.stringify(emitted.at(-1)), JSON.stringify(sameAction));
  send('agent-action', { requestId:'repeat', viewId:'view-1', version:0, choiceId:jump.id });
  assert.equal(emitted.at(-1).status, 'stale');
  send('agent-view', { requestId:'view-2' });
  room.version = 1; room.events.push({ player:0, seq:1, action:delegated.action }); update();
  send('agent-action', { requestId:'old', viewId:'view-2', version:0, choiceId:jump.id });
  assert.equal(emitted.at(-1).status, 'stale');
  room.online = [true,false]; update(); send('agent-view', { requestId:'offline' });
  assert.equal(emitted.at(-1).choices.length, 0);
  room.online = [true,true]; room.game.mode = 'turns'; room.turn = 1; update();
  send('agent-view', { requestId:'other-turn' });
  assert.equal(emitted.at(-1).choices.length, 0);
});
