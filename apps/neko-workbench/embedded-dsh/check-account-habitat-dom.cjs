'use strict';
// Run with NEKO_DOM_DEPS pointing to a directory containing jsdom.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const deps = createRequire(path.join(process.env.NEKO_DOM_DEPS || __dirname, 'package.json'));
const { JSDOM } = deps('jsdom');
let activeDom;

(async () => {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div data-slot="settings.launcher"><button class="hjANda_trigger" aria-haspopup="menu" aria-expanded="false" data-collapsed="false" data-signed-out="true" aria-label="Native login">
      <span class="hjANda_avatar">native</span><span class="hjANda_label">Login</span><svg></svg>
    </button></div></body></html>`, { url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true });
  activeDom = dom;
  const win = dom.window;
  const source = fs.readFileSync(path.join(__dirname, 'account-habitat-source.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(__dirname, 'b0-skin/packages/dsh-client-ui-white-label/lib/client.js'), 'utf8');
  const launcherCode = value => value.slice(value.indexOf('  function renderLauncher(snap)'), value.indexOf('  function renderMenu(snap)'));
  assert.equal(launcherCode(bundle), launcherCode(source), 'installed bundle matches the tested launcher');
  assert.match(bundle, /signedOutIconSrc: 'data:image\/svg\+xml,' \+ encodeURIComponent\(faviconSvg\(\)\)/, 'installed bundle supplies the N.E.K.O. mark');
  win.eval(source);
  const button = win.document.querySelector('button');
  let clicks = 0;
  button.addEventListener('click', () => { clicks++; });
  const ctx = { remote: { account: {
    getState: async () => ({ ok: true, value: { status: 'credential-stored', attempt: null, links: {} } }),
    getBalance: async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'USD', balance: '1' }], bonusWallets: [] } }),
  } }, locale: { getSnapshot: () => ({ active: 'en-US' }) } };
  const icon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
  const dispose = win.installNekoAccountHabitat(ctx, { document: win.document, window: win,
    cssText: fs.readFileSync(path.join(__dirname, 'account-habitat-source.css'), 'utf8'),
    signedOutIconSrc: icon, developerAvatarSrc: 'data:image/png;base64,AAAA' });
  const owned = button.querySelector('[data-neko-account-owned="launcher"]');
  assert.equal(owned.children.length, 1, 'signed-out launcher contains only the logo');
  assert.equal(owned.firstElementChild.className, 'neh-signed-out-icon');
  assert.equal(owned.firstElementChild.getAttribute('src'), icon);
  assert.equal(button.getAttribute('aria-label'), '登录 DeepSeek 账号');
  assert.equal(win.getComputedStyle(button).width, '36px');
  assert.equal(win.getComputedStyle(button.querySelector('.hjANda_label')).display, 'none');
  button.click();
  assert.equal(clicks, 1, 'the native account button remains clickable');
  button.setAttribute('data-signed-out', 'false');
  await new Promise(resolve => win.setTimeout(resolve, 0));
  assert.equal(owned.querySelector('.neh-signed-out-icon'), null, 'signed-in state removes the login logo');
  assert.ok(owned.querySelector('.neh-developer-avatar'), 'signed-in habitat is restored');
  assert.match(button.getAttribute('aria-label'), /已登录/);
  dispose();
  assert.equal(button.querySelector('[data-neko-account-owned="launcher"]'), null);
  assert.equal(button.getAttribute('aria-label'), 'Native login');
  assert.equal(button.hasAttribute('data-neko-account-habitat'), false);
  assert.equal(win.document.getElementById('neko-account-habitat-style'), null);
  dom.window.close();
  console.log('PASS signed-out logo, native login click, signed-in transition and disposal');
})().catch(error => { activeDom?.window.close(); console.error(error); process.exitCode = 1; });

