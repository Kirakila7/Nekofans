'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createLobbyCat, suggest, sameToken } = require('../../apps/neko-workbench/lobby-cat.cjs');
const F = require('./lobby-fixtures.cjs');
const SECRET_MEMORY = '合成私人记忆：主人下周要去看牙医';

function setup({ reply = '我也觉得这个主意不错！', hold = false, recall } = {}) {
  const clock = F.fakeTimers(), provider = F.fakeProvider(reply, { hold }), client = { send: 0, catSend: 0 }, recalls = [];
  const lobby = { ownerId: F.OWNER, ownerName: '主人小明', catId: F.CAT, catName: '大肥鱼', catReady: true, catsEnabled: true,
    freeAllowed: true, messages: [], names: new Map() };
  let providerOn = true;
  const snapshots = [];
  const cat = createLobbyCat({ mode: 'assist', getProvider: () => providerOn ? provider : null, getPersona: F.persona, getLobby: () => lobby,
    recallMemory: recall || (async (query, budget) => { recalls.push({ query, budget }); return [{ kind: 'episode', text: SECRET_MEMORY }]; }),
    catSend: async () => { client.catSend++; }, send: async () => { client.send++; }, now: clock.now, timers: clock.timers,
    onChange: value => snapshots.push(JSON.stringify(value)) });
  const add = msg => { msg.created_at ??= clock.now(); lobby.messages.push(msg); return msg; };
  return { clock, provider, client, lobby, cat, add, recalls, snapshots, setProvider: v => { providerOn = v; } };
}

test('suggest returns text only and never calls send or catSend', async () => {
  const s = setup(), target = s.add(F.message({ text: '周末要不要一起去看猫展？' }));
  const result = await s.cat.requestSuggestion({ targetMessageId: target.id, instruction: '语气轻松一点' });
  assert.equal(result.text, '我也觉得这个主意不错！'); assert.equal(result.targetId, target.id);
  assert.equal(s.client.send, 0); assert.equal(s.client.catSend, 0);
  assert.deepEqual(s.cat.snapshot().suggestion, { id: result.id, targetId: target.id, text: result.text, state: 'ready' });
  const request = s.provider.calls[0];
  assert.equal(request.maxOutputTokens, 300); assert.deepEqual(request.memories, []); assert.equal(request.persona.id, 'lobby-assist');
  assert.match(request.messages[0].text, /主人想回复 阿布 的这句话/); assert.match(request.messages[0].text, /语气轻松一点/);
  assert.match(request.persona.prompt, /主人会看过再决定发不发/);
});

test('recalled memory is injected as a bounded reference block and never reaches the snapshot', async () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ kind: 'fact', text: SECRET_MEMORY + i + '长'.repeat(200) }));
  const s = setup({ recall: async () => long }), target = s.add(F.message());
  await s.cat.requestSuggestion({ targetMessageId: target.id });
  const prompt = s.provider.calls[0].persona.prompt, block = prompt.slice(prompt.indexOf('共同记忆'));
  assert.match(block, /仅供参考/); assert.match(block, /不要把主人的私事写进公开回复/);
  const lines = block.split('\n').filter(line => line.startsWith('- '));
  assert(lines.length >= 1); assert(lines.join('\n').length <= 1200);
  assert.equal(JSON.stringify(s.cat.snapshot()).includes(SECRET_MEMORY), false);
  assert.equal(s.snapshots.some(v => v.includes(SECRET_MEMORY)), false);
  const defaults = setup(), t2 = defaults.add(F.message({ text: '在吗' }));
  await defaults.cat.requestSuggestion({ targetMessageId: t2.id });
  assert.deepEqual(defaults.recalls, [{ query: '在吗', budget: 300 }]);
});

test('recall failure or slowness does not block the suggestion', async () => {
  const s = setup({ recall: async () => { throw new Error('offline'); } }), target = s.add(F.message());
  assert.equal((await s.cat.requestSuggestion({ targetMessageId: target.id })).text, '我也觉得这个主意不错！');
  assert.equal(s.provider.calls[0].persona.prompt.includes('共同记忆'), false);
});

