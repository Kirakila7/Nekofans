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
    idlePosterSrc: 'data:image/png;base64,AA==',
  });
  await flush();
  const launcher = trigger.querySelector('.neh-launcher');
  const beforeOpening = launcher.outerHTML;
  const card = menu.querySelector('.neh-menu-card');
  assert.ok(card, 'signed-out native login menu receives the expanded card');
  assert.equal(card.querySelector('.neh-menu-heading h3').textContent, '账号与生活');
  assert.equal(card.querySelector('.neh-login-status').textContent, '未登录');
  assert.equal(card.querySelector('.neh-service-summary strong').textContent, '账号');
  assert.equal(card.querySelector('.neh-service-summary span').textContent, '工作台账号');
  assert.equal(card.querySelector('.neh-wallet').textContent, '暂不可读取');
  assert.equal(card.querySelector('.neh-empty-world').textContent, '未登录');
  assert.match(card.querySelector(':scope > .neh-menu-help').textContent, /下方登录按钮/);
  assert.equal(reads, 0, 'signed-out account never requests a balance');
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]:not([data-neko-workbench-settings])')], originalButtons);
  nativeAccount.click(); assert.equal(nativeClicks, 1, 'native login handler is preserved');
  assert.equal(trigger.querySelector('.neh-launcher').outerHTML, beforeOpening, 'expanding the menu keeps the launcher unchanged');

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
  assert.match(signedInCard.querySelector(':scope > .neh-menu-help').textContent, /设置中管理/);
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]:not([data-neko-workbench-settings])')], originalButtons);
  nativeAccount.click(); assert.equal(nativeClicks, 2, 'native sign-out handler is preserved');
  assert.equal(reads, 1, 'one read from the fixture projection supplies its displayed balance');

  nativeAccount.querySelector('span').textContent = '其他操作';
  await flush();
  assert.equal(menu.querySelector('.neh-menu-card'), null, 'an unrelated menu is left untouched');
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]:not([data-neko-workbench-settings])')], originalButtons);
  stop();
  assert.match(login.querySelector('p').textContent, /DeepSeek/, 'disposing restores the native dialog text');
  assert.equal(trigger.getAttribute('aria-label'), '原生账号');
  assert.equal(trigger.querySelector('.neh-launcher'), null);
  assert.equal(document.getElementById('neko-account-habitat-style'), null);
  assert.deepEqual([...menu.querySelectorAll('button[role="menuitem"]:not([data-neko-workbench-settings])')], originalButtons);
  dom.window.close();
  console.log('PASS account habitat DOM: signed-out/native login, signed-in/native sign-out, sample balance, preserved launcher, menu detection and cleanup');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
