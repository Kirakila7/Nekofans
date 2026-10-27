// N.E.K.O. 工作台 · DSH Web brand + skin rows for the pet's isolated DSH profile.
//
// main.cjs writes data/bridge.patch.json before spawning
// `dsh --profile web --patch ...` with DSH_HOME=data/dsh. This helper returns
// the extra rows for that file and the skin cookie for the DSH window. Nothing
// touches the global DeepSeek Harness install, app.asar, or ~/.dsh.
//
// Local packages are referenced by absolute path to lib/index.js; DSH walks up
// to package.json and serves the "./client" export (verified on 0.2.1-rc.3).
//
// PET_DSH_SKIN
//   (unset) | neko-mist   N.E.K.O. product brand + default mist-blue skin
//   bigfish               N.E.K.O. product brand + 大肥鱼 skin
//   off                   official DSH look, no packages mounted
// Product identity is the same for every skin; only the palette changes.
const fs = require('node:fs');
const path = require('node:path');

const PACKAGES = [
  { id: 'neko-brand', dir: 'dsh-client-ui-white-label' },
  { id: 'neko-skin', dir: 'dsh-client-ui-skin' },
];
/** Must match SKINS in dsh-client-ui-skin/lib/client.js. */
const SKIN_IDS = ['neko-mist', 'bigfish'];
const DEFAULT_SKIN = 'neko-mist';
const COOKIE_NAME = 'neko_skin';

function pickSkin(env) {
  const raw = String(env.PET_DSH_SKIN || '').trim().toLowerCase();
  if (raw === 'off') return null;
  return SKIN_IDS.includes(raw) ? raw : DEFAULT_SKIN;
}

/**
 * @param {string} packagesRoot absolute path to embedded-dsh/b0-skin/packages
 * @param {{ env?: NodeJS.ProcessEnv, log?: (msg: string) => void }} [options]
 * @returns {{ rows: object[], insert: object[], skin: string|null }}
 *   rows   -> standalone patch rows (spread into the top-level array)
 *   insert -> loader entries (spread into the existing `insert` row)
 *   skin   -> skin id for applySkinCookie(), null when disabled/missing
 */
function skinPatch(packagesRoot, { env = process.env, log = () => {} } = {}) {
  const none = { rows: [], insert: [], skin: null };
  const skin = pickSkin(env);
  if (!skin) return none;
  const insert = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(packagesRoot, pkg.dir);
    const required = ['package.json', 'lib/index.js', 'lib/client.js'].map((f) => path.join(dir, f));
    const missing = required.find((f) => !fs.existsSync(f));
    if (missing) {
      log('[neko-skin] missing ' + missing + ', using the official look\n');
      return none;
    }
    insert.push({ id: pkg.id, name: path.join(dir, 'lib', 'index.js') });
  }
  return {
    // The official brand plugin registers the same brand slots; disable it so
    // ours is the only registrant. All feature plugins stay enabled.
    rows: [{ id: 'ui-brand-official', disabled: true }],
    insert,
    skin,
  };
}

/**
 * Tell the in-page skin plugin which skin to use. Cookies are host-scoped,
 * so this survives the random port. Call before dshWindow.loadURL(url).
 * @param {Electron.Session} session  dshWindow.webContents.session
 * @param {string} url                DSH launch URL (http://127.0.0.1:<port>/...)
 * @param {string|null} skin
 */
async function applySkinCookie(session, url, skin) {
  const origin = new URL(url).origin;
  if (!skin) {
    await session.cookies.remove(origin, COOKIE_NAME).catch(() => {});
    return;
  }
  await session.cookies.set({ url: origin, name: COOKIE_NAME, value: skin, path: '/', sameSite: 'strict' });
}

module.exports = { skinPatch, applySkinCookie, PACKAGES, SKIN_IDS, DEFAULT_SKIN, COOKIE_NAME };
