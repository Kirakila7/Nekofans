import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCommunitySeatAuthorizer } from '../server/community-seats.mjs';
import { createApp } from '../server/index.mjs';
import { GamePlatform } from '../server/platform.mjs';

const origin = 'https://games.example.test';
const issuer = 'https://community.example.test';
const owner = { id: '11111111-1111-1111-1111-111111111111', name: '小鱼' };
const other = { id: '22222222-2222-2222-2222-222222222222', name: '朋友' };
const publication = { operation: 'publish', target: 'workshop' };
const project = { title: '小窝双人游戏', mode: 'turns', html: '<script>NekofansGame.connect({ initialState: {} })</script>' };

test('登录后上传、作品归属、同一账号入座与退出', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const authorize = createCommunitySeatAuthorizer({ issuer, gameOrigin: origin, privateKey, authenticate: async user => user });
  const directory = await mkdtemp(path.join(tmpdir(), 'neko-workshop-publish-'));
  const app = createApp({ directory, publicOrigin: origin, community: { issuer, publicKey } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const api = (route, { body, cookie, requestOrigin = origin } = {}) =>
    fetch(`http://127.0.0.1:${app.server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: requestOrigin, ...cookie && { Cookie: cookie }, ...body && { 'Content-Type': 'application/json' } },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const cookieFrom = (response, prefix) => response.headers.getSetCookie().find(cookie => cookie.startsWith(prefix)).split(';')[0];
  async function connect(user) {
    const start = await api('/api/community/seat/start', { body: publication });
    const flow = cookieFrom(start, 'neko_game_');
    const { url } = await start.json();
    const authorized = await authorize(user, new URL(url).searchParams);
    assert.equal(authorized.status, 200);
    const result = new URL(authorized.location);
    assert.equal(result.search, '?publish=1');
    const ticket = new URLSearchParams(result.hash.slice(1)).get('communitySeat');
    const body = { ...publication, ticket };
    assert.equal((await api('/api/community/seat', { body })).status, 401, 'ticket is browser-bound');
    const claim = await api('/api/community/seat', { body, cookie: flow });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json()).name, user.name);
    const session = claim.headers.getSetCookie().find(cookie => cookie.startsWith('neko_workshop_publisher='));
    assert.match(session, /; HttpOnly; SameSite=Lax; Secure$/);
    assert.equal((await api('/api/community/seat', { body, cookie: flow })).status, 401, 'ticket is single-use');
    return cookieFrom(claim, 'neko_workshop_publisher=');
  }

  assert.equal((await api('/api/games', { body: project })).status, 401);
  assert.equal((await api('/api/config')).status, 200);
  const first = await connect(owner);
  assert.equal((await api('/api/games', { body: project, cookie: first, requestOrigin: issuer })).status, 403);
  assert.equal((await api('/api/games', { body: { ...project, html: '<p>单机</p>' }, cookie: first })).status, 422);
  const published = await api('/api/games', { body: project, cookie: first });
  assert.equal(published.status, 201);
  const { id, ownerId } = await published.json();
  assert.equal(ownerId, undefined);
  assert.equal((await (await api('/api/games', { body: project, cookie: first })).json()).id, id);
  const second = await connect(other);
  assert.deepEqual((await (await api('/api/publisher', { cookie: second })).json()).projects, []);
  assert.deepEqual((await (await api('/api/publisher', { cookie: first })).json()).projects.map(game => game.id), [id]);
  assert.deepEqual(new GamePlatform(directory).projects(owner.id).map(game => game.id), [id], 'title and ownership persist on restart');
  const room = await (await api('/api/publisher/seat', { cookie: first, body: { operation: 'create', target: id } })).json();
  assert.equal(room.player, 0);
  assert.equal((await api(`/api/rooms/${room.id}/join`, { body: { name: '访客' } })).status, 401);
  const guest = await (await api('/api/publisher/seat', { cookie: second, body: { operation: 'join', target: room.id } })).json();
  assert.equal(guest.player, 1);
  assert.equal(app.platform.auth(guest.id, guest.token), 1);
  const result = await api('/api/publisher/logout', { body: {}, cookie: first });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  assert.deepEqual(await (await api('/api/publisher', { cookie: first })).json(), { signedIn: false });
});
