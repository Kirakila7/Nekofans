'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('workbench screen bridge permits only hide and preserves other named bridges', async () => {
  const exposed = {}, calls = [];
  const ipcRenderer = { invoke: async (...args) => { calls.push(args); return { ok: true }; }, on() {}, removeListener() {} };
  const source = fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/workbench-preload.cjs'), 'utf8');
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer }) });
  const bridge = exposed.nekoWorkbench;
  await bridge.screenShare('hide');
  assert.deepEqual(calls, [['workbench:screen-share', 'hide']]);
  for (const operation of ['start', 'frame', 'settings', 'sources']) await assert.rejects(bridge.screenShare(operation), /未知屏幕操作/);
  assert.equal(calls.length, 1);
  assert.equal(typeof bridge.community, 'function');
  assert.equal(typeof bridge.codex.start, 'function');
});
