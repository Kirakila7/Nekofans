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

test('flex layout keeps order, ratios and old configuration across save, restart and legacy updates', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-flex-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'layout.json');
  const legacy = { enabled: true, side: 'community', left: 'coding', right: 'bilibili', ratio: 0.4 };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = createPaneLayout(file); assert.deepEqual(store.get(), legacy, 'old files are not auto-rewritten');
  const flex = { enabled: true, rootAxis: 'x', rootRatio: 0.75, stackAxis: 'y', stackRatio: 0.5, slots: ['social', 'bilibili', 'coding'] };
  const saved = store.set({ ...legacy, flex });
  saved.flex.slots[0] = 'coding'; flex.slots[1] = 'social';
  assert.deepEqual(store.get().flex.slots, ['social', 'bilibili', 'coding'], 'callers cannot mutate stored layout');
  const reload = createPaneLayout(file); assert.deepEqual(reload.get(), store.get());
  assert.deepEqual(reload.set({ ...legacy, ratio: 0.6 }).flex, store.get().flex, 'older client saves preserve flex');
  const swapped = { ...reload.get().flex, rootAxis: 'y', stackAxis: 'x', rootRatio: 0.3, stackRatio: 0.7, slots: ['coding', 'social', 'bilibili'] };
  reload.set({ ...reload.get(), flex: swapped });
  assert.deepEqual(createPaneLayout(file).get().flex, swapped, 'vertical and horizontal layouts persist');
  reload.set({ ...reload.get(), flex: { ...swapped, enabled: false } });
  assert.equal(createPaneLayout(file).get().flex.enabled, false);
  assert.deepEqual(createPaneLayout(file).get().flex.slots, swapped.slots, 'disabling does not discard choices');
});

test('flex layout rejects malformed shapes and preserves the last saved state', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-flex-invalid-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'layout.json'), store = createPaneLayout(file);
  const flex = { enabled: true, rootAxis: 'x', rootRatio: 0.75, stackAxis: 'y', stackRatio: 0.5, slots: ['social', 'bilibili', 'coding'] };
  const good = store.set({ ...store.get(), flex }); const onDisk = fs.readFileSync(file, 'utf8');
  for (const bad of [null, {}, { ...flex, extra: true }, { ...flex, enabled: 'true' }, { ...flex, rootAxis: 'z' },
    { ...flex, rootRatio: 0.1 }, { ...flex, stackRatio: Infinity }, { ...flex, slots: ['coding', 'coding', 'social'] },
    { ...flex, slots: ['social', 'bilibili', 'other'] }, { ...flex, slots: ['social', 'coding'] }]) {
    assert.throws(() => store.set({ ...good, flex: bad }), /自由布局设置无效/);
  }
  assert.deepEqual(store.get(), good); assert.equal(fs.readFileSync(file, 'utf8'), onDisk, 'invalid input never reaches disk');
});

test('failed atomic layout save keeps the previous memory and disk state', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-flex-save-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'layout.json'), store = createPaneLayout(file);
  const flex = { enabled: true, rootAxis: 'x', rootRatio: 0.75, stackAxis: 'y', stackRatio: 0.5, slots: ['social', 'bilibili', 'coding'] };
  const good = store.set({ ...store.get(), flex }), onDisk = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { const error = Error('no space'); error.code = 'ENOSPC'; throw error; };
    assert.throws(() => store.set({ ...good, flex: { ...flex, rootRatio: 0.4 } }), { code: 'ENOSPC' });
  } finally { fs.renameSync = rename; }
  assert.deepEqual(store.get(), good);
  assert.equal(fs.readFileSync(file, 'utf8'), onDisk);
  assert.deepEqual(fs.readdirSync(dir), ['layout.json'], 'temporary file is cleaned up');
});
