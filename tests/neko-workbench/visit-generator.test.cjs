'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createVisitGenerator, publicPersona, limitUtf8 } = require('../../apps/neko-workbench/visits/generator.cjs');
const repositoryRoot = path.resolve(__dirname, '../..');
const config = { protocol: 'openai-compatible', baseUrl: 'https://model.example/v1', model: 'model', requestTimeoutMs: 1000 };
function answer() { return new Response('data: {"choices":[{"delta":{"content":"hello cat"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }

test('model wire context contains only public persona and current visit text with no memory, tools or private config', async () => {
  let body, headers;
  const generate = createVisitGenerator({ repositoryRoot,
    getConfig: () => ({ ...config, persona: 'PRIVATE_PERSONA', memories: ['PRIVATE_MEMORY'], tools: [{ secret: 'PRIVATE_TOOL' }] }),
    getSecret: async () => 'key-only-in-header', fetch: async (url, request) => { body = JSON.parse(request.body); headers = request.headers; return answer(); } });
  const text = await generate({ persona: { name: 'Public Cat', description: 'loves flowers', private: 'PRIVATE_FILE' },
    messages: [{ role: 'user', text: 'guest says hello', memoryContext: 'PRIVATE_RECALL' }], signal: new AbortController().signal });
  assert.equal(text, 'hello cat');
  const encoded = JSON.stringify(body);
  assert.match(encoded, /Public Cat/); assert.match(encoded, /guest says hello/);
  assert.doesNotMatch(encoded, /PRIVATE_|key-only-in-header/);
  assert.equal(body.tools, undefined); assert.equal(headers.authorization, 'Bearer key-only-in-header');
  assert.ok(body.max_tokens <= 512);
});

test('host can generate opening text without reading any persona or history files', async () => {
  let body;
  const generate = createVisitGenerator({ repositoryRoot, getConfig: () => config, getSecret: async () => 'key',
    fetch: async (_, request) => { body = JSON.parse(request.body); return answer(); } });
  await generate({ persona: { name: 'cat', description: '' }, messages: [], signal: new AbortController().signal });
  assert.equal(body.messages.at(-1).role, 'user');
});

test('aborted generation makes no HTTP request', async () => {
  let fetched = false;
  const generate = createVisitGenerator({ repositoryRoot, getConfig: () => config, getSecret: async () => 'key',
    fetch: async () => { fetched = true; return answer(); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generate({ persona: { name: 'cat', description: '' }, messages: [], signal: controller.signal }));
  assert.equal(fetched, false);
});

test('UTF-8 limits preserve emoji codepoints and keep published persona small', () => {
  assert.equal(limitUtf8('猫😀猫', 7), '猫😀');
  assert.equal(limitUtf8('猫😀猫', 6), '猫');
  assert.equal(limitUtf8('😀😀', 100, 1), '😀');
  const persona = publicPersona({ name: '猫', description: '😀'.repeat(900) });
  assert.ok(Buffer.byteLength(persona.description, 'utf8') <= 1024);
  assert.equal(Buffer.from(persona.description).toString(), persona.description);
});

test('model streaming result is limited before entering the transport', async () => {
  const generate = createVisitGenerator({ repositoryRoot, getConfig: () => config, getSecret: async () => 'key',
    fetch: async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '猫😀'.repeat(1000) } }] })
      + '\n\ndata: [DONE]\n\n') });
  const text = await generate({ persona: { name: 'cat', description: '' }, messages: [], signal: new AbortController().signal });
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2000);
  assert.ok([...text].length <= 1024);
  assert.equal(Buffer.from(text).toString(), text);
});
