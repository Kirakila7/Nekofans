'use strict';
// Regression: a replayed own message after a segment closed would have started
// a second segment with duplicate experience. This verifies replay rejection.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createLobbyExperience, LIMITS } = require('../../apps/neko-workbench/lobby-experience.cjs');
const F = require('./lobby-fixtures.cjs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-lobby-duplicate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = F.fakeTimers(), provider = F.fakeProvider('我和主人在大厅里聊了合成的话题。'), writes = [];
  const memory = { recordSharedExperience: async input => { writes.push(input); return { created: true }; } };
  const file = path.join(dir, 'lobby', 'pending-experience.json');
  const exp = createLobbyExperience({ file, getProvider: () => provider, getMemory: () => memory, now: clock.now, timers: clock.timers });
  return { dir, file, clock, provider, writes, memory, exp };
}
const ctx = (mode = 'assist') => ({ channelId: 'ch-lobby', ownerId: F.OWNER, catId: F.CAT, mode });

test('replayed own message after segment closed does not record a duplicate', async t => {
  const s = setup(t);
  const own = F.owner({ id: 'm-replay-target', text: '主人发了这条', created_at: s.clock.now() });
  // First time: live
  s.exp.observe(own, ctx());
  assert.equal(s.exp.hasOpenSegment(), true);
  // Close the segment after idle
  await s.clock.advance(LIMITS.idleMs); await s.exp.idle();
  assert.equal(s.writes.length, 1);
  const firstId = s.writes[0].id;
  assert.equal(s.exp.hasOpenSegment(), false);

  // Reconnect: the resume replay re-delivers the own message with live=false;
  // the controller still forwards own messages to observe().
  s.exp.observe(own, ctx());
  assert.equal(s.exp.hasOpenSegment(), false, 'replay after closed segment must not start a new segment');

  // Another message starts a fresh segment normally
  const fresh = F.owner({ id: 'm-fresh', text: '重连后的新消息', created_at: s.clock.now() });
  s.exp.observe(fresh, ctx());
  assert.equal(s.exp.hasOpenSegment(), true);
  await s.clock.advance(LIMITS.idleMs); await s.exp.idle();
  assert.equal(s.writes.length, 2);
  assert.notEqual(s.writes[1].id, firstId);
  assert.equal(s.writes[1].evidenceRefs.includes('lobby-msg:' + own.id), false, 'replayed message must not appear in new segment');
  assert.equal(s.writes[1].evidenceRefs.includes('lobby-msg:' + fresh.id), true);
});

test('a deleted message replayed on resume never re-enters a segment', async t => {
  const s = setup(t);
  const msg = F.owner({ id: 'm-deleted', text: '临时消息', created_at: s.clock.now() });
  s.exp.observe(msg, ctx());
  s.exp.deleted(msg.id);
  await s.clock.advance(LIMITS.idleMs); await s.exp.idle();
  assert.equal(s.writes.length, 0, 'segment with only deleted messages does not write');
  s.exp.observe(msg, ctx());                                   // resume replay of message.new
  assert.equal(s.exp.hasOpenSegment(), false);
  s.exp.close(); await s.exp.idle();
  assert.equal(s.writes.length, 0);
});

test('the recorded id set is bounded; recent ids are still rejected', async t => {
  const s = setup(t);
  const messages = Array.from({ length: LIMITS.recorded + 10 }, (_, i) => F.owner({ id: `m${i}`, text: `msg${i}`, created_at: s.clock.now() }));
  for (const msg of messages) s.exp.observe(msg, ctx());
  await s.clock.advance(LIMITS.idleMs); await s.exp.idle();
  assert.equal(s.writes.length, 1);

  s.exp.observe(messages[999], ctx());
  assert.equal(s.exp.hasOpenSegment(), false, 'replay of recently recorded message is rejected');

  s.exp.observe(messages[5], ctx());
  assert.equal(s.exp.hasOpenSegment(), true, 'replay of evicted message is allowed to start a new segment');
});
