'use strict';
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { promisify } = require('node:util');
const receiptsPath = require.resolve('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/companion-receipts.cjs');
const { claimQQCompanionReceipt } = require(receiptsPath);
const {createQQCompanionLink} = require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/companion-link.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-qq-receipts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receipts = path.join(directory, 'companion-receipts.sqlite');
  const config = {appId:'bot', appSecret:'fixture-secret', access:{
    c2cMode:'allowlist', c2cAllow:['owner-openid'], groupMode:'disabled', groupAllow:[]
  }};
  let consent = null, active = true;
  const events = [];
  const open = (claimReceipt = (scope, id) => claimQQCompanionReceipt(receipts, scope, id)) => createQQCompanionLink({
    claimReceipt,
    readConfig: () => config, readConsent: () => consent, saveConsent: key => {consent=key;},
    notify: id => events.push(id)
  });
  const owner = {kind:'c2c',senderId:'owner-openid',messageId:'msg-1',content:'接着聊'};
  return {config, events, open, owner, receipts, isActive: () => active, stop: () => {active=false;}};
}

test('only opted-in paired QQ text gets one private request; notifications contain no content', async t => {
  const f = fixture(t);
  let link = f.open();
  assert.equal(link.request(f.owner,f.isActive),null);
  link.configure(true);
  link = f.open();
  assert.equal(link.enabled(),true);
  assert.equal(link.request({...f.owner,kind:'group'},f.isActive),null);
  assert.equal(link.request({...f.owner,senderId:'another-openid'},f.isActive),null);
  const reply = link.request(f.owner,f.isActive);
  assert.equal(f.events.length,1);
  assert.match(f.events[0],/^[a-f0-9-]{36}$/);
  assert.equal(link.take('unrelated'),null);
  assert.deepEqual(link.take(f.events[0]),{text:'接着聊'});
  assert.equal(link.take(f.events[0]),null);
  assert.equal(await link.request(f.owner,f.isActive),null);
  assert.equal(link.reply(f.events[0],'上回我们聊到小窝'),true);
  assert.equal(await reply,'上回我们聊到小窝');
});

test('scope change, pause and disconnect block pending replies and cannot authorize another account', async t => {
  const f = fixture(t), link = f.open();
  link.configure(true);
  const reply = link.request(f.owner,f.isActive);
  link.take(f.events[0]);
  f.config.access.c2cAllow = ['another-openid'];
  assert.equal(link.enabled(),false);
  assert.equal(link.reply(f.events[0],'旧会话的内容'),false);
  assert.equal(await reply,null);
  assert.equal(link.request({...f.owner,senderId:'another-openid'},f.isActive),null);
  f.config.access.c2cAllow = ['owner-openid'];
  const paused = link.request({...f.owner,messageId:'msg-2'},f.isActive);
  f.stop();
  assert.equal(link.take(f.events[1]),null);
  link.cancel();
  assert.equal(await paused,null);
  link.configure(false);
  assert.equal(f.open().enabled(),false);
});

test('a delivery claimed before model dispatch survives restart and secret rotation', async t => {
  const f = fixture(t);
  let link = f.open();
  link.configure(true);
  link = f.open((scope, id) => {
    assert.equal(f.events.length, 0, 'store is called before model notification');
    return claimQQCompanionReceipt(f.receipts, scope, id);
  });
  const abandoned = link.request(f.owner, f.isActive);
  link.cancel();
  assert.equal(await abandoned, null, 'an interrupted turn may be lost');
  assert.equal(f.events.length, 1);

  const restarted = f.open();
  assert.equal(await restarted.request(f.owner, f.isActive), null);
  f.config.appSecret = 'rotated-fixture-secret';
  restarted.configure(true);
  assert.equal(await restarted.request(f.owner, f.isActive), null);
  assert.equal(f.events.length, 1, 'original delivery never starts another model turn');

  const retry = restarted.request({ ...f.owner, messageId: 'manual-retry' }, f.isActive);
  assert.equal(f.events.length, 2);
  assert.deepEqual(restarted.take(f.events[1]), { text: '接着聊' });
  assert.equal(restarted.reply(f.events[1], '接着聊'), true);
  assert.equal(await retry, '接着聊');
});

test('two processes sharing the QQ profile can claim a delivery only once', async t => {
  const f = fixture(t);
  const program = `
    const { claimQQCompanionReceipt } = require(process.argv[1]);
    const claimed = claimQQCompanionReceipt(process.argv[2], ['bot', 'owner-openid'], 'msg-1');
    process.stdout.write(String(claimed));
  `;
  const run = () => promisify(execFile)(process.execPath, ['-e', program, receiptsPath, f.receipts]);
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(result => result.stdout).sort(), ['false', 'true']);

  const restarted = f.open();
  restarted.configure(true);
  assert.equal(await restarted.request(f.owner, f.isActive), null);
  assert.equal(f.events.length, 0);

  assert.equal(claimQQCompanionReceipt(f.receipts, ['another-bot', 'owner-openid'], 'msg-1'), true);
  assert.equal(claimQQCompanionReceipt(f.receipts, ['bot', 'other-openid'], 'msg-1'), true);
  const db = new DatabaseSync(f.receipts);
  try {
    const keys = db.prepare('SELECT delivery_key FROM receipts').all();
    assert.equal(keys.length, 3);
    for (const row of keys) assert.match(row.delivery_key, /^[0-9a-f]{64}$/);
  } finally { db.close(); }
});

test('a corrupt receipt store prevents model dispatch and keeps the message in the private path', async t => {
  const f = fixture(t);
  const link = f.open();
  link.configure(true);
  fs.writeFileSync(f.receipts, 'not a sqlite database');
  assert.match(await link.request(f.owner, f.isActive), /无法保存 QQ 消息/);
  assert.equal(f.events.length, 0);
});

test('private delivery receipts retain only the newest 4096 entries', t => {
  const f = fixture(t);
  assert.equal(claimQQCompanionReceipt(f.receipts, ['bot', 'owner-openid'], 'oldest'), true);
  const db = new DatabaseSync(f.receipts);
  try {
    db.exec('BEGIN IMMEDIATE');
    const seed = db.prepare('INSERT INTO receipts (delivery_key) VALUES (?)');
    for (let index = 1; index < 4096; index++) {
      seed.run(index.toString(16).padStart(64, '0'));
    }
    db.exec('COMMIT');
    const recent = claimQQCompanionReceipt(f.receipts, ['bot', 'owner-openid'], 'latest');
    assert.equal(recent, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count, 4096);
    assert.equal(db.prepare('SELECT 1 FROM receipts WHERE sequence = 1').get(), undefined);
    assert.equal(claimQQCompanionReceipt(f.receipts, ['bot', 'owner-openid'], 'latest'), false);
  } finally { db.close(); }
});
