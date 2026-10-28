'use strict';

// Offline, isolated native-menu fixture; uses no real account or network.
// NEKO_DOM_DEPS=/path/to/deps node embedded-dsh/check-account-habitat-dom.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const deps = createRequire(path.join(process.env.NEKO_DOM_DEPS || __dirname, 'package.json'));
const { JSDOM } = deps('jsdom');
const source = fs.readFileSync(path.join(__dirname, 'account-habitat-source.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'account-habitat-source.css'), 'utf8');
const bundle = fs.readFileSync(path.join(__dirname, 'b0-skin/packages/dsh-client-ui-white-label/lib/client.js'), 'utf8');
const launcherCode = value => value.slice(value.indexOf('  function renderLauncher(snap)'), value.indexOf('  function renderMenu(snap)'));
assert.equal(launcherCode(bundle), launcherCode(source), 'installed bundle matches tested launcher');
assert.match(bundle, /signedOutIconSrc: 'data:image\/svg\+xml,' \+ encodeURIComponent\(faviconSvg\(\)\)/, 'installed bundle supplies native login logo');
const signedOutIcon = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
const sandbox = { URL };
vm.runInNewContext(source, sandbox);

async function flush() { await new Promise(resolve => setTimeout(resolve, 0)); }
async function run() {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div data-slot="settings.launcher">
      <button class="hjANda_trigger" aria-haspopup="menu" aria-expanded="true" data-collapsed="false" data-signed-out="true" aria-label="原生账号">
        <span class="hjANda_label">原生账号</span>
      </button>
    </div>
    <div data-menu-material role="menu">
      <div class="_viewport_4ub78_19" role="presentation">
        <button id="native-settings" role="menuitem"><span class="_itemLabel_4ub78_190">设置</span></button>
        <button id="native-feedback" role="menuitem"><span class="_itemLabel_4ub78_190">意见反馈</span></button>
        <button id="native-account" role="menuitem"><span class="_itemLabel_4ub78_190">登录</span></button>
      </div>
    </div>
  </body></html>`, { url: 'http://127.0.0.1:43217/', pretendToBeVisual: true });
  const { window } = dom, { document } = window;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const trigger = document.querySelector('.hjANda_trigger');
  const menu = document.querySelector('[role="menu"]');
  const nativeSettings = document.querySelector('#native-settings');
  const nativeFeedback = document.querySelector('#native-feedback');
  const nativeAccount = document.querySelector('#native-account');
  const originalButtons = [nativeSettings, nativeFeedback, nativeAccount];
  let signedIn = false, reads = 0, nativeClicks = 0;
  let codexListener, codexUnsubscribed = false;
  window.nekoWorkbench = { codex: {
    onAccountStatus(listener) { codexListener = listener; return () => { codexUnsubscribed = true; }; },
    accountStatus: async () => ({ status: 'unknown', source: null }),
  } };
  nativeAccount.addEventListener('click', () => nativeClicks++);
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
    remote: { account: {
      getState: async () => ({ ok: true, value: { status: signedIn ? 'credential-stored' : 'signed-out' } }),
      getBalance: async () => { reads++; return { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '8.80' }] } }; },
    } },
  };
  const stop = sandbox.installNekoAccountHabitat(ctx, {
    document, window, cssText: css,
    developerAvatarSrc: 'data:image/png;base64,AA==',
    signedOutIconSrc: signedOutIcon,
    idlePosterSrc: 'data:image/png;base64,AA==',
  });
  await flush();
  const launcher = trigger.querySelector('.neh-launcher');
  const beforeOpening = launcher.outerHTML;
  assert.equal(launcher.children.length, 1, 'when neither account is signed in only the native login logo is shown');
  assert.equal(launcher.firstElementChild.className, 'neh-signed-out-icon');
  assert.equal(launcher.firstElementChild.getAttribute('src'), signedOutIcon);
  assert.match(trigger.getAttribute('aria-label'), /登录/);
  assert.equal(trigger.getAttribute('data-neko-account-compact'), 'true');
  assert.equal(window.getComputedStyle(trigger).width, '36px', 'the signed-out launcher remains compact');
  assert.equal(window.getComputedStyle(trigger.querySelector('.hjANda_label')).display, 'none');
  const card = menu.querySelector('.neh-menu-card');
  assert.ok(card, 'signed-out native login menu receives the expanded card');
  assert.equal(card.querySelector('.neh-menu-heading h3').textContent, '账号与生活');
  assert.equal(card.querySelector('.neh-login-status').textContent, '未登录');
  assert.equal(card.querySelector('.neh-service-summary strong').textContent, '账号');
  assert.equal(card.querySelector('.neh-service-summary span').textContent, '工作台账号');
  assert.equal(card.querySelector('.neh-wallet').textContent, '暂不可读取');
  assert.equal(card.querySelectorAll('[data-neko-account-pet]').length, 0, 'unknown account state is not represented as a signed-in character');
  assert.match(card.querySelector('.neh-menu-help').textContent, /下方登录按钮/);
  assert.equal(reads, 0, 'signed-out account never requests a balance');
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]')], originalButtons);
  nativeAccount.click(); assert.equal(nativeClicks, 1, 'native login handler is preserved');
  assert.equal(trigger.querySelector('.neh-launcher').outerHTML, beforeOpening, 'expanding the menu keeps the launcher unchanged');
  codexListener({ status: 'signed-in', source: 'chatgpt' });
  assert.equal(trigger.querySelector('.neh-signed-out-icon'), null, 'ChatGPT login restores the habitat even when DSH is signed out');
  assert.equal(trigger.querySelectorAll('[data-neko-account-pet=\"chatgpt\"]').length, 1, 'ChatGPT status is visible in the launcher');
  assert.equal(trigger.querySelectorAll('[data-neko-account-pet=\"dsh\"]').length, 0);
  assert.equal(trigger.getAttribute('data-neko-account-compact'), 'false');
  assert.notEqual(window.getComputedStyle(trigger).width, '36px', 'the launcher is expanded for the signed-in ChatGPT character');
  assert.match(trigger.getAttribute('aria-label'), /ChatGPT 已登录/);
  assert.equal(menu.querySelectorAll('[data-neko-account-pet="chatgpt"]').length, 1, 'ChatGPT sign-in shows the developer character');
  assert.equal(menu.querySelectorAll('[data-neko-account-pet="dsh"]').length, 0, 'ChatGPT sign-in does not imply DSH login');
  assert.equal(menu.querySelector('.neh-wallet').textContent, '暂不可读取', 'ChatGPT login does not fake the DSH wallet balance');

  const login = document.createElement('div');
  login.setAttribute('role', 'dialog');
  login.innerHTML = '<h2>开始使用</h2><p>登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。</p><button>添加 API Key</button><button>登录</button>';
  document.body.appendChild(login);
  const message = document.createElement('p'); message.textContent = '登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。'; document.body.appendChild(message);
  await flush();
  assert.equal(login.querySelector('p').textContent, '登录账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。');
  assert.match(message.textContent, /DeepSeek/, 'unrelated text is never rewritten');

  signedIn = true;
  nativeAccount.querySelector('span').textContent = '退出';
  trigger.setAttribute('data-signed-out', 'false');
  await flush(); await flush();
  const signedInCard = menu.querySelector('.neh-menu-card');
  assert.ok(signedInCard, 'native sign-out menu receives the same card');
  assert.equal(signedInCard.querySelector('.neh-login-status').textContent, '已登录');
  assert.equal(signedInCard.querySelector('.neh-wallet').textContent, 'CNY 余额 ¥8.80');
  assert.equal(signedInCard.querySelector('.neh-source').textContent, '官方充值钱包');
  assert.ok(signedInCard.querySelector('.neh-pet-poster'), 'real habitat slot remains available in reduced-motion mode');
  assert.equal(signedInCard.querySelectorAll('[data-neko-account-pet="dsh"]').length, 1);
  assert.equal(signedInCard.querySelectorAll('[data-neko-account-pet="chatgpt"]').length, 1, 'both real accounts can appear together');
  assert.equal(signedInCard.querySelector('.neh-pets').children.length, 2, 'characters use separate slots');
  assert.match(signedInCard.querySelector('.neh-menu-help').textContent, /设置中管理/);
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]')], originalButtons);
  nativeAccount.click(); assert.equal(nativeClicks, 2, 'native sign-out handler is preserved');
  assert.equal(reads, 1, 'one read from the fixture projection supplies its displayed balance');
  codexListener({ status: 'unsupported', source: null });
  assert.equal(menu.querySelectorAll('[data-neko-account-pet="chatgpt"]').length, 0, 'API-key or unsupported auth is not presented as ChatGPT login');
  assert.equal(menu.querySelectorAll('[data-neko-account-pet="dsh"]').length, 1, 'Codex account changes do not alter DSH state');

  signedIn = false;
  nativeAccount.querySelector('span').textContent = '登录';
  trigger.setAttribute('data-signed-out', 'true');
  await flush(); await flush();
  assert.equal(trigger.getAttribute('data-neko-account-compact'), 'true', 'logout restores compact native login');
  assert.ok(trigger.querySelector('.neh-signed-out-icon'));
  assert.equal(trigger.querySelectorAll('[data-neko-account-pet]').length, 0);
  assert.equal(window.getComputedStyle(trigger).width, '36px');

  nativeAccount.querySelector('span').textContent = '其他操作';
  await flush();
  assert.equal(menu.querySelector('.neh-menu-card'), null, 'an unrelated menu is left untouched');
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]')], originalButtons);
  stop();
  assert.equal(codexUnsubscribed, true, 'Codex account subscription is released on unload');
  assert.match(login.querySelector('p').textContent, /DeepSeek/, 'disposing restores the native dialog text');
  assert.equal(trigger.getAttribute('aria-label'), '原生账号');
  assert.equal(trigger.hasAttribute('data-neko-account-compact'), false, 'owned state is restored on disposal');
  assert.equal(trigger.querySelector('.neh-launcher'), null);
  assert.equal(document.getElementById('neko-account-habitat-style'), null);
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]')], originalButtons);
  dom.window.close();
  console.log('PASS account habitat DOM: signed-out/native login, signed-in/native sign-out, sample balance, preserved launcher, menu detection and cleanup');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
