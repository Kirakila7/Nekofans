'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoordinator } = require('../../apps/neko-workbench/fish-qq-coordinator.cjs');
const { createFishControl } = require('../../apps/neko-workbench/fish-care.cjs');

const paused = { enabled: false, phase: 'paused', reason: '已暂停' };
const running = { enabled: true, phase: 'running', reason: '正在运行' };
const both = () => ({ fish: true, qqbot: true });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
function channel(calls) {
  return async action => {
    calls.push(action);
    return action === 'start' ? running : paused;
  };
}

test('default selection starts only Fish without probing the unselected QQ channel', async () => {
  const fish = [], qq = [];
  const coordinator = createCoordinator({ fishAction: channel(fish), qqbotAction: channel(qq) });
  const result = await coordinator.start();
  assert.deepEqual(result.selection, { fish: true, qqbot: false });
  assert.equal(result.fish.phase, 'running');
  assert.equal(result.qqbot.phase, 'paused');
  assert.deepEqual(fish, ['start']);
  assert.deepEqual(qq, []);
});

test('QQ-only selection starts without calling Fish or inheriting its failure', async () => {
  const qq = [];
  const coordinator = createCoordinator({
    getSelection: () => ({ fish: false, qqbot: true }),
    fishAction: () => { throw Error('Fish must not be called'); }, qqbotAction: channel(qq),
  });
  assert.equal((await coordinator.start()).qqbot.phase, 'running');
  assert.deepEqual(qq, ['start']);
});

test('selected channels start independently while Fish checks are pending or fail', async () => {
  const fishGate = deferred(), qq = [];
  const coordinator = createCoordinator({ getSelection: both,
    fishAction: () => fishGate.promise, qqbotAction: channel(qq),
  });
  const start = coordinator.start();
  await turn();
  assert.deepEqual(qq, ['start'], 'QQ must not wait for the Fish prerequisite');
  fishGate.resolve({ enabled: false, phase: 'error', reason: 'Fish failed' });
  const result = await start;
  assert.equal(result.fish.phase, 'error');
  assert.equal(result.qqbot.phase, 'running');
});

test('concurrent starts share one operation and invoke each channel once', async () => {
  const gate = deferred(), fish = [], qq = [];
  const coordinator = createCoordinator({ getSelection: both,
    fishAction: action => { fish.push(action); return gate.promise; }, qqbotAction: channel(qq),
  });
  const first = coordinator.start(), second = coordinator.start(), third = coordinator.start();
  assert.equal(first, second);
  assert.equal(second, third);
  await turn();
  gate.resolve(running);
  await Promise.all([first, second, third]);
  assert.deepEqual(fish, ['start']);
  assert.deepEqual(qq, ['start']);
});

test('pause immediately cancels pending starts and ignores their late results', async () => {
  const gate = deferred(), calls = [];
  const coordinator = createCoordinator({ getSelection: both,
    fishAction: action => { calls.push(`fish:${action}`); return action === 'start' ? gate.promise : paused; },
    qqbotAction: action => { calls.push(`qq:${action}`); return action === 'start' ? gate.promise : paused; },
  });
  const starting = coordinator.start();
  await turn();
  const pausing = coordinator.pause();
  assert.deepEqual(calls, ['fish:start', 'qq:start', 'fish:pause', 'qq:pause']);
  assert.equal(coordinator.pause(), pausing);
  const result = await pausing;
  assert.equal(result.fish.phase, 'paused');
  gate.resolve(running);
  await starting;
  assert.equal(coordinator.snapshot().fish.phase, 'paused');
  assert.equal(coordinator.snapshot().qqbot.phase, 'paused');
  assert.equal(coordinator.snapshot().overall, 'idle');
});

test('pause reaches the real Fish intent before delayed login verification can launch a scheduler', async () => {
  const verification = deferred();
  let launches = 0;
  const fish = createFishControl({ read: () => ({}), write: () => {}, hasCredentials: () => true,
    verify: () => verification.promise, start: () => { launches++; return { stop() {} }; },
  });
  const coordinator = createCoordinator({ fishAction: fish.action, qqbotAction: async () => paused });
  const starting = coordinator.start();
  await turn();
  const pausing = coordinator.pause();
  verification.resolve();
  await Promise.all([starting, pausing]);
  assert.equal(launches, 0);
  assert.equal((await fish.action('status')).phase, 'paused');
});

test('start waits for an older pause so that it cannot stop a new runtime', async () => {
  const stopped = deferred(), calls = [];
  const coordinator = createCoordinator({
    fishAction: action => { calls.push(action); return action === 'pause' ? stopped.promise : running; },
    qqbotAction: async () => paused,
  });
  const pausing = coordinator.pause();
  const starting = coordinator.start();
  await turn();
  assert.deepEqual(calls, ['pause']);
  stopped.resolve(paused);
  await Promise.all([pausing, starting]);
  assert.deepEqual(calls, ['pause', 'start']);
  assert.equal(coordinator.snapshot().fish.phase, 'running');
});

