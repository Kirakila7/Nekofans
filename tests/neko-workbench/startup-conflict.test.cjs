'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sharedProfileStatus, waitForSharedProfile, claimWorkbenchInstance, queueEarlyInstanceNotifications } = require('../../apps/neko-workbench/startup-conflict.cjs');
const profile = '/users/test/.dsh/profiles/desktop';

test('shared profile detection fails closed and ignores unrelated hosts', () => {
  assert.equal(sharedProfileStatus(() => '100 node dsh-desktop-host/lib/index.js ' + profile, profile), 'busy');
  assert.equal(sharedProfileStatus(() => '100 node dsh-desktop-host/lib/cli.js --profile desktop', profile), 'busy');
  assert.equal(sharedProfileStatus(() => '100 node /tmp/dsh-shared-desktop-host.cjs', profile), 'busy');
  assert.equal(sharedProfileStatus(() => '100 node dsh-desktop-host/lib/index.js /other/profile', profile), 'free');
  assert.equal(sharedProfileStatus(() => { throw Error('ps unavailable'); }, profile), 'unknown');
});

test('retry checks again and opens only after shared host exits', async () => {
  let occupied = true; const dialogs = [];
  const ok = await waitForSharedProfile({ sharedProfile: profile,
    readProcesses: () => occupied ? '10 dsh-desktop-host/lib/index.js ' + profile : '',
    showMessageBox: async options => { dialogs.push(options); occupied = false; return { response: 0 }; },
  });
  assert.equal(ok, true); assert.equal(dialogs.length, 1);
  assert.deepEqual(dialogs[0].buttons, ['重试', '退出']);
  assert.match(dialogs[0].detail, /不会自动结束任何任务/);
});

test('closing the dialog or cancelling an unknown check never starts the host', async () => {
  const shown=[];
  const ok = await waitForSharedProfile({ sharedProfile: profile,
    readProcesses: () => { throw Error('not available'); },
    showMessageBox: async options => { shown.push(options); return { response: 1 }; },
  });
  assert.equal(ok, false); assert.match(shown[0].message, /无法检查/);
});

test('instance lock is checked against the daily profile before host startup', () => {
  const calls=[];
  const app={setPath:(key,value)=>calls.push([key,value]),requestSingleInstanceLock:()=>{calls.push(['lock']);return false;}};
  assert.equal(claimWorkbenchInstance(app,'/test/daily/electron'),false);
  assert.deepEqual(calls,[['userData','/test/daily/electron'],['lock']]);
});

test('early repeat launches are forwarded once after main is ready, or discarded on quit', async () => {
  const {EventEmitter} = require('node:events'); const app=new EventEmitter();
  let focused=0, delivered=0; app.isReady=()=>true; app.whenReady=()=>Promise.resolve(); app.focus=()=>focused++;
  const queue=queueEarlyInstanceNotifications(app);
  app.emit('second-instance'); app.emit('second-instance'); assert.equal(focused,2);
  app.on('second-instance',()=>delivered++); queue.forward(); await Promise.resolve();
  assert.equal(delivered,1); app.emit('second-instance'); assert.equal(delivered,2);
  app.removeAllListeners('second-instance'); const cancelled=queueEarlyInstanceNotifications(app);
  app.emit('second-instance'); cancelled.discard(); app.on('second-instance',()=>delivered++);
  assert.equal(delivered,2);
});
