// Offline check for dsh-skin-patch.cjs: builds the same patch array that the
// patched main.cjs writes and asserts its shape. Does not start DSH.
//   node integration/check-skin-patch.cjs [path/to/b0-skin/packages]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skinPatch, applySkinCookie, SKIN_IDS, COOKIE_NAME } = require('./dsh-skin-patch.cjs');

const packagesRoot = path.resolve(process.argv[2] || path.join(__dirname, 'b0-skin', 'packages'));

// 1) enabled: two loader entries with absolute lib/index.js paths + official brand off
const skin = skinPatch(packagesRoot, { env: {} });
assert.deepEqual(skin.rows, [{ id: 'ui-brand-official', disabled: true }]);
assert.equal(skin.skin, 'neko-mist', 'default skin');
assert.deepEqual(skin.insert.map((e) => e.id), ['neko-brand', 'neko-skin']);
for (const entry of skin.insert) {
  assert.ok(path.isAbsolute(entry.name), entry.name + ' must be absolute');
  assert.match(entry.name, /lib[\\/]index\.js$/);
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry.name), '..', 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
}

// 2) mirrors main.cjs: bridge stays first in the same insert row, feature rows untouched
const base = '/pet';
const patch = [
  { id: 'credentials', config: { path: '/home/.dsh/.credentials.yaml' } },
  { id: 'agent-default-model', config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  ...skin.rows,
  { insert: [{ id: 'pet-lab-bridge', name: path.join(base, 'bridge.cjs') }, ...skin.insert] },
];
const json = JSON.parse(JSON.stringify(patch));
assert.equal(json.at(-1).insert[0].id, 'pet-lab-bridge');
assert.equal(json.at(-1).insert.length, 3);
assert.equal(json[1].config.provider, 'deepseek-account', 'model/provider ids untouched');
const disabled = json.filter((r) => r.disabled).map((r) => r.id);
assert.deepEqual(disabled, ['ui-brand-official'], 'only the official brand plugin is disabled');

// 3) kill switch and missing-package fallback both yield the official look
assert.deepEqual(skinPatch(packagesRoot, { env: { PET_DSH_SKIN: 'off' } }), { rows: [], insert: [], skin: null });
assert.equal(skinPatch(packagesRoot, { env: { PET_DSH_SKIN: 'BigFish' } }).skin, 'bigfish');
assert.equal(skinPatch(packagesRoot, { env: { PET_DSH_SKIN: 'rainbow' } }).skin, 'neko-mist', 'unknown skin -> default');
const logs = [];
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-skin-'));
assert.deepEqual(skinPatch(empty, { env: {}, log: (m) => logs.push(m) }), { rows: [], insert: [], skin: null });
assert.match(logs[0], /missing/);
fs.rmSync(empty, { recursive: true });

// 4) skin ids match the in-page plugin, cookie is host-scoped and removable
const vm = require('node:vm');
const sb = { window: { __ModuleLoader__: { load(e) { this.e = e } } }, document: { cookie: '' } };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(packagesRoot, 'dsh-client-ui-skin', 'lib', 'client.js'), 'utf8'), sb);
const plugin = sb.window.__ModuleLoader__.e.factory(() => ({}));
assert.deepEqual(Object.keys(plugin.SKINS).sort(), [...SKIN_IDS].sort(), 'SKIN_IDS match plugin SKINS');
assert.equal(plugin.COOKIE_NAME, COOKIE_NAME);

(async () => {
  const jar = [];
  const session = { cookies: {
    async set(c) { jar.push(c) },
    async remove(url, name) { jar.push({ removed: name, url }) },
  } };
  await applySkinCookie(session, 'http://127.0.0.1:53111/session/abc', 'bigfish');
  assert.deepEqual(jar[0], { url: 'http://127.0.0.1:53111', name: 'neko_skin', value: 'bigfish', path: '/', sameSite: 'strict' });
  await applySkinCookie(session, 'http://127.0.0.1:53111/', null);
  assert.deepEqual(jar[1], { removed: 'neko_skin', url: 'http://127.0.0.1:53111' });
  console.log('ok: skin patch rows are absolute, minimal, fall back to the official look, and the skin cookie matches the plugin');
})().catch((e) => { console.error(e); process.exit(1); });
