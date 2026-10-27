'use strict';

// Offline reader fixtures only. No installed app, real account or credential IO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'account-habitat-source.js'), 'utf8'), sandbox);
const { createNekoAccountBalanceReader: createReader, formatNekoUsdWallet: format, formatNekoWalletBalance: formatWallet, nekoAccountBalanceLabel: balanceLabel } = sandbox;
const ok = value => ({ ok: true, value });
const signedIn = () => ok({ status: 'credential-stored', attempt: null, links: {} });
const ready = (amount, currency = 'USD') => ok({ status: 'ready', value: [{ currency, balance: amount }], bonusWallets: [] });
function context(api, locale = 'zh-CN') {
  const calls = [];
  return {
    calls,
    locale: { getSnapshot: () => ({ active: locale }) },
    remote: {
      account: new Proxy(api, { get(target, key) {
        assert.ok(['getState', 'getBalance'].includes(key), 'read-only habitat must not access auth or credentials');
        return (...args) => { calls.push({ key, args }); return target[key](...args); };
      } }),
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

(async () => {
  for (const [input, expected] of [
    ['0', '$0.00'], ['0.000', '$0.00'], ['0.001', '<$0.01'], ['-0.001', '-$0.01'],
    ['12.349', '$12.34'], ['-12.345', '-$12.35'], ['123456789012345678901.12', '$123,456,789,012,345,678,901.12'],
    ['0.01', '$0.01'], ['+0001.2', '$1.20'],
  ]) assert.equal(format(input), expected, input);
  for (const input of [null, 0, NaN, 'NaN', 'Infinity', '1e20', '<b>1</b>', '', '1,000']) assert.equal(format(input), null);
  assert.equal(formatWallet('0', 'CNY'), '¥0.00');
  assert.equal(formatWallet('0.001', 'CNY'), '<¥0.01');
  assert.equal(formatWallet('-0.001', 'CNY'), '-¥0.01');
  assert.equal(formatWallet('12.349', 'CNY'), '¥12.34');
  assert.equal(formatWallet('1', 'EUR'), null);

  {
    const ctx = context({ getState: signedIn, getBalance: () => ready('0') });
    const reader = createReader(ctx, { version: '0.2.1-rc.3' });
    await reader.refresh();
    assert.equal(reader.getSnapshot().status, 'ready');
    assert.equal(reader.getSnapshot().amount, '$0.00', 'only a reported genuine zero may render as zero');
    assert.equal(reader.getSnapshot().currency, 'USD');
    assert.equal(balanceLabel(reader.getSnapshot()), 'USD 余额 $0.00');
    assert.equal(reader.getSnapshot().source, 'DeepSeek 官方充值钱包');
    const balanceCall = ctx.calls.find(call => call.key === 'getBalance');
    assert.equal(balanceCall.args[0].locale, 'zh-CN');
    assert.equal(balanceCall.args[0].version, '0.2.1-rc.3');
    assert.equal(typeof balanceCall.args[0].timezoneOffsetSeconds, 'number');
    assert.ok(reader.getSnapshot().fetchedAt);
    reader.dispose();
  }
  for (const [amount, expected] of [['0', '¥0.00'], ['0.001', '<¥0.01']]) {
    const reader = createReader(context({ getState: signedIn, getBalance: () => ready(amount, 'CNY') }));
    await reader.refresh();
    assert.equal(reader.getSnapshot().currency, 'CNY');
    assert.equal(reader.getSnapshot().amount, expected, 'real CNY zero and small balances retain their currency');
    assert.equal(balanceLabel(reader.getSnapshot()), 'CNY 余额 ' + expected);
    reader.dispose();
  }
  for (const [locale, currency, expected] of [['zh-CN', 'CNY', '¥8.80'], ['zh_TW', 'CNY', '¥8.80'], ['en-US', 'USD', '$2.20']]) {
    const reader = createReader(context({ getState: signedIn, getBalance: () => ok({ status: 'ready', value: [
      { currency: 'USD', balance: '2.20' }, { currency: 'CNY', balance: '8.80' },
    ], bonusWallets: [{ currency: 'CNY', balance: '999' }] }) }, locale));
    await reader.refresh();
    assert.equal(reader.getSnapshot().currency, currency);
    assert.equal(reader.getSnapshot().amount, expected, 'select one original wallet, never sum or include bonus money');
    assert.equal(balanceLabel(reader.getSnapshot()), currency + ' 余额 ' + expected);
    reader.dispose();
  }
  {
    const ctx = context({ getState: () => ok({ status: 'signed-out' }), getBalance: () => { throw new Error('must not read while signed out'); } });
    const reader = createReader(ctx);
    await reader.refresh();
    assert.equal(reader.getSnapshot().signedIn, false);
    assert.equal(reader.getSnapshot().amount, null);
    assert.equal(ctx.calls.length, 1);
    reader.dispose();
  }
  for (const outcome of [
    null, { status: 'failed' }, { status: 'ready', value: [] },
    { status: 'ready', value: [{ currency: 'EUR', balance: '12.00' }] },
    { status: 'ready', value: [{ currency: 'USD', balance: 'bad' }] },
    { status: 'ready', value: [{ currency: 'USD', balance: '1' }, { currency: 'USD', balance: '2' }] },
    { status: 'ready', value: [{ currency: 'CNY', balance: '1' }, { currency: 'CNY', balance: '2' }, { currency: 'USD', balance: '3' }] },
  ]) {
    const reader = createReader(context({ getState: signedIn, getBalance: () => ok(outcome) }));
    await reader.refresh();
    assert.equal(reader.getSnapshot().amount, null, 'unavailable/ambiguous preferred balance must not become zero, a sum, or another currency');
    assert.equal(reader.getSnapshot().currency, null);
    assert.equal(balanceLabel(reader.getSnapshot()), '暂不可读取');
    assert.equal(reader.getSnapshot().status, 'unavailable');
    reader.dispose();
  }
  {
    const oldBalance = deferred();
    let reads = 0;
    const reader = createReader(context({ getState: signedIn, getBalance: () => ++reads === 1 ? oldBalance.promise : ready('4.25') }));
    const oldRequest = reader.refresh();
    await Promise.resolve();
    reader.invalidate(null);
    assert.equal(reader.getSnapshot().amount, null, 'account invalidation clears cached balance synchronously');
    await reader.refresh();
    assert.equal(reader.getSnapshot().amount, '$4.25');
    oldBalance.resolve(ready('99999'));
    await oldRequest;
    assert.equal(reader.getSnapshot().amount, '$4.25', 'an old account response cannot overwrite the new result');
    reader.dispose();
  }
  {
    let states = 0;
    const reader = createReader(context({ getState: () => ++states === 1 ? signedIn() : ok({ status: 'signed-out' }), getBalance: () => ready('22.00') }));
    await reader.refresh();
    assert.equal(reader.getSnapshot().amount, null, 'sign-out between balance fetch and commit discards the wallet');
    assert.equal(reader.getSnapshot().signedIn, false);
    reader.dispose();
  }
  {
    const balance = deferred();
    const ctx = context({ getState: signedIn, getBalance: () => balance.promise });
    const reader = createReader(ctx);
    const first = reader.refresh();
    assert.equal(first, reader.refresh(), 'concurrent renders coalesce one safe read');
    await Promise.resolve();
    reader.dispose();
    balance.resolve(ready('10'));
    await first;
    assert.equal(reader.getSnapshot().amount, null, 'disposed UI never accepts a late response');
  }
  {
    const reader = createReader(context({ getState: signedIn, getBalance: () => ({ ok: false, error: { message: 'private diagnostic' } }) }));
    await reader.refresh();
    assert.equal(reader.getSnapshot().status, 'unavailable');
    assert.equal(reader.getSnapshot().amount, null);
    reader.dispose();
  }
  console.log('PASS account habitat: exact CNY/USD display, locale preference without summing, honest unavailable states, read-only API, invalidation races, sign-out, disposal, request coalescing');
})().catch(error => { console.error(error); process.exitCode = 1; });
