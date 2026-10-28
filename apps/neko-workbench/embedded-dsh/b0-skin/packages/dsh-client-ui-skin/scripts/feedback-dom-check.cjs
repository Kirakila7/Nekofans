'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const deps = createRequire(path.join(process.env.NEKO_DOM_DEPS || path.join(__dirname, '..'), 'package.json'));
const { JSDOM } = deps('jsdom');
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://example.test' });
dom.window.__ModuleLoader__ = { load(entry) { this.entry = entry; } };
dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8'));
const plugin = dom.window.__ModuleLoader__.entry.factory(() => { throw new Error('unexpected dependency'); });
const disposers = [];
plugin.apply({ effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); }, theme: { overrideTokens() { return () => {}; } } });
const { document } = dom.window;
document.body.innerHTML = '<div data-menu-material role="menu"><button role="menuitem"><span class="_itemLabel_4ub78_190">设置</span><span>Ctrl+,</span></button><button role="menuitem"><span class="_itemLabel_4ub78_190">意见反馈</span></button><button role="menuitem">登录</button></div><div data-menu-material role="menu"><button role="menuitem">意见反馈</button><button role="menuitem">其他</button></div>';
Promise.resolve().then(() => {
  const menus = document.querySelectorAll('[role=menu]');
  const account = menus[0].querySelectorAll('button');
  assert.equal(account[1].hasAttribute('data-neko-hide-feedback'), true);
  assert.equal(account[0].hasAttribute('data-neko-hide-feedback'), false);
  assert.equal(account[2].hasAttribute('data-neko-hide-feedback'), false);
  assert.equal(menus[1].querySelector('button').hasAttribute('data-neko-hide-feedback'), false);
  account[2].textContent = '退出登录';
  return Promise.resolve();
}).then(() => {
  const item = document.querySelector('[role=menu] button:nth-child(2)');
  assert.equal(item.hasAttribute('data-neko-hide-feedback'), true);
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(item.hasAttribute('data-neko-hide-feedback'), false);
  dom.window.close();
  console.log('Feedback entry is hidden only in the account menu and restored on unload.');
}).catch(error => { console.error(error); process.exitCode = 1; });

