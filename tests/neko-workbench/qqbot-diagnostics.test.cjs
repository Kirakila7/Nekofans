'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { qqDiagnostics } = require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/diagnostics.cjs');

test('QQ diagnostics report stages without exposing identities or conversation', () => {
  const buffer = [
    { name: 'loader:active', type: 'info', args: ['Processing an incoming QQ message'] },
    { name: 'im-qqbot', type: 'info', args: ['getOrCreate: key=secret-peer route=private-route'] },
    { name: 'im-qqbot', type: 'info', args: ['resumed session: key=secret-peer'] },
    { name: 'im-qqbot', type: 'info', args: ['→ followup sent: key=c2c:secret-peer'] },
    { name: 'im-qqbot', type: 'error', args: ['ERROR creating session: QQ 会话工具防护不可用 private-message secret-token'] },
    { name: 'unrelated', type: 'error', args: ['private-message'] },
  ];
  assert.deepEqual(qqDiagnostics(buffer), { accepted: 1, sessionRequested: 1, sessionReady: 1, modelQueued: 1, errors: [{ kind: 'tool-guard-unavailable' }] });
});

test('QQ diagnostics retain only bounded error categories and standard codes', () => {
  const buffer = Array.from({ length: 12 }, () => ({ name: 'im-qqbot', type: 'error', args: [new Error('ERROR creating session: this.agents.resume is not a function HTTP 403 secret-token')] }));
  assert.deepEqual(qqDiagnostics(buffer).errors, [{ kind: 'session-create-failed', missingMethod: 'this.agents.resume is not a function', httpStatus: 403 }]);
  assert.deepEqual(qqDiagnostics(null), { accepted: 0, sessionRequested: 0, sessionReady: 0, modelQueued: 0, errors: [] });
  assert.deepEqual(qqDiagnostics([{ name: 'im-qqbot', type: 'error', args: ['privateMessage is not a function'] }]).errors, [{ kind: 'runtime-error' }]);
});
