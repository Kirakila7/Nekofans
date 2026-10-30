'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createLobbyExperience, segmentId, LIMITS } = require('../../apps/neko-workbench/lobby-experience.cjs');
const F = require('./lobby-fixtures.cjs');
const RAW = '合成原文：这句话不应该写进记忆';

function setup(t, { reply = '我和主人在大厅里聊了合成的乌龙茶，阿布说他也喜欢。', memory: memoryOn = true, provider: providerOn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-lobby-experience-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = F.fakeTimers(), provider = F.fakeProvider(reply), writes = [];
  const memory = { recordSharedExperience: async input => { writes.push(input); return { created: true }; } };
  const file = path.join(dir, 'lobby', 'pending-experience.json');
  const make = (extra = {}) => createLobbyExperience({ file, getProvider: () => providerOn ? provider : null, getMemory: () => memoryOn ? memory : null,
    now: clock.now, timers: clock.timers, ...extra });
  return { dir, file, clock, provider, writes, memory, make, exp: make() };
}
const ctx = (mode = 'assist') => ({ channelId: 'ch-lobby', ownerId: F.OWNER, catId: F.CAT, mode });

test('a segment collects the owner, her cat and replies, then summarizes after 10 idle minutes', async t => {
  const s = setup(t);
  const asked = F.message({ text: '谁喜欢乌龙茶？', created_at: s.clock.now() });
  s.exp.observe(asked, ctx());
  assert.equal(s.exp.hasOpenSegment(), false);                       // a segment starts with the owner
  const own = F.owner({ text: RAW, reply_to: { id: asked.id }, created_at: s.clock.now() });
  s.exp.observe(own, ctx());
  const reply = F.message({ text: '我也喜欢', reply_to: { id: own.id }, created_at: s.clock.now() });
  s.exp.observe(reply, ctx());
  s.exp.observe(F.message({ text: '无关闲聊', created_at: s.clock.now() }), ctx());
  s.exp.observe(F.myCat({ text: '喵', created_at: s.clock.now() }), ctx());
  await s.clock.advance(LIMITS.idleMs - 1); assert.equal(s.writes.length, 0);
  await s.clock.advance(1); await s.exp.idle();
  assert.equal(s.writes.length, 1);
  const [write] = s.writes;
  assert.equal(write.id, segmentId('ch-lobby', own.id));
  assert.match(write.text, /^10月29日(?:凌晨|早上|上午|中午|下午|晚上)，我和主人在大厅里/);
  assert.equal(write.text.includes(RAW), false);
  assert.equal(write.occurredAt, s.clock.now() - LIMITS.idleMs);
  assert.equal(write.evidenceRefs.length, 4);
  assert(write.evidenceRefs.every(ref => /^lobby-msg:m\d+$/.test(ref)));
  assert.equal(write.evidenceRefs.includes('lobby-msg:' + asked.id), true);
  const prompt = s.provider.calls[0];
  assert.equal(prompt.messages[0].text.includes('无关闲聊'), false);
  assert.match(prompt.messages[0].text, /\[主人\]: 合成原文/); assert.match(prompt.messages[0].text, /\[你\]: 喵/);
  assert.match(prompt.persona.prompt, /一到两句话/); assert.deepEqual(prompt.memories, []);
});

test('leaving the lobby and switching mode close the segment early', async t => {
  const s = setup(t);
  s.exp.observe(F.owner({ created_at: s.clock.now() }), ctx()); s.exp.leave(); await s.exp.idle();
  assert.equal(s.writes.length, 1);
  s.exp.setMode('assist');
  s.exp.observe(F.owner({ created_at: s.clock.now() }), ctx()); s.exp.setMode('independent'); await s.exp.idle();
  assert.equal(s.writes.length, 2);
  s.exp.observe(F.owner({ created_at: s.clock.now() }), ctx('assist'));
  s.exp.observe(F.owner({ created_at: s.clock.now() }), ctx('independent')); await s.exp.idle();
  assert.equal(s.writes.length, 3); assert.equal(s.exp.hasOpenSegment(), true);
});

test('mode off, deleted messages and other people alone never produce memory', async t => {
  const s = setup(t);
  s.exp.observe(F.owner({ created_at: s.clock.now() }), ctx('off'));
  s.exp.observe(F.message({ created_at: s.clock.now() }), ctx());
  s.exp.close(); await s.exp.idle(); assert.equal(s.writes.length, 0);
  const first = F.owner({ created_at: s.clock.now() }), second = F.owner({ created_at: s.clock.now() });
  s.exp.observe(first, ctx()); s.exp.observe(second, ctx()); s.exp.deleted(second.id); s.exp.close(); await s.exp.idle();
  assert.deepEqual(s.writes[0].evidenceRefs, ['lobby-msg:' + first.id]);
});

test('summary failure is retried once, then dropped without writing raw text', async t => {
  let calls = 0;
  const s = setup(t, { reply: () => { calls++; return calls === 1 ? new Error('synthetic') : '我和主人在大厅聊了天。'; } });
  s.exp.observe(F.owner({ text: RAW, created_at: s.clock.now() }), ctx()); s.exp.close(); await s.exp.idle();
  assert.equal(calls, 2); assert.equal(s.writes.length, 1);
  const bad = setup(t, { reply: new Error('synthetic') });
  bad.exp.observe(F.owner({ text: RAW, created_at: bad.clock.now() }), ctx()); bad.exp.close(); await bad.exp.idle();
  assert.equal(bad.provider.calls.length, 2); assert.equal(bad.writes.length, 0);
  const empty = setup(t, { reply: '[PASS]' });
  empty.exp.observe(F.owner({ created_at: empty.clock.now() }), ctx()); empty.exp.close(); await empty.exp.idle();
  assert.equal(empty.writes.length, 0);
});

test('summary output is cleaned of links, tags and media', async t => {
  const s = setup(t, { reply: '<开心>我和主人在大厅看了 ![图](https://evil.example/a.png) https://evil.example/b 的帖子。' });
  s.exp.observe(F.owner({ created_at: s.clock.now() }), ctx()); s.exp.close(); await s.exp.idle();
  assert.equal(/https?:|<开心>|!\[/.test(s.writes[0].text), false);
});

test('without a chat-api provider or memory nothing is summarized', async t => {
  for (const options of [{ provider: false }, { memory: false }]) {
    const s = setup(t, options);
    s.exp.observe(F.owner({ created_at: s.clock.now() }), ctx()); s.exp.close(); await s.exp.idle();
    assert.equal(s.provider.calls.length, 0); assert.equal(s.writes.length, 0);
  }
});

test('quit persists the open segment 0600 without summarizing; the next start summarizes and removes it', async t => {
  const s = setup(t);
  s.exp.observe(F.owner({ text: RAW, created_at: s.clock.now() }), ctx());
  assert.equal(s.exp.persistOnQuit(), true);
  assert.equal(s.provider.calls.length, 0);
  // Windows reports DOS mode bits rather than the effective ACL.
  if(process.platform!=='win32')assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.segments.length, 1);

  const offline = s.make({ getProvider: () => null });
  assert.equal(await offline.processPending(), 0); assert.equal(fs.existsSync(s.file), true);   // kept for a chat-api start

  const next = s.make();
  assert.equal(await next.processPending(), 1);
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(s.writes.length, 1); assert.equal(s.writes[0].text.includes(RAW), false);
  assert.equal(s.writes[0].id, saved.segments[0].id);
  assert.equal(s.exp.persistOnQuit(), false);
});

test('a corrupt, oversized or stale pending file is discarded', async t => {
  const s = setup(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  for (const body of ['{oops', JSON.stringify({ version: 2, segments: [] }), JSON.stringify({ version: 1,
    segments: [{ id: 'seg-x', channelId: 'ch', endedAt: s.clock.now() - LIMITS.pendingAgeMs - 1, lines: [{ id: 'm1', seq: 1, line: 'x' }] }] })]) {
    fs.writeFileSync(s.file, body, { mode: 0o600 });
    assert.equal(await s.make().processPending(), 0); assert.equal(fs.existsSync(s.file), false);
  }
  assert.equal(s.writes.length, 0);
});

test('quit preserves a segment whose model summary is still in flight',async t=>{
  const s=setup(t),slow=F.fakeProvider('我和主人聊了合成话题。',{hold:true}),exp=s.make({getProvider:()=>slow});
  exp.observe(F.owner({text:RAW,created_at:s.clock.now()}),ctx());exp.close();await F.flush();
  assert.equal(exp.hasOpenSegment(),false);assert.equal(exp.persistOnQuit(),true);
  slow.release();await exp.idle();assert.equal(s.writes.length,0);assert.equal(fs.existsSync(s.file),true);
  assert.equal(await s.make().processPending(),1);assert.equal(s.writes.length,1);assert.equal(fs.existsSync(s.file),false);
});

test('a temporary memory write failure preserves pending records for the next retry',async t=>{
  const s=setup(t);s.exp.observe(F.owner({created_at:s.clock.now()}),ctx());s.exp.persistOnQuit();
  const broken=s.make({getMemory:()=>({recordSharedExperience:async()=>{throw Error('temporary')}})});
  assert.equal(await broken.processPending(),0);assert.equal(fs.existsSync(s.file),true);
  assert.equal(await s.make().processPending(),1);assert.equal(s.writes.length,1);assert.equal(fs.existsSync(s.file),false);
});

test('a failed live memory write queues the segment rather than dropping it',async t=>{
  const s=setup(t),broken=s.make({getMemory:()=>({recordSharedExperience:async()=>{throw Error('temporary')}})});
  broken.observe(F.owner({created_at:s.clock.now()}),ctx());broken.close();await broken.idle();
  assert.equal(fs.existsSync(s.file),true);assert.equal(await s.make().processPending(),1);assert.equal(s.writes.length,1);
});

test('an unreadable pending queue is preserved instead of being treated as empty',async t=>{
  const s=setup(t);s.exp.observe(F.owner({created_at:s.clock.now()}),ctx());s.exp.persistOnQuit();
  const original=fs.readFileSync;t.mock.method(fs,'readFileSync',(file,...args)=>{
    if(file===s.file)throw Object.assign(Error('temporarily unreadable'),{code:'EACCES'});
    return original(file,...args);
  });
  await assert.rejects(s.make().processPending(),{code:'EACCES'});assert.equal(fs.existsSync(s.file),true);
});

test('lobby-experience never logs and never writes raw text to memory', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/lobby-experience.cjs'), 'utf8');
  assert.equal(/console\.|logger/.test(source), false);
  assert.match(source, /recordSharedExperience\(\{ id: segment\.id, text: stamped/);
});
