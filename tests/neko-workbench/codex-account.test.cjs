'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { resolveCodex, normalizeRateLimits, accountSummary, queryCodex, createCodexAccountService } = require('../../apps/neko-workbench/codex-account.cjs');

test('Codex quotas retain all native buckets, actual window durations and unknown values', () => {
  const result = normalizeRateLimits({ ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 99 } },
    rateLimitsByLimitId: { codex: { limitName: 'Codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } }, other: { primary: { usedPercent: null }, secondary: null } },
  });
  assert.equal(result.ordinaryUsageAllowed, false);
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[0].windows[0].remainingPercent, 75);
  assert.equal(result.buckets[0].windows[1].remainingPercent, 100);
  assert.equal(result.buckets[0].windows[1].resetsAt, null);
  assert.equal(result.buckets[1].windows.length, 0, 'missing usage never becomes a zero');
  assert.deepEqual(normalizeRateLimits(null), { buckets: [], ordinaryUsageAllowed: null });
  assert.equal(normalizeRateLimits({ rateLimits: { primary: { usedPercent: 130 } } }).buckets[0].windows[0].remainingPercent, 0);
});

test('native account summaries exclude email, identifiers and credentials', () => {
  const summary = accountSummary({ account: { type: 'chatgpt', email: 'private@example.test', id: 'secret-account', token: 'secret-token', planType: 'plus' } });
  assert.deepEqual(summary, { status: 'signed-in', authType: 'chatgpt', planType: 'plus' });
  assert.equal(accountSummary({ account: null, requiresOpenaiAuth: true }).status, 'signed-out');
  assert.equal(accountSummary({ account: null, requiresOpenaiAuth: false }).status, 'external');
  assert.equal(resolveCodex({ env: { NEKO_WORKBENCH_CODEX_CLI: './codex' }, exists: () => true }), null);
});

test('status and quota cache coalesce calls, upgrade status-only reads, and fail without diagnostics', async () => {
  let calls = 0, clock = 1000, done;
  const service = createCodexAccountService({ resolveExecutable: () => '/native/codex', now: () => clock,
    query: async (_cli, { includeQuota }) => { calls++; if (calls === 1) await new Promise(resolve => { done = resolve; }); return { status: 'signed-in', quota: { status: includeQuota ? 'ready' : 'idle', buckets: [] } }; },
  });
  const status = service.read(), quota = service.read({ includeQuota: true }); done();
  await Promise.all([status, quota]); assert.equal(calls, 2);
  await service.read({ includeQuota: true }); assert.equal(calls, 2);
  clock += 31000; await service.read(); assert.equal(calls, 3);
  await service.dispose(); assert.equal((await service.read()).status, 'unavailable');
  const broken = createCodexAccountService({ resolveExecutable: () => '/native/codex', query: async () => { throw Error('SECRET upstream token'); } });
  assert(!JSON.stringify(await broken.read()).includes('SECRET')); await broken.dispose();
  const missing = createCodexAccountService({ resolveExecutable: () => null });
  assert.equal((await missing.read()).status, 'not-installed'); await missing.dispose();
});

function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-codex-account-'));
  const entry = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(entry, `const readline=require('node:readline');let accountReads=0;
    const input=readline.createInterface({input:process.stdin});
    input.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
      let result={};
      if(m.method==='initialize')result={serverInfo:{version:'fixture'}};
      else if(m.method==='account/read'){accountReads++;result={account:${JSON.stringify(mode)}==='changed'&&accountReads>1?null:{type:${JSON.stringify(mode === 'api' ? 'apiKey' : 'chatgpt')},email:'private@example.test',planType:'plus'},requiresOpenaiAuth:true};}
      else if(m.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:40,windowDurationMins:300,resetsAt:1800000000}}};
      else return process.stdout.write(JSON.stringify({id:m.id,error:{message:'UNEXPECTED MUTATION'}})+'\\n');
      process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
    });input.on('close',()=>process.exit(0));`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const methods = [];
  return { methods, options: { timeoutMs: 1000, spawnProcess: (cli, args, options) => {
    assert.equal(cli, '/native/codex'); assert.deepEqual(args, ['app-server', '--listen', 'stdio://']); assert.equal(options.shell, false);
    const child = spawn(process.execPath, [entry], options), write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => { methods.push(JSON.parse(chunk).method); return write(chunk, ...rest); };
    return child;
  } } };
}

test('real stdio lifecycle makes only read-only account calls and discards old-account limits', async t => {
  const normal = fixture(t, 'normal');
  const result = await queryCodex('/native/codex', { ...normal.options, includeQuota: true });
  assert.equal(result.quota.buckets[0].windows[0].remainingPercent, 60);
  assert.deepEqual(normal.methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read']);
  assert(!JSON.stringify(result).includes('private@example.test'));
  const changed = fixture(t, 'changed');
  const after = await queryCodex('/native/codex', { ...changed.options, includeQuota: true });
  assert.equal(after.status, 'signed-out'); assert.equal(after.quota.buckets.length, 0);
  const api = fixture(t, 'api');
  assert.equal((await queryCodex('/native/codex', { ...api.options, includeQuota: true })).quota.status, 'not-applicable');
  assert(!api.methods.includes('account/rateLimits/read'));
});