test('a second pause cancels a start queued behind the first pause', async () => {
  const stopped = deferred(), calls = [];
  const coordinator = createCoordinator({
    fishAction: action => { calls.push(action); return stopped.promise; }, qqbotAction: async () => paused,
  });
  const firstPause = coordinator.pause();
  const start = coordinator.start();
  const lastPause = coordinator.pause();
  stopped.resolve(paused);
  await Promise.all([firstPause, start, lastPause]);
  assert.deepEqual(calls, ['pause']);
  assert.equal(coordinator.snapshot().fish.phase, 'paused');
  assert.equal(coordinator.snapshot().unified, false);
});

test('a slow QQ pause cannot overwrite a Fish restart reported after Fish has already paused', async () => {
  const qqStopped = deferred();
  const coordinator = createCoordinator({ fishAction: async () => paused,
    qqbotAction: () => qqStopped.promise,
  });
  coordinator.updateChannel('fish', running);
  const pausing = coordinator.pause();
  await turn();
  assert.equal(coordinator.snapshot().fish.phase, 'paused');
  coordinator.updateChannel('fish', running);
  qqStopped.resolve(paused);
  assert.equal((await pausing).fish.phase, 'running');
});

test('deselection pause cannot overwrite a newer channel event', async () => {
  const stopped = deferred();
  const coordinator = createCoordinator({ fishAction: () => stopped.promise, qqbotAction: async () => paused });
  const selecting = coordinator.setSelection({ fish: false });
  await turn();
  coordinator.updateChannel('fish', { ...paused, phase: 'error', reason: 'stop could not be confirmed' });
  stopped.resolve(paused);
  assert.equal((await selecting).fish.phase, 'error');
});

test('status is read-only and a delayed poll returns the newer notification', async () => {
  const gate = deferred(), notifications = [];
  const coordinator = createCoordinator({ fishAction: () => gate.promise, qqbotAction: async () => paused,
    notify: value => notifications.push(value),
  });
  const status = coordinator.status();
  coordinator.updateChannel('fish', running);
  const count = notifications.length;
  gate.resolve(paused);
  assert.equal((await status).fish.phase, 'running');
  assert.equal(notifications.length, count);
  assert.equal(coordinator.snapshot().fish.phase, 'running');
});

test('status returns fresh values without mutating cached state or broadcasting', async () => {
  const notifications = [];
  const coordinator = createCoordinator({ fishAction: async () => running, qqbotAction: async () => paused,
    notify: value => notifications.push(value),
  });
  assert.equal((await coordinator.status()).fish.phase, 'running');
  assert.equal(coordinator.snapshot().fish.phase, 'paused');
  assert.deepEqual(notifications, []);
});

test('a status read started before pause cannot report the previous running state', async () => {
  const gate = deferred();
  const coordinator = createCoordinator({ fishAction: action => action === 'status' ? gate.promise : paused,
    qqbotAction: async () => paused,
  });
  const status = coordinator.status();
  await coordinator.pause();
  gate.resolve(running);
  assert.equal((await status).fish.phase, 'paused');
});

test('late start results cannot overwrite a more recent channel status event', async () => {
  const gate = deferred();
  const coordinator = createCoordinator({ fishAction: () => gate.promise, qqbotAction: async () => paused });
  const start = coordinator.start();
  await turn();
  coordinator.updateChannel('fish', { ...paused, phase: 'error', reason: 'runtime stopped' });
  gate.resolve(running);
  assert.equal((await start).fish.phase, 'error');
});

test('selection is saved before use and deselecting one channel leaves the other running', async () => {
  const fish = [], qq = [], saves = [], saved = deferred();
  const coordinator = createCoordinator({ getSelection: both, fishAction: channel(fish), qqbotAction: channel(qq),
    saveSelection: value => { saves.push(value); return saved.promise; },
  });
  await coordinator.start();
  const selecting = coordinator.setSelection({ qqbot: false });
  await turn();
  assert.deepEqual(coordinator.snapshot().selection, both());
  assert.deepEqual(qq, ['start']);
  saved.resolve();
  const result = await selecting;
  assert.deepEqual(saves, [{ fish: true, qqbot: false }]);
  assert.equal(result.fish.phase, 'running');
  assert.equal(result.qqbot.phase, 'paused');
  assert.deepEqual(fish, ['start']);
  assert.deepEqual(qq, ['start', 'pause']);
});

test('deselection cancels only the affected pending channel result', async () => {
  const gate = deferred();
  const coordinator = createCoordinator({ getSelection: both,
    fishAction: action => action === 'start' ? gate.promise : paused,
    qqbotAction: action => action === 'start' ? gate.promise : paused,
  });
  const start = coordinator.start();
  await turn();
  await coordinator.setSelection({ qqbot: false });
  gate.resolve(running);
  const result = await start;
  assert.equal(result.fish.phase, 'running');
  assert.equal(result.qqbot.phase, 'paused');
});

