'use strict';
// Shared protocol samples: fixtures/frames.json is byte-identical to
// N.E.K.O.Chat/tests/fixtures/frames.json, whose `server` and `rest` sections
// are produced by the real backend code (tests/test_protocol_fixtures.py).
// Here every server frame must pass lobby-frames.cjs and be rebuilt without
// losing or changing a field, every REST body must pass lobby-client.cjs, and
// the frames the workbench builds must match the `client` samples the backend
// accepts. A field rename on either side fails both suites. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const F = require('../../apps/neko-workbench/lobby-frames.cjs');
const C = require('../../apps/neko-workbench/lobby-client.cjs');

const FIXTURE = join(__dirname, 'fixtures', 'frames.json');
const BACKEND_COPY = join(__dirname, '..', '..', '..', 'N.E.K.O.Chat', 'tests', 'fixtures', 'frames.json');
const fixtures = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const { client, server, rest } = fixtures;

// Fields the validator fills in when the backend leaves them out.
const DEFAULTS = {
  'presence.join': { cat_id: null },
  'presence.leave': { cat_id: null },
  typing: { cat_id: null },
  error: { ref: null, retry_after_ms: null },
};
const withDefaults = frame => {
  const out = { ...DEFAULTS[frame.type], ...frame };
  if (frame.type === 'cat.updated') out.cat = { deleted: false, ...frame.cat };
  if (frame.type === 'presence.snapshot') {
    out.members = frame.members.map(m => ({ user_id: null, cat_id: null, ...m }));
  }
  return out;
};

test('the fixture copy matches N.E.K.O.Chat byte for byte', t => {
  if (!existsSync(BACKEND_COPY)) { t.skip('N.E.K.O.Chat checkout not next to neko-workbench'); return; }
  assert.deepEqual(readFileSync(FIXTURE), readFileSync(BACKEND_COPY));
});

test('the server samples cover every protocol server frame type', () => {
  assert.deepEqual([...new Set(Object.values(server).map(f => f.type))].sort(), [...F.KNOWN_FRAME_TYPES].sort());
});

for (const [key, frame] of Object.entries(server)) {
  test(`server frame ${key} is accepted and rebuilt unchanged`, () => {
    const result = F.validateFrame(frame);
    assert.equal(typeof result, 'object', `${key}: ${result}`);
    assert.deepEqual(result, withDefaults(frame));
    assert.deepEqual(F.parseFrame(JSON.stringify(frame)), result);
  });
}

function fakeFetch(body) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests };
}
const auth = { async getAccessToken() { return 'fixture-access-token-not-a-secret'; }, invalidateAccessToken() {} };
const restClient = body => {
  const fetch = fakeFetch(body);
  return { api: C.createLobbyRest({ config: { configured: true, chatUrl: 'https://chat.example.test/' }, auth,
    fetchImpl: fetch.fetchImpl }), requests: fetch.requests };
};

test('REST GET /channels/lobby body is accepted unchanged', async () => {
  const { api, requests } = restClient(rest.lobby);
  assert.deepEqual(await api.lobby(), rest.lobby);
  assert.deepEqual(requests.map(r => [r.method, new URL(r.url).pathname]), [['GET', '/api/v1/channels/lobby']]);
});

test('REST GET /channels/{id}/messages body is accepted without dropping a message', async () => {
  const { api, requests } = restClient(rest.history);
  const page = await api.history(rest.lobby.id, { limit: rest.history.messages.length });
  assert.deepEqual(page.messages, rest.history.messages);
  assert.equal(page.hasMore ?? page.has_more, rest.history.has_more);
  assert.equal(new URL(requests[0].url).pathname, `/api/v1/channels/${rest.lobby.id}/messages`);
});

test('REST GET /me/cat body is accepted unchanged', async () => {
  const { api, requests } = restClient(rest.cat);
  assert.deepEqual(await api.getCat(), { deleted: false, ...rest.cat });
  assert.equal(new URL(requests[0].url).pathname, '/api/v1/me/cat');
});

const strip = ({ client_message_id: _id, ...rest }) => rest;

test('message.send frames built by the workbench match the client samples', () => {
  const human = client.message_send_human;
  assert.deepEqual(C.humanFrame({ text: human.text, replyToId: human.reply_to_id }), strip(human));
  const ai = client.message_send_human_ai;
  assert.deepEqual(C.humanFrame({ text: ai.text, origin: 'human_ai', assistCatId: ai.assist_cat_id }), strip(ai));
});

test('cat.message.send frames built by the workbench match the client sample', () => {
  const cat = client.cat_message_send;
  assert.deepEqual(C.catFrame({ cat_id: cat.cat_id, in_reply_to: cat.in_reply_to, trigger: cat.trigger, text: cat.text }),
    strip(cat));
});

test('every client sample carries only protocol field names', () => {
  const fields = {
    auth: ['type', 'token', 'last_event_seq', 'client'], 'auth.refresh': ['type', 'token'],
    'message.send': ['type', 'client_message_id', 'text', 'origin', 'reply_to_id', 'assist_cat_id'],
    'cat.message.send': ['type', 'client_message_id', 'cat_id', 'in_reply_to', 'text', 'trigger'],
    typing: ['type', 'kind', 'cat_id'], 'cat.status': ['type', 'cat_id', 'state'], ping: ['type', 't'],
  };
  for (const [key, frame] of Object.entries(client)) {
    assert.ok(fields[frame.type], key);
    for (const name of Object.keys(frame)) assert.ok(fields[frame.type].includes(name), `${key}.${name}`);
  }
});
