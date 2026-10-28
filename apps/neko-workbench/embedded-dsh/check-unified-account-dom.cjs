'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.join(process.env.NEKO_DOM_DEPS || __dirname, 'package.json'))('jsdom');
let active;
(async () => {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div data-slot="settings.launcher"><button class="hjANda_trigger" aria-haspopup="menu" aria-expanded="false" data-collapsed="false" data-signed-out="false" aria-label="Native account"><span class="hjANda_label">Native</span></button></div>
    </body></html>`, { url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true });
  active = dom; const win = dom.window, doc = win.document, flush = () => new Promise(resolve => win.setTimeout(resolve, 5));
  win.eval(fs.readFileSync(path.join(__dirname, 'account-habitat-source.js'), 'utf8'));
  let balanceReads = 0, calls = [], signedIn = true;
  let reply = { status: 'signed-in', authType: 'chatgpt', planType: 'plus', quota: { status: 'ready', buckets: [{ id: 'codex', name: 'Codex', windows: [{ windowDurationMins: 10080, remainingPercent: 72, resetsAt: null }] }] } };
  const bridge = { getAccounts: async options => { calls.push(options); return { codex: { ...reply, quota: options.includeQuota ? reply.quota : { status: 'idle', buckets: [] } } }; } };
  const ctx = { locale: { getSnapshot: () => ({ active: 'zh-CN' }) }, remote: { account: {
    getState: async () => ({ ok: true, value: { status: signedIn ? 'credential-stored' : 'signed-out' } }),
    getBalance: async () => { balanceReads++; return { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }] } }; },
  } } };
  const stop = win.installNekoAccountHabitat(ctx, { document: doc, window: win, accountsBridge: bridge, cssText: fs.readFileSync(path.join(__dirname, 'account-habitat-source.css'), 'utf8') });
  await flush();
  const button = doc.querySelector('button');
  assert.match(button.getAttribute('aria-label'), /DSH 已登录，Codex 已登录/);
  assert.equal(balanceReads, 0, 'collapsed entry does not request wallet or quota');
  assert(calls.every(c => !c.includeQuota));
  const menu = doc.createElement('div'); menu.dataset.menuMaterial = ''; menu.setAttribute('role', 'menu');
  menu.innerHTML = '<div class="_viewport_4ub78_19" role="presentation"><button role="menuitem">设置</button><button role="menuitem">意见反馈</button><button role="menuitem" id="native-auth">退出登录</button></div>';
  const native = [...menu.querySelectorAll('button')]; let nativeClicks = 0; native[0].addEventListener('click', () => nativeClicks++);
  doc.body.appendChild(menu); button.setAttribute('aria-expanded', 'true'); await flush(); await flush();
  const card = menu.querySelector('.neh-menu-card');
  assert.match(card.textContent, /账号与额度/); assert.match(card.textContent, /CNY 余额 ¥12.34/);
  assert.match(card.textContent, /7 天剩余 72%/); assert.match(card.textContent, /重置时间暂不可读取/);
  assert.equal(card.querySelector('progress').value, 72);
  assert.deepEqual([...menu.querySelectorAll('button[role=menuitem]')], native);
  native[0].click(); assert.equal(nativeClicks, 1, 'native settings handler remains intact');
  signedIn = false; native[2].textContent = '登录'; button.setAttribute('data-signed-out', 'true'); await flush();
  assert.match(button.getAttribute('aria-label'), /DSH 未登录，Codex 已登录/);
  assert.equal(win.getComputedStyle(button).height, '94px', 'Codex account stays available when DSH logs out');
  assert(!card.textContent.includes('¥12.34'), 'sign-out removes the old wallet immediately');
  reply = { status: 'signed-out', quota: { status: 'idle', buckets: [] } };
  card.querySelector('.neh-account-refresh').focus(); card.querySelector('.neh-account-refresh').click(); await flush(); await flush();
  assert(!card.textContent.includes('72%'), 'old Codex quotas do not survive sign-out');
  assert.match(button.getAttribute('aria-label'), /Codex 未登录/);
  assert.equal(doc.activeElement.className, 'neh-account-refresh', 'refresh preserves keyboard focus');
  stop();
  assert.equal(button.getAttribute('aria-label'), 'Native account');
  assert(!button.hasAttribute('data-neko-unified-account')); assert(!doc.querySelector('[data-neko-account-owned]'));
  assert.deepEqual([...menu.querySelectorAll('button')], native);
  dom.window.close(); console.log('PASS unified login state, lazy separate quotas, native controls, account changes, focus and cleanup');
})().catch(error => { active?.window.close(); console.error(error); process.exitCode = 1; });
