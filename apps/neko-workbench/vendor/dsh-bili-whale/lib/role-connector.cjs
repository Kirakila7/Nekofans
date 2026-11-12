'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const filename = 'nekofans-role-connector.json';
const tokenPattern = /^[a-f0-9]{64}$/;

async function startRoleConnector({ directory, action }) {
  const token = randomBytes(32).toString('hex');
  const file = path.join(directory, filename);
  const server = createServer(async (req, res) => {
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin ||
        req.headers.host !== '127.0.0.1:' + server.address()?.port ||
        !supplied || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      send(403, { error: 'DSH 角色连接未授权。' });
      return;
    }
    try {
      if (req.method === 'GET' && req.url === '/role') {
        send(200, await action('discover'));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/chat' || req.headers['content-type'] !== 'application/json') {
        send(404, { error: '未知角色操作。' });
        return;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64000) { send(413, { error: '消息太长。' }); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      send(200, await action('send', { id: payload?.id, text: payload?.text }));
    } catch (error) {
      send(400, { error: String(error.message).slice(0, 200) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const temporary = file + '.' + randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, port, token }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    server.close();
    throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
  return () => {
    server.close();
    server.closeAllConnections();
    // An older DSH process must not remove a newer process's descriptor.
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file);
    } catch {}
  };
}

async function externalRoleRequest(directory, action, payload, fetchImpl = fetch) {
  const file = path.join(directory, filename);
  let config;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) throw Error();
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 1024 ||
        config.port > 65535 || !tokenPattern.test(config.token || '')) throw Error();
  } catch { throw Error('请先启动原 DSH 和支持接回角色的养鱼插件。'); }
  const sending = action === 'send';
  let response;
  try {
    response = await fetchImpl('http://127.0.0.1:' + config.port + (sending ? '/chat' : '/role'), {
      redirect: 'error', signal: AbortSignal.timeout(sending ? 75000 : 3500),
      headers: { authorization: 'Bearer ' + config.token, ...(sending ? { 'content-type': 'application/json' } : {}) },
      ...(sending ? { method: 'POST', body: JSON.stringify(payload) } : {}),
    });
  } catch { throw Error('原 DSH 未连接，请检查它是否仍在运行。'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw Error(result?.error || '原 DSH 角色暂不可用。');
  return result;
}

module.exports = { startRoleConnector, externalRoleRequest };
