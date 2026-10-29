'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createPaneLayout } = require('../../apps/neko-workbench/pane-layout.cjs');
test('layout persists three independent regions and split width without touching engine settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-pane-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'layout.json'), store = createPaneLayout(file);
  assert.deepEqual(store.get(), { enabled: false, side: 'workspace', left: 'coding', right: null, ratio: 0.5 });
  const next = { enabled: true, side: 'workspace', left: 'community', right: 'bilibili', ratio: 0.4 };
  assert.deepEqual(store.set(next), next); assert.deepEqual(createPaneLayout(file).get(), next);
  assert.throws(() => store.set({ ...next, side: 'bilibili' }), /每个内容只能放在一个区域/);
  assert.throws(() => store.set({ ...next, left: 'coding', right: 'coding' }), /每个内容只能放在一个区域/);
  assert.throws(() => store.set({ ...next, ratio: 100 }), /无效/);
  assert.deepEqual(store.get(), next);
});