test('start uses a newly selected channel while an older deselected start is still pending', async () => {
  const gate = deferred(), fish = [], qq = [];
  const coordinator = createCoordinator({
    fishAction: action => { fish.push(action); return action === 'start' ? gate.promise : paused; },
    qqbotAction: channel(qq),
  });
  const oldStart = coordinator.start();
  await turn();
  await coordinator.setSelection({ fish: false, qqbot: true });
  const newStart = coordinator.start();
  assert.notEqual(newStart, oldStart);
  assert.equal((await newStart).qqbot.phase, 'running');
  gate.resolve(running);
  await oldStart;
  assert.deepEqual(fish, ['start', 'pause']);
  assert.deepEqual(qq, ['start']);
  assert.equal(coordinator.snapshot().fish.phase, 'paused');
});

test('starting an added channel reuses an unchanged channel startup already in progress', async () => {
  const gate = deferred(), fish = [], qq = [];
  const coordinator = createCoordinator({
    fishAction: action => { fish.push(action); return gate.promise; }, qqbotAction: channel(qq),
  });
  const oldStart = coordinator.start();
  await turn();
  await coordinator.setSelection({ qqbot: true });
  const newStart = coordinator.start();
  await turn();
  assert.deepEqual(fish, ['start']);
  assert.deepEqual(qq, ['start']);
  gate.resolve(running);
  await Promise.all([oldStart, newStart]);
  assert.equal(coordinator.snapshot().fish.phase, 'running');
  assert.equal(coordinator.snapshot().qqbot.phase, 'running');
});

test('selection persistence failures preserve the prior selection and allow a retry', async () => {
  const fish = [], qq = [];
  let fail = true;
  const coordinator = createCoordinator({ fishAction: channel(fish), qqbotAction: channel(qq),
    saveSelection: () => { if (fail) throw Error('disk full'); },
  });
  await assert.rejects(coordinator.setSelection({ fish: false, qqbot: true }), /disk full/);
  assert.deepEqual(coordinator.snapshot().selection, { fish: true, qqbot: false });
  assert.deepEqual(fish, []);
  fail = false;
  await coordinator.setSelection({ fish: false, qqbot: true });
  await coordinator.start();
  assert.deepEqual(fish, ['pause']);
  assert.deepEqual(qq, ['start']);
});

test('concurrent partial selection changes serialize without dropping an earlier saved choice', async () => {
  const saves = [];
  const coordinator = createCoordinator({ fishAction: async () => paused, qqbotAction: async () => paused,
    saveSelection: async value => saves.push(value),
  });
  await Promise.all([coordinator.setSelection({ qqbot: true }), coordinator.setSelection({ fish: false })]);
  assert.deepEqual(saves, [{ fish: true, qqbot: true }, { fish: false, qqbot: true }]);
  assert.deepEqual(coordinator.snapshot().selection, { fish: false, qqbot: true });
});

test('restored selection does not automatically start a service and invalid input does not opt channels in', async () => {
  const fish = [], qq = [];
  const coordinator = createCoordinator({ getSelection: () => ({ fish: false, qqbot: true }),
    fishAction: channel(fish), qqbotAction: channel(qq),
  });
  assert.deepEqual(coordinator.snapshot().selection, { fish: false, qqbot: true });
  assert.deepEqual(fish, []);
  assert.deepEqual(qq, []);
  await assert.rejects(coordinator.setSelection({ fish: 'true' }), /Invalid/);
  assert.deepEqual(coordinator.snapshot().selection, { fish: false, qqbot: true });
});

test('channel binding and gateway connection remain distinct and snapshots cannot mutate selection', async () => {
  const coordinator = createCoordinator({ fishAction: async () => paused, qqbotAction: async () => paused });
  coordinator.updateChannel('qqbot', { enabled: true, phase: 'bound', reason: '凭据已绑定', bound: true, connected: false });
  const bound = coordinator.snapshot();
  assert.equal(bound.qqbot.phase, 'bound');
  assert.equal(bound.qqbot.connected, false);
  bound.qqbot.connected = true;
  bound.selection.qqbot = true;
  assert.equal(coordinator.snapshot().qqbot.connected, false);
  assert.equal(coordinator.snapshot().selection.qqbot, false);
});

test('notification failures do not break startup, cancellation, or error redaction', async () => {
  const coordinator = createCoordinator({ getSelection: both,
    fishAction: () => { throw Error('private-token=never-output'); }, qqbotAction: async () => paused,
    notify: () => { throw Error('window closed'); },
  });
  const result = await coordinator.start();
  assert.equal(result.fish.phase, 'error');
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  assert.equal(result.unified, false);
  assert.equal((await coordinator.pause()).unified, false);
});