for (const [name, change] of [
  ['mode switch', s => s.cat.setMode('independent')],
  ['new reply target', s => s.cat.retarget({ targetMessageId: s.add(F.message()).id })],
  ['draft cleared', s => s.cat.retarget({ targetMessageId: s.cat.token().targetMessageId, draftEpoch: s.cat.token().draftEpoch + 1 })],
  ['leaving the lobby', s => s.cat.invalidate()],
]) {
  test(`a stale run is dropped after ${name}`, async () => {
    let release;
    const s = setup({ reply: () => new Promise(resolve => { release = resolve; }) }), target = s.add(F.message());
    const pending = s.cat.requestSuggestion({ targetMessageId: target.id });
    await F.flush(); assert.equal(s.cat.snapshot().suggestion.state, 'generating');
    change(s);
    assert.equal(s.provider.calls[0].signal.aborted, true);
    release('迟到的建议'); assert.equal(await pending, null);
    const snap = JSON.stringify(s.cat.snapshot());
    assert.equal(snap.includes('迟到的建议'), false); assert.equal(s.cat.snapshot().suggestion, null);
  });
}

test('a new request aborts the previous one; only the newest card is shown', async () => {
  let calls = 0;
  const s = setup({ reply: () => { calls++; return calls === 1 ? new Promise(() => {}) : '第二条建议'; } }), target = s.add(F.message());
  const first = s.cat.requestSuggestion({ targetMessageId: target.id }); await F.flush();
  const second = await s.cat.requestSuggestion({ targetMessageId: target.id, instruction: '换个说法' });
  assert.equal(s.provider.calls[0].signal.aborted, true);
  assert.equal(second.text, '第二条建议'); assert.equal(await first, null);
  assert.equal(s.cat.snapshot().suggestion.text, '第二条建议');
});

test('discard and cancel remove the card without sending', async () => {
  const s = setup(), target = s.add(F.message());
  await s.cat.requestSuggestion({ targetMessageId: target.id });
  s.cat.discardSuggestion(); assert.equal(s.cat.snapshot().suggestion, null);
  const held = setup({ hold: true }), t2 = held.add(F.message());
  const p = held.cat.requestSuggestion({ targetMessageId: t2.id }); await F.flush();
  held.cat.cancelSuggestion(); assert.equal(held.provider.calls[0].signal.aborted, true); held.provider.release();
  assert.equal(await p, null); assert.equal(held.client.send + held.client.catSend + s.client.send + s.client.catSend, 0);
});

test('suggest is refused without a chat-api provider, outside assist mode, and for a missing target', async () => {
  const s = setup(); s.setProvider(false);
  await assert.rejects(s.cat.requestSuggestion({}), { code: 'unavailable' });
  assert.throws(() => s.cat.setMode('independent'), { code: 'unavailable' });
  const off = setup(); off.cat.setMode('off');
  await assert.rejects(off.cat.requestSuggestion({}), { code: 'mode' });
  const gone = setup();
  await assert.rejects(gone.cat.requestSuggestion({ targetMessageId: 'missing' }), { code: 'target' });
  await assert.rejects(suggest({ token: { mode: 'assist' } }, { getProvider: () => null, getPersona: F.persona }), { code: 'unavailable' });
  await assert.rejects(suggest({ token: { mode: 'independent' } }, { getProvider: () => F.fakeProvider(), getPersona: F.persona }), { code: 'mode' });
  await assert.rejects(setup().cat.requestSuggestion({ instruction: '长'.repeat(501) }), { code: 'instruction' });
});

test('model failures show a fixed message and never echo provider text', async () => {
  const s = setup({ reply: new Error('upstream said sk-synthetic-secret') });
  await assert.rejects(s.cat.requestSuggestion({}), error => error.code === 'failed' && !error.message.includes('sk-synthetic'));
  assert.equal(JSON.stringify(s.cat.snapshot()).includes('sk-synthetic'), false);
  assert.equal(s.cat.snapshot().suggestion.state, 'failed');
});

