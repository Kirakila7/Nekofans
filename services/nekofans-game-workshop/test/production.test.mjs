import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp, productionConfig } from '../server/index.mjs';

test('production requires separate HTTPS origins and a readable community signing public key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nekofans-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'community.pem');
  const { publicKey } = generateKeyPairSync('ed25519');
  await writeFile(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  const env = {
    PUBLIC_ORIGIN: 'https://workshop.nekofans.games',
    NEKO_GAME_COMMUNITY_ORIGIN: 'https://community.project-neko.cn',
    NEKO_GAME_COMMUNITY_PUBLIC_KEY: keyFile,
    HOST: '127.0.0.1', PORT: '3088', DATA_DIR: '/var/lib/nekofans-games',
  };
  for (const [override, message] of [
    [{ PUBLISH_KEY: 'fixture' }, /发布凭证/],
    [{ ENABLE_DEMO: '1' }, /关闭演示/],
    [{ PUBLIC_ORIGIN: 'http://workshop.nekofans.games' }, /HTTPS/],
    [{ NEKO_GAME_COMMUNITY_ORIGIN: env.PUBLIC_ORIGIN }, /must differ/],
    [{ HOST: '0.0.0.0' }, /127\.0\.0\.1/],
    [{ DATA_DIR: '/tmp' }, /存档目录/],
    [{ NEKO_GAME_COMMUNITY_PUBLIC_KEY: join(directory, 'missing.pem') }, /ENOENT/],
  ]) {
    await assert.rejects(productionConfig({ ...env, ...override }, 'workshop.nekofans.games'), message);
  }
  await assert.rejects(productionConfig(env, 'play.nekofans.games'), /安装域名/);
  const options = await productionConfig(env, 'workshop.nekofans.games');
  const app = createApp({ ...options, directory });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.deepEqual(await (await fetch(`${origin}/api/config`)).json(), {
    publishEnabled: true, adminPublish: false, demo: false, communitySeats: true,
  });
  for (let i = 0; i < 120; i++) {
    const response = await fetch(`${origin}/api/games`, { headers: { 'X-Nekofans-Client-IP': '192.0.2.1' } });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const same = await fetch(`${origin}/api/games`, { headers: { 'X-Nekofans-Client-IP': '192.0.2.1' } });
  assert.equal(same.status, 429);
  const other = await fetch(`${origin}/api/games`, { headers: { 'X-Nekofans-Client-IP': '192.0.2.2' } });
  assert.equal(other.status, 200);
  await Promise.all([same.arrayBuffer(), other.arrayBuffer()]);
});
