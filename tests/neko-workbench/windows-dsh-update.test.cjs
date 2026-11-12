'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDshUpdateStore, isNewer, parseFeed } = require('../../apps/neko-workbench/windows-dsh-update.cjs');

test('official feed supports the installer YAML format and rejects another download origin', () => {
  const url = 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.2-win-x64.exe';
  const hash = Buffer.alloc(64, 1).toString('base64');
  const body = ['version: 0.2.2-rc.2', 'path: >-', '  '+url, 'sha512: >-', '  '+hash].join('\r\n');
  assert.deepEqual(parseFeed(body), { version: '0.2.2-rc.2', url, sha512: hash, date: '' });
  assert.throws(() => parseFeed(body.replace('download.deepseek.com', 'example.com')));
  assert.throws(() => parseFeed(body.replace('rc.2-win', 'rc.1-win')));
  assert(isNewer('0.2.2-rc.10', '0.2.2-rc.2'));
  assert(isNewer('0.2.2', '0.2.2-rc.10'));
  assert(!isNewer('0.2.2-rc.1', '0.2.2'));
});

test('failed trial restores the last confirmed engine and never trusts an invalid directory', t => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const data = fs.mkdtempSync(path.join(tempRoot, 'neko-dsh-updater-test-'));
  t.after(() => { if (path.dirname(data) === tempRoot) fs.rmSync(data, { recursive: true, force: true }); });
  const store = createDshUpdateStore(data);
  fs.mkdirSync(store.root);
  fs.writeFileSync(path.join(store.root, 'active.json'), 'null');
  assert.deepEqual(store.read(), {});
  assert.equal(store.resources({ version: '0.2.2', directory: '../outside' }), null);
  store.activate('0.2.2-rc.2', 'engine-abc123', '0.2.2-rc.1');
  assert.equal(store.select('0.2.2-rc.1'), null, 'missing staged files never become active');
  store.confirm('0.2.2-rc.2');
  store.activate('0.2.2-rc.3', 'engine-abc124', '0.2.2-rc.2');
  assert.equal(store.rollback('0.2.2-rc.3'), true);
  assert.deepEqual(store.read(), { version: '0.2.2-rc.2', directory: 'engine-abc123', verified: true });
  assert.equal(store.rollback('0.2.2-rc.2'), false);
});
