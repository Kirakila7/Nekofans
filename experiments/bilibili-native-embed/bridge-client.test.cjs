const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { BridgeClient, SerialSession } = require('./bridge-client.cjs');

function fixture(timeout = 200) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  const sent = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    sent.push(JSON.parse(chunk)); child.emit('sent'); callback();
  } });
  const bridge = new BridgeClient(child, { timeout });
  const reply = event => child.stdout.write(JSON.stringify(event) + '\n');
  return { child, sent, bridge, reply };
}
test('late or unsolicited replies cannot acknowledge another command', async () => {
  const { child, sent, bridge, reply } = fixture();
  const first = bridge.command({ op: 'attach' }); await once(child, 'sent');
  reply({ type: 'attached', requestId: sent[0].requestId }); await first;
  const second = bridge.command({ op: 'detach' }); await once(child, 'sent');
  let resolved = false; second.then(() => { resolved = true; });
  reply({ type: 'attached', requestId: sent[0].requestId });
  reply({ type: 'detached' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  reply({ type: 'detached', requestId: sent[1].requestId }); await second;
});
test('timed-out attach stops queued mutations and requires explicit native restoration', async () => {
  const { child, sent, bridge, reply } = fixture(30);
  const first = bridge.command({ op: 'attach' });
  const queued = bridge.command({ op: 'detach' });
  const outcomes = await Promise.allSettled([first, queued]);
  assert.ok(outcomes.every(result => result.status === 'rejected'));
  assert.equal(sent.length, 1);
  assert.equal(child.stdin.writableEnded, true);
  reply({ type: 'attached', requestId: sent[0].requestId });
  assert.equal(bridge.safeToClose, false);
  const restored = bridge.waitForRestore();
  reply({ type: 'bridge-closed', safeToClose: true }); await restored;
});
test('helper crash without a restoration acknowledgement cannot release host', async () => {
  const { child, bridge } = fixture();
  const command = bridge.command({ op: 'attach' }); await once(child, 'sent');
  child.emit('close', 1);
  await assert.rejects(command, /closed/);
  await assert.rejects(bridge.waitForRestore(), /without confirming restoration/);
});
test('stdin failure rejects request and never starts queued work', async () => {
  const { child, bridge, sent } = fixture();
  const request = bridge.command({ op: 'attach' }); await once(child, 'sent');
  child.stdin.emit('error', new Error('broken pipe'));
  await assert.rejects(request, /broken pipe/);
  await assert.rejects(bridge.command({ op: 'detach' }), /broken pipe/);
  assert.equal(sent.length, 1);
});
test('close waits for in-flight startup, rejects queued attach and runs restoration once', async () => {
  const session = new SerialSession();
  const events = [];
  let release;
  const startup = session.run(async () => {
    events.push('start'); await new Promise(resolve => { release = resolve; });
    if (!session.closing) events.push('attach');
  });
  await new Promise(resolve => setImmediate(resolve));
  const pendingAttach = session.run(() => events.push('unexpected attach'));
  const rejected = assert.rejects(pendingAttach, /closing/);
  const close = session.close(() => events.push('restore'));
  assert.equal(session.close(() => events.push('duplicate restore')), close);
  release(); await Promise.all([startup, rejected, close]);
  assert.deepEqual(events, ['start', 'restore']);
});
test('failed restoration permits a controlled close retry', async () => {
  const session = new SerialSession();
  await assert.rejects(session.close(() => { throw new Error('restore failed'); }), /restore failed/);
  assert.equal(session.closing, false);
  let restored = false; await session.close(() => { restored = true; });
  assert.equal(restored, true);
});
