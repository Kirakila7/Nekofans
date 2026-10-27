'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDshLifecycle } = require('../../apps/neko-workbench/dsh-lifecycle.cjs');

function fixture(pid = 123) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new EventEmitter();
  child.eof = 0;
  child.stdin.end = () => { child.eof++; };
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  const timers = [];
  const errors = [], closes = [];
  const lifecycle = createDshLifecycle(child, {
    schedule(callback, delay) { const timer = { callback, delay, canceled: false }; timers.push(timer); return timer; },
    cancel(timer) { timer.canceled = true; }, onError: error => errors.push(error), onClose: event => closes.push(event),
  });
  return { child, lifecycle, errors, closes, timers, tick(delay) {
    for (const timer of [...timers]) if (!timer.canceled && timer.delay === delay) { timer.canceled = true; timer.callback(); }
  } };
}

test('spawn error followed by close without exit releases state and shutdown needs no late close event', async () => {
  const f = fixture(null);
  const error = Object.assign(new Error('missing shebang interpreter'), { code: 'ENOENT' });
  f.child.emit('error', error);
  f.child.emit('close', -2, null); // Node does not emit exit for this failure.
  assert.equal(f.lifecycle.closed, true);
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.closes, [{ code: -2, signal: null, error }]);
  assert.deepEqual(await f.lifecycle.stop(), { timedOut: false });
  assert.equal(f.timers.length, 0);
  assert.equal(f.child.eof, 0);
  assert.deepEqual(f.child.signals, []);
  // The owner may create a new lifecycle after the close callback clears its
  // old child/start promise; the failed process cannot consume its events.
  const replacement = fixture(456);
  replacement.child.emit('close', 0, null);
  assert.equal(replacement.closes.length, 1);
  assert.equal(f.closes.length, 1);
});

test('shutdown before spawn returns immediately instead of waiting for an exit that cannot occur', async () => {
  const f = fixture(null);
  assert.equal(f.lifecycle.spawned, false);
  assert.deepEqual(await f.lifecycle.stop(), { timedOut: false });
  assert.equal(f.timers.length, 0);
  assert.equal(f.child.eof, 0);
});

test('graceful close ends stdin once and cancels every fallback signal', async () => {
  const f = fixture();
  const stopped = f.lifecycle.stop();
  assert.equal(f.lifecycle.stop(), stopped);
  assert.equal(f.child.eof, 1);
  f.child.emit('close', 0, null);
  assert.deepEqual(await stopped, { timedOut: false });
  for (const delay of [1000, 4000, 5000]) f.tick(delay);
  assert.deepEqual(f.child.signals, []);
  assert(f.timers.every(timer => timer.canceled));
  assert.equal(f.closes.length, 1);
});

test('stuck owned process receives TERM then KILL and cannot block application quit indefinitely', async () => {
  const f = fixture();
  const stopped = f.lifecycle.stop();
  f.tick(1000);
  assert.deepEqual(f.child.signals, ['SIGTERM']);
  f.tick(4000);
  assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
  f.tick(5000);
  assert.deepEqual(await stopped, { timedOut: true });
  assert.equal(f.lifecycle.closed, false);
  assert(f.timers.every(timer => timer.canceled));
  f.child.emit('close', null, 'SIGKILL');
  assert.equal(f.closes.length, 1, 'late close is still delivered once');
});
