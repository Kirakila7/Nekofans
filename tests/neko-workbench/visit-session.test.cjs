'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VisitStore } = require('../../apps/neko-workbench/visits/store.cjs');
const { createVisitSession, PROTOCOL } = require('../../apps/neko-workbench/visits/session.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 150; i++) { if (predicate()) return; await sleep(10); } throw new Error('wait_timeout'); }

function pair(t, { drop = () => false, generate, verify, grantFields = {}, sessionOptions = {} } = {}) {
  const listeners = {}, disconnects = {}, frames = [], calls = { host: 0, guest: 0 }, sessions = {}, stores = {};
  for (const role of ['host', 'guest']) {
    const other = role === 'host' ? 'guest' : 'host';
    stores[role] = new VisitStore(':memory:');
    const transport = {
      send(frame) { frames.push(structuredClone(frame)); if (!drop(frame, role)) queueMicrotask(() => listeners[other]?.({ senderVid: role, frame: structuredClone(frame) })); },
      onMessage(cb) { listeners[role] = cb; return () => { delete listeners[role]; }; },
      onDisconnect(cb) { disconnects[role] = cb; return () => { delete disconnects[role]; }; }, close() {},
    };
    sessions[role] = createVisitSession({ grant: { visit_id: 'room', role, vid: role, mode: 'text', identity_ticket: 'ticket-' + role, ...grantFields },
      persona: { name: role, description: 'public', privateNotes: 'must-not-leak' }, store: stores[role], transport,
      generate: async input => { calls[role]++; assert.deepEqual(Object.keys(input.persona).sort(), ['description', 'name']);
        return generate ? generate(input, role) : `${role} reply ${calls[role]}`; },
      verifyPeer: verify || (async ({ ticket, senderVid, role: peerRole }) => {
        assert.equal(ticket, 'ticket-' + senderVid); return { visit_id: 'room', vid: senderVid, role: peerRole };
      }), retryMs: 15, maxAttempts: 8, handshakeTimeoutMs: 300, ...(typeof sessionOptions === 'function' ? sessionOptions(role) : sessionOptions) });
  }
  t.after(() => { for (const role of ['host', 'guest']) { sessions[role].close(); stores[role].close(); } });
  const start = () => { sessions.host.start(); sessions.guest.start(); };
  return { sessions, stores, frames, calls, listeners, disconnects, start };
}

test('two independently generated peers handshake, alternate six messages, and persist identical isolated history', async t => {
  const p = pair(t); p.start();
  await until(() => p.sessions.host.snapshot().reason === 'completed' && p.sessions.guest.snapshot().reason === 'completed');
  assert.deepEqual(p.calls, { host: 3, guest: 3 });
  const host = p.sessions.host.snapshot();
  assert.deepEqual(host.messages.map(m => m.role), ['host', 'guest', 'host', 'guest', 'host', 'guest']);
  assert.deepEqual(host.messages, p.sessions.guest.snapshot().messages);
  assert.deepEqual(p.stores.host.getVisit('room').messages, host.messages);
  assert.ok(!JSON.stringify(p.stores.host.getVisit('room')).includes('ticket-'));
  assert.equal(p.frames.filter(f => f.type === 'text').length, 6);
});

test('lost hello, text and ACK are retried without duplicate model calls or persisted rows', async t => {
  const dropped = new Set();
  const p = pair(t, { drop(frame) { const key = `${frame.type}:${frame.senderVid}:${frame.seq}`;
    if (['hello', 'text', 'ack'].includes(frame.type) && !dropped.has(key)) { dropped.add(key); return true; } return false; } });
  p.start();
  await until(() => p.sessions.host.snapshot().reason === 'completed' && p.sessions.guest.snapshot().reason === 'completed');
  assert.deepEqual(p.calls, { host: 3, guest: 3 });
  assert.equal(p.stores.guest.getVisit('room').messages.length, 6);
  assert.ok(p.frames.filter(f => f.type === 'text').length > 6);
});

test('stopping aborts an in-flight model and ignores its late resolution', async t => {
  let resolve, signal;
  const p = pair(t, { generate(input) { signal = input.signal; return new Promise(r => { resolve = r; }); } });
  p.start(); await until(() => !!resolve);
  p.sessions.host.stop(); assert.equal(signal.aborted, true);
  resolve('late secret-looking text'); await sleep(50);
  assert.equal(p.frames.filter(f => f.type === 'text').length, 0);
  assert.equal(p.sessions.guest.snapshot().reason, 'peer_left');
});

test('disconnect aborts generation and never auto-resumes', async t => {
  let signal;
  const p = pair(t, { generate(input) { signal = input.signal; return new Promise(() => {}); } });
  p.start(); await until(() => !!signal); p.disconnects.host();
  assert.equal(signal.aborted, true);
  assert.equal(p.sessions.host.snapshot().reason, 'disconnected');
  p.sessions.host.start(); assert.equal(p.calls.host, 1);
});

test('lost leave and leave ACK are retried after stopping without another generation', async t => {
  let signal;
  const p = pair(t, { drop: (frame) => (frame.type === 'leave' && p.frames.filter(f => f.type === 'leave').length === 1)
      || (frame.type === 'ack' && p.frames.some(f => f.type === 'leave' && f.id === frame.replyTo)
        && p.frames.filter(f => f.type === 'ack' && f.replyTo === frame.replyTo).length === 1),
    generate(input) { signal = input.signal; return new Promise(() => {}); } });
  p.start(); await until(() => !!signal); p.sessions.host.stop();
  await until(() => p.sessions.guest.snapshot().reason === 'peer_left');
  await sleep(40);
  assert.equal(signal.aborted, true); assert.equal(p.calls.host, 1);
  assert.equal(p.frames.filter(f => f.type === 'leave').length, 3);
});

test('wrong identity claims prevent all model generation', async t => {
  const p = pair(t, { verify: async ({ senderVid, role }) => ({ visit_id: 'another-room', vid: senderVid, role }) });
  p.start(); await until(() => p.sessions.host.snapshot().phase === 'error' && p.sessions.guest.snapshot().phase === 'error');
  assert.deepEqual(p.calls, { host: 0, guest: 0 });
});

test('unauthenticated text, foreign rooms and spoofed sender IDs cannot enter history', async t => {
  let resolve;
  const p = pair(t, { generate() { return new Promise(r => { resolve = r; }); } });
  p.start();
  const hostile = { protocol: PROTOCOL, roomId: 'room', senderVid: 'attacker', type: 'text', id: 'forged', seq: 1, text: 'untrusted' };
  p.listeners.guest({ senderVid: 'attacker', frame: hostile });
  await until(() => !!resolve);
  p.listeners.guest({ senderVid: 'host', frame: { ...hostile, senderVid: 'guest' } });
  p.listeners.guest({ senderVid: 'host', frame: { ...hostile, senderVid: 'host', roomId: 'other' } });
  await sleep(20); assert.equal(p.stores.guest.getVisit('room').messages.length, 0);
});

test('unacknowledged handshake terminates at the invitation deadline', async t => {
  const p = pair(t, { drop: () => true }); p.start();
  await until(() => p.sessions.host.snapshot().phase === 'error');
  assert.equal(p.sessions.host.snapshot().reason, 'handshake_timeout');
  assert.equal(p.calls.host, 0);
  assert.ok(p.frames.filter(f => f.senderVid === 'host').length > 8);
});

test('host survives more than normal retry budget while guest decides to accept', async t => {
  const p = pair(t);
  p.sessions.host.start(); await sleep(180);
  assert.equal(p.sessions.host.snapshot().phase, 'connecting'); assert.equal(p.calls.host, 0);
  p.sessions.guest.start();
  await until(() => p.sessions.host.snapshot().reason === 'completed' && p.sessions.guest.snapshot().reason === 'completed');
  assert.deepEqual(p.calls, { host: 3, guest: 3 });
});

test('explicit deadline and grant expiration bound the human wait', async t => {
  const p = pair(t, { drop: () => true, sessionOptions: { handshakeDeadlineMs: Date.now() + 60 } });
  p.start(); await until(() => p.sessions.host.snapshot().phase === 'error');
  assert.equal(p.sessions.host.snapshot().reason, 'handshake_timeout');
  const expired = pair(t, { grantFields: { expires_at: new Date(Date.now() - 1000).toISOString() } });
  assert.throws(() => expired.sessions.host.start(), /visit_expired/);
  assert.equal(expired.frames.length, 0);
});

test('Chinese and emoji replies respect UTF-8 frame budget and preserve whole codepoints', async t => {
  const p = pair(t, { generate: async () => '猫😀'.repeat(1000) }); p.start();
  await until(() => p.sessions.host.snapshot().reason === 'completed' && p.sessions.guest.snapshot().reason === 'completed');
  for (const frame of p.frames) assert.ok(Buffer.byteLength(JSON.stringify(frame), 'utf8') <= 4096);
  for (const message of p.sessions.host.snapshot().messages) {
    assert.ok(Buffer.byteLength(message.text, 'utf8') <= 2000);
    assert.ok([...message.text].length <= 1024);
    assert.equal(Buffer.from(message.text, 'utf8').toString('utf8'), message.text);
    assert.doesNotMatch(message.text, /\uFFFD/);
  }
});

test('oversized hello fails before sending or recording secret ticket', t => {
  const p = pair(t, { grantFields: { identity_ticket: 'x'.repeat(4096) } });
  assert.throws(() => p.sessions.host.start(), /visit_hello_too_large/);
  assert.equal(p.frames.length, 0); assert.equal(p.stores.host.getVisit('room'), null);
});

test('peer ACK followed by silence expires the turn wait even when transport remains connected', async t => {
  const p = pair(t, { generate: async (_, role) => role === 'host' ? 'host says hello' : new Promise(() => {}),
    sessionOptions: role => ({ idleTimeoutMs: role === 'host' ? 60 : 500 }) });
  p.start();
  await until(() => p.frames.some(f => f.type === 'ack' && f.senderVid === 'guest' && f.seq === 1));
  // Authenticated but irrelevant control traffic must not extend the turn deadline.
  const noise = setInterval(() => p.listeners.host?.({ senderVid: 'guest', frame: {
    protocol: PROTOCOL, roomId: 'room', senderVid: 'guest', type: 'ack', id: 'noise', seq: 0, replyTo: 'unknown' } }), 5);
  try { await until(() => p.sessions.host.snapshot().phase === 'error'); }
  finally { clearInterval(noise); }
  assert.equal(p.sessions.host.snapshot().reason, 'idle_timeout');
  assert.equal(p.calls.host, 1); assert.equal(p.calls.guest, 1);
  await until(() => p.sessions.guest.snapshot().reason === 'peer_left');
});

test('a hung local model is aborted by the turn deadline and late output cannot escape', async t => {
  let signal, resolve;
  const p = pair(t, { generate: input => { signal = input.signal; return new Promise(r => { resolve = r; }); },
    sessionOptions: role => ({ idleTimeoutMs: role === 'host' ? 40 : 500 }) });
  p.start(); await until(() => p.sessions.host.snapshot().reason === 'idle_timeout');
  assert.equal(signal.aborted, true); resolve('late output'); await sleep(20);
  assert.equal(p.frames.filter(f => f.type === 'text').length, 0);
});

test('absolute session deadline cannot be extended by continuing turn progress', async t => {
  const p = pair(t, { generate: async () => { await sleep(25); return 'still chatting'; },
    sessionOptions: role => ({ idleTimeoutMs: 200, maxSessionMs: role === 'host' ? 60 : 500 }) });
  p.start(); await until(() => p.sessions.host.snapshot().phase === 'error');
  assert.equal(p.sessions.host.snapshot().reason, 'session_timeout');
  assert.ok(p.sessions.host.snapshot().messages.length >= 1);
  assert.ok(p.sessions.host.snapshot().messages.length < 6);
});

test('reopened SQLite history is readable and an existing room cannot auto-resume', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'visits.sqlite');
  let store = new VisitStore(file);
  const room = { visitId: 'room', role: 'host', vid: 'owner', persona: { name: 'cat', description: 'public' } };
  store.openVisit(room); store.appendMessage('room', { id: 'one', seq: 1, senderVid: 'owner', role: 'host', text: 'hello' }); store.close();
  store = new VisitStore(file);
  try { assert.equal(store.getVisit('room').messages[0].text, 'hello'); assert.equal(store.getVisit('room').reason, 'interrupted');
    assert.throws(() => store.openVisit(room), /already_recorded/); }
  finally { store.close(); }
});
