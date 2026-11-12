'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startRoleConnector, externalRoleRequest } =
  require('../../apps/neko-workbench/vendor/dsh-bili-whale/lib/role-connector.cjs');

test('external DSH reconnects through a new port and token while preserving the original role', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-external-role-'));
  const descriptor = path.join(directory, 'nekofans-role-connector.json');
  const role = { id: 'original-role', name: '原角色', exists: true, running: true };
  const memory = '蓝色灯塔';
  let close;
  const action = async (method, payload) => {
    if (method === 'discover') return role;
    if (payload.id !== role.id) throw Error('角色未匹配');
    assert.equal(payload.text, '还记得什么？');
    return { text: memory };
  };
  try {
    close = await startRoleConnector({ directory, action });
    const first = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    const url = 'http://127.0.0.1:' + first.port + '/role';
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + first.token, origin: 'http://localhost' } })).status, 403);
    const binding = JSON.parse(JSON.stringify({ directory, id: (await externalRoleRequest(directory, 'discover')).id }));
    assert.deepEqual(await externalRoleRequest(directory, 'send', { id: binding.id, text: '还记得什么？' }), { text: memory });
    close();
    await assert.rejects(externalRoleRequest(directory, 'discover'), /启动原 DSH/);
    close = await startRoleConnector({ directory, action });
    const second = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    assert.notEqual(first.token, second.token);
    assert.equal((await externalRoleRequest(binding.directory, 'discover')).id, binding.id);
    await assert.rejects(externalRoleRequest(binding.directory, 'send', { id: 'another-role', text: '还记得什么？' }), /未匹配/);
    assert.deepEqual(await externalRoleRequest(binding.directory, 'send', { id: binding.id, text: '还记得什么？' }), { text: memory });
  } finally {
    close?.();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
