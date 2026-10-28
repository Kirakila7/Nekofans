'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NekoMemoryProvider } = require('../../apps/neko-workbench/neko-memory-provider.cjs');
const { WorkbenchMainChat } = require('../../apps/neko-workbench/main-chat-runtime.cjs');
const root = path.resolve(__dirname, '../..');
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-backend-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const vault = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: x => Buffer.from(x), decryptString: b => b.toString() };

test('main chat recalls and stores completed turns through N.E.K.O. memory', async t => {
  const dir = temporary(t), calls = [], requests = [];
  const service = { request: async (route, options) => {
    calls.push({ route, options });
    if (route.startsWith('/query_memory/')) return { results: [{ id: 'f1', text: '测试角色喜欢薄荷', tier: 'fact' }] };
    if (route.startsWith('/cache/')) return { status: 'cached' };
    throw Error('unexpected route');
  } };
  const memory = new NekoMemoryProvider({ service, queueFile: path.join(dir, 'queue.json') });
  const mockFetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response('data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  const runtime = new WorkbenchMainChat({ dataDir: dir, repositoryRoot: root, safeStorage: vault, fetch: mockFetch, memoryProvider: memory });
  t.after(() => runtime.close()); await runtime.start();
  await runtime.saveApi({ protocol:'openai-compatible', baseUrl:'https://example.invalid/v1', model:'fixture', requestTimeoutMs:5000, maxOutputTokens:128, key:{action:'replace',value:'fixture'} });
  const result = await runtime.send('测试记忆写入'); assert.equal(result.status, 'completed');
  assert(JSON.stringify(requests[0]).includes('测试角色喜欢薄荷'), 'recalled fact reaches the chat provider');
  const cache = calls.find(item => item.route.startsWith('/cache/')); assert(cache);
  assert.deepEqual(JSON.parse(cache.options.body.input_history), [{ role:'user', content:'测试记忆写入' }, { role:'assistant', content:'收到' }]);
  assert.equal(runtime.read().memoryBackend, 'neko'); assert.deepEqual(memory.queue, []);
  assert(!fs.existsSync(path.join(runtime.dataDir, 'memories.sqlite')), 'does not create a second local memory store');
  await runtime.close();
});

test('ambiguous write is retained and not replayed automatically after restart', async t => {
  const dir = temporary(t), file = path.join(dir, 'queue.json'); let calls = 0;
  const service = { request: async () => { calls++; throw Error('connection lost after send'); } };
  const memory = new NekoMemoryProvider({ service, queueFile: file });
  await assert.rejects(memory.commitTurn({ personaId:'bigfish', text:'测试' }, { personaId:'bigfish', id:'turn-1', text:'收到' }));
  assert.equal(memory.queue[0].state, 'unknown');
  const restored = new NekoMemoryProvider({ service, queueFile: file });
  assert.match(restored.error, /待确认/); assert.equal(calls, 1);
  await restored.commitTurn({ personaId:'bigfish', text:'测试' }, { personaId:'bigfish', id:'turn-1', text:'收到' });
  assert.equal(calls, 1, 'an uncertain turn is never sent a second time');
});

test('a successful write does not conceal a failed recall', async t => {
  const dir = temporary(t);
  const service = { request: async route => { if (route.startsWith('/query_memory/')) throw Error('offline'); return { status:'cached' }; } };
  const memory = new NekoMemoryProvider({ service, queueFile: path.join(dir, 'queue.json') });
  await assert.rejects(memory.recall('bigfish', '测试', 100));
  await memory.commitTurn({ personaId:'bigfish', text:'测试' }, { personaId:'bigfish', id:'turn-2', text:'收到' });
  assert.match(memory.error, /检索失败/);
});

test('a saved pending turn remains visible after restart', t => {
  const dir = temporary(t), file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, JSON.stringify([{ id:'turn-3', state:'pending', user:'测试', assistant:'收到' }]));
  const memory = new NekoMemoryProvider({ service:{}, queueFile:file });
  assert.match(memory.error, /尚未完成/);
});
