'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrivatePairing } = require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/private-pairing.cjs');
function fixture() {
  let clock = 1000;
  const config = { appId: 'test-bot', appSecret: 'never-return', access: { c2cMode: 'allowlist', c2cAllow: ['old-private-user'], groupMode: 'disabled', groupAllow: [] } };
  return { config, advance() { clock += 300001; }, pairing: createPrivatePairing({ readConfig: () => config, now: () => clock }) };
}
test('private pairing consumes one exact challenge and replaces only the chosen private allowlist', () => {
  const { pairing, config } = fixture();
  const { challenge } = pairing.begin();
  assert.match(challenge, /^[a-f0-9]{32}$/);
  for (const message of [
    { kind: 'group', senderId: 'new-private-user', content: challenge },
    { kind: 'c2c', senderId: 'new-private-user', content: 'ordinary private conversation' },
    { kind: 'c2c', senderId: '*', content: challenge },
  ]) assert.equal(pairing.capture(message), false);
  assert.equal(pairing.capture({ kind: 'c2c', senderId: 'new-private-user', content: challenge }), true);
  assert.equal(pairing.capture({ kind: 'c2c', senderId: 'new-private-user', content: 'QQ配对 ' + challenge }), true);
  assert.equal(pairing.capture({ kind: 'c2c', senderId: 'different-user', content: challenge }), false);
  assert.deepEqual(pairing.status(), { active: true, matched: true, expiresAt: 301000 });
  const result = pairing.confirm(access => { config.access = access; return true; });
  assert.deepEqual(config.access, { c2cMode: 'allowlist', c2cAllow: ['new-private-user'], groupMode: 'disabled', groupAllow: [] });
  assert.equal(config.appSecret, 'never-return');
  assert(!JSON.stringify(result).includes('private-user'));
  assert.equal(pairing.status().active, false);
  assert.throws(() => pairing.confirm(() => true), { code: 'PAIRING_NOT_MATCHED' });
});
test('expiry, cancellation and changed bot or scope prevent private pairing writes', () => {
  for (const change of ['expire', 'cancel', 'bot', 'scope']) {
    const { pairing, config, advance } = fixture();
    const { challenge } = pairing.begin();
    pairing.capture({ kind: 'c2c', senderId: 'new-private-user', content: challenge });
    if (change === 'expire') advance();
    if (change === 'cancel') pairing.cancel();
    if (change === 'bot') config.appId = 'another-bot';
    if (change === 'scope') config.access.groupMode = 'open';
    let writes = 0;
    assert.throws(() => pairing.confirm(() => { writes++; return true; }));
    assert.equal(writes, 0);
  }
});
test('pairing cannot start from an open scope and does not claim a failed save succeeded', () => {
  const { pairing, config } = fixture();
  config.access.c2cMode = 'open';
  assert.throws(() => pairing.begin(), { code: 'PAIRING_SCOPE_CHANGED' });
  config.access.c2cMode = 'allowlist';
  const { challenge } = pairing.begin();
  pairing.capture({ kind: 'c2c', senderId: 'new-private-user', content: challenge });
  assert.throws(() => pairing.confirm(() => false), { code: 'PAIRING_SAVE_FAILED' });
  assert.deepEqual(config.access.c2cAllow, ['old-private-user']);
});