test('suggestion output is cleaned and capped at 2000 characters', async () => {
  const s = setup({ reply: `<开心>![图](https://evil.example/x.png)好呀<@c:${F.OTHER_CAT}>` + '长'.repeat(3000) });
  const { text } = await s.cat.requestSuggestion({});
  assert(Array.from(text).length <= 2000); assert.equal(/<开心>|!\[|<@c:/.test(text), false);
});

test('generation tokens compare all four fields', () => {
  const t = { mode: 'assist', modeEpoch: 1, targetMessageId: 'm1', draftEpoch: 2 };
  assert.equal(sameToken(t, { ...t }), true);
  for (const key of Object.keys(t)) assert.equal(sameToken(t, { ...t, [key]: 'x' }), false, key);
});

test('the assist path has no send call', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/lobby-cat.cjs'), 'utf8');
  const body = source.slice(source.indexOf('async function suggest('), source.indexOf('/** Independent turn'));
  const request = source.slice(source.indexOf('async function requestSuggestion('), source.indexOf('function cancelSuggestion('));
  for (const part of [body, request]) assert.equal(/catSend|\.send\(|message\.send/.test(part), false);
});

test('providerGetter: only the chat-api backend with a stored key and secure storage yields a provider', () => {
  const { providerGetter } = require('../../apps/neko-workbench/lobby-cat.cjs');
  const made = [];
  const createChatApiProvider = options => { made.push(options); return { stream() {} }; };
  const runtime = (patch = {}, store = {}) => ({ closed: false, backend: 'chat-api',
    settings: { protocol: 'openai-chat', baseUrl: 'https://model.example.test/v1', model: 'synthetic-model', requestTimeoutMs: 30000 },
    secretStore: { has: () => true, available: () => true, get: async () => 'synthetic-key', ...store }, ...patch });
  assert.ok(providerGetter({ runtime: runtime(), createChatApiProvider })());
  assert.equal(made.length, 1); assert.equal(made[0].config.model, 'synthetic-model');
  assert.equal(JSON.stringify(made[0].config).includes('synthetic-key'), false);
  for (const [patch, store] of [[{ backend: 'neko' }], [{ closed: true }], [{ settings: { baseUrl: '', model: '' } }],
    [{}, { has: () => false }], [{}, { available: () => false }]]) {
    assert.equal(providerGetter({ runtime: runtime(patch, store), createChatApiProvider })(), null);
  }
  assert.equal(providerGetter({ runtime: null, createChatApiProvider })(), null);
  assert.equal(made.length, 1);
});

test('lobbyMemory is chat-api only and rechecks the backend on every call', async () => {
  const { WorkbenchMainChat, PERSONA } = require('../../apps/neko-workbench/main-chat-runtime.cjs');
  const calls = [];
  const runtime = { closed: false, backend: 'chat-api', memorySystem: {
    recall: async (...args) => { calls.push(['recall', ...args]); return []; },
    recordSharedExperience: async input => { calls.push(['record', input.id]); return { created: true }; } } };
  const lobbyMemory = WorkbenchMainChat.prototype.lobbyMemory;
  assert.equal(lobbyMemory.call({ ...runtime, backend: 'neko' }), null);
  assert.equal(lobbyMemory.call({ ...runtime, closed: true }), null);
  const memory = lobbyMemory.call(runtime);
  assert.equal(memory.personaId, PERSONA); assert.ok(Object.isFrozen(memory));
  await memory.recall('猫展', 300, undefined);
  assert.deepEqual(calls[0].slice(0, 4), ['recall', PERSONA, '猫展', 300]);
  runtime.backend = 'neko';
  await assert.rejects(() => memory.recall('猫展', 300));
  await assert.rejects(() => memory.recordSharedExperience({ id: 'seg-1' }));
  assert.equal(calls.length, 1);
});

test('lobby recall only returns memories whose entire provenance is from the lobby',async()=>{
  const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
  const values=[{text:'lobby',evidenceRefs:['lobby-msg:m1']},{text:'private',evidenceRefs:['chat-msg:m2']},
    {text:'mixed',evidenceRefs:['lobby-msg:m1','chat-msg:m2']},{text:'unknown',evidenceRefs:[]},{text:'unmarked'}];
  const runtime={closed:false,backend:'chat-api',memorySystem:{recall:async()=>values}};
  assert.deepEqual((await WorkbenchMainChat.prototype.lobbyMemory.call(runtime).recall('test',300)).map(v=>v.text),['lobby']);
});

test('the assist provider receives lobby memories but no private or mixed-provenance memories', async () => {
  const { WorkbenchMainChat } = require('../../apps/neko-workbench/main-chat-runtime.cjs');
  const runtime = { closed: false, backend: 'chat-api', memorySystem: { recall: async () => [
    { text: '公开大厅经历', evidenceRefs: ['lobby-msg:m1'] },
    { text: SECRET_MEMORY, evidenceRefs: ['chat-msg:m2'] },
    { text: '混合来源秘密', evidenceRefs: ['lobby-msg:m1', 'chat-msg:m2'] },
  ] } };
  const memory = WorkbenchMainChat.prototype.lobbyMemory.call(runtime);
  const s = setup({ recall: (...args) => memory.recall(...args) });
  const target = s.add(F.message());
  await s.cat.requestSuggestion({ targetMessageId: target.id });
  const prompt = s.provider.calls[0].persona.prompt;
  assert.match(prompt, /公开大厅经历/);
  assert.equal(prompt.includes(SECRET_MEMORY), false);
  assert.equal(prompt.includes('混合来源秘密'), false);
});
