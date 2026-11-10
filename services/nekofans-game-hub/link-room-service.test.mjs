import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkRoomService, createLinkRoomServer } from './link-room-service.mjs';

const sample = { title: '测试世界', gameUrl: 'https://example.com/play', victoryCondition: '双方约定先到终点获胜' };

test('private inputs never appear in either public seat view; revisions reset ready', () => {
  const service = createLinkRoomService();
  const a = service.create(sample).body;
  const b = service.join(a.roomId).body;
  assert.equal(service.join(a.roomId).status, 409);
  assert.equal(service.rule(a.roomId, a.token, { rule: '甲方秘密' }).status, 200);
  assert.equal(service.rule(a.roomId, b.token, { rule: '乙方秘密' }).status, 200);
  for (const player of [a, b]) {
    const state = service.view(a.roomId, player.token);
    assert.equal(state.status, 200);
    assert.doesNotMatch(JSON.stringify(state), /甲方秘密|乙方秘密/);
    assert.equal(state.body.players.every(p => p.ruleReady), true);
    assert.equal(service.ready(a.roomId, player.token, { playerReady: true, conditionConfirmed: true }).status, 200);
  }
  assert.equal(service.view(a.roomId, a.token).body.phase, 'waiting');
  assert.equal(service.rule(a.roomId, a.token, { rule: '甲方修订' }).status, 200);
  assert.equal(service.view(a.roomId, b.token).body.players.every(p => !p.playerReady), true);
  assert.equal(service.view(a.roomId, 'x'.repeat(32)).status, 401);
});

test('both players and server-verified agents must be ready, with no claim of game integration', () => {
  const service = createLinkRoomService({ agentReady: () => true });
  const a = service.create(sample).body, b = service.join(a.roomId).body;
  assert.equal(service.ready(a.roomId, a.token, { playerReady: true, conditionConfirmed: true }).status, 409);
  assert.equal(service.ready(a.roomId, a.token, { agentReady: true }).status, 400);
  for (const p of [a, b]) service.rule(a.roomId, p.token, { rule: '本方规则' });
  for (const p of [a, b]) {
    assert.equal(service.ready(a.roomId, p.token, { playerReady: true, conditionConfirmed: true }).status, 200);
  }
  const view = service.view(a.roomId, a.token).body;
  assert.equal(view.phase, 'ready-to-connect');
  assert.deepEqual(view.capabilities, { linkedGame: false, autoJudge: false });
});

test('external link validation never accepts active schemes or embedded credentials', () => {
  const service = createLinkRoomService();
  for (const gameUrl of ['javascript:alert(1)', 'http://example.com', 'https://name:secret@example.com/', 'file:///etc/passwd']) {
    assert.equal(service.create({ ...sample, gameUrl }).status, 400);
  }
  assert.equal(service.create(sample).status, 201);
});

test('local HTTP rejects cross-origin requests and does not expose opponent secrets', async t => {
  const server = createLinkRoomServer();
  try { await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve)); }
  catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip(`loopback unavailable: ${e.code}`); throw e; }
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, token, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(data) });
  assert.equal((await post('/link-rooms', sample, null, { origin: 'https://attacker.example' })).status, 403);
  const a = await (await post('/link-rooms', sample)).json();
  const b = await (await post(`/link-rooms/${a.roomId}/join`, {})).json();
  await post(`/link-rooms/${a.roomId}/rule`, { rule: '仅甲方知道的内容' }, a.token);
  const state = await (await fetch(`${origin}/link-rooms/${a.roomId}/state`, { headers: { authorization: `Bearer ${b.token}` } })).text();
  assert.doesNotMatch(state, /仅甲方知道的内容/);
});
