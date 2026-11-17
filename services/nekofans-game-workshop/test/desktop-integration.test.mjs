import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createGameWorkshop, parseWorkshopRoom } from '../../../apps/neko-workbench/game-workshop.cjs';
import { createApp } from '../server/index.mjs';
import { createCommunitySeatAuthorizer } from '../server/community-seats.mjs';
const official = 'https://community.project-neko.cn';
const owner = { id: '11111111-1111-4111-8111-111111111111', name: '红帽' };
const guest = { id: '22222222-2222-4222-8222-222222222222', name: '蓝帽' };
const project = { title: '小岛上的灯', html: '<script>NekofansGame.connect({})</script>', mode: 'turns' };
const definition = { title: '雾岛来信', description: '两人一起引导渡轮', nodes: [
  { seat: 0, text: '海上起雾', choices: [{ label: '点灯', next: 1 }] },
  { seat: 1, text: '船长看见了光', choices: [{ label: '驶入港口', next: 2 }] },
  { text: '渡轮靠岸', winner: 0 },
] };

test('desktop uses signed authorization through publish, library, create, and open invite', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const origin = 'https://workshop.nekofans.games';
  const app = createApp({ directory: null, publicOrigin: origin, community: { issuer: official, publicKey } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const issued = createCommunitySeatAuthorizer({ issuer: official, gameOrigin: origin, privateKey, authenticate: async account => account });
  const fetchImpl = (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, origin);
    assert(!('Authorization' in options.headers));
    return fetch('http://127.0.0.1:' + app.server.address().port + target.pathname, options);
  };
  function desktop(account) {
    let identity = { status: 'unknown' };
    const pages = [];
    const api = createGameWorkshop({ origin, fetchImpl, getAccount: () => identity, openPage: async data => pages.push(data),
      async getTicket(input) {
        identity = { status: 'signed-in', userId: account.id };
        if (input.op === 'workshop-identity') return { status: 'ready', userId: account.id };
        assert.equal(input.op, 'workshop-publish');
        const { location } = await issued(account, new URLSearchParams({ state: input.state, operation: 'publish', target: 'workshop' }));
        const ticket = new URLSearchParams(new URL(location).hash.slice(1)).get('communitySeat');
        return { status: 'ready', userId: account.id, ticket };
      },
    });
    return { api, pages };
  }
  const first = desktop(owner), second = desktop(guest);
  const saved = await first.api.publish(project);
  assert.equal(saved.title, project.title);
  assert.deepEqual((await first.api.list()).map(x => x.id), [saved.id]);
  assert.deepEqual(await second.api.list(), []);
  await assert.rejects(first.api.publishStudio({ ...definition, nodes: [] }), { status: 'invalid-game' });
  const created = await first.api.publishStudio(definition);
  assert.equal(created.title, definition.title);
  assert.deepEqual((await first.api.list()).map(value => value.id), [created.id, saved.id]);
  const room = await first.api.create(created.id);
  assert.deepEqual(Object.keys(room), ['inviteUrl']);
  assert.match(room.inviteUrl, /^https:\/\/workshop\.nekofans\.games\/\?room=[\w-]{12}$/);
  await first.api.openRoom(room.inviteUrl);
  await second.api.openRoom(room.inviteUrl);
  assert.equal(first.pages[0].url, second.pages[0].url);
  assert.notEqual(first.pages[0].cookie.value, second.pages[0].cookie.value);
  assert.deepEqual(new URL(room.inviteUrl).searchParams.size, 1);
  assert.equal(app.platform.snapshot(parseWorkshopRoom(room.inviteUrl).id).players[0].name, owner.name);
  await assert.rejects(second.api.openRoom(room.inviteUrl.replace('workshop.nekofans.games', 'example.test')), { status: 'not-found' });
});

test('workshop invitation only accepts a room on the configured origin', () => {
  const good = 'https://workshop.nekofans.games/?room=abcdefghijkl';
  assert.equal(parseWorkshopRoom(good).inviteUrl, good);
  for (const input of [good + '#private', good + '&extra=1', good + '&room=abcdefghijkl',
    good.replace('/?', '/x?'), good.replace('workshop.', 'play.'), good.replace('abcdefghijkl', 'abcdefghijklmnopqrstuvwx')]) {
    assert.equal(parseWorkshopRoom(input), null);
  }
});
