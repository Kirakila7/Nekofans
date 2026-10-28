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
function addDialog(title, description) {
  const dialog = document.createElement('div');
  dialog.className = 'J8V0KW_dialog';
  const heading = document.createElement('h2'); heading.className = 'J8V0KW_title'; heading.textContent = title;
  const body = document.createElement('p'); body.className = 'J8V0KW_description'; body.textContent = description;
  const close = document.createElement('button'); close.className = 'J8V0KW_close'; close.addEventListener('click', () => dialog.remove());
  dialog.append(heading, body, close); document.body.append(dialog); return dialog;
}
(async () => {
  const target = addDialog('开始使用', '登录 DeepSeek 账号，或添加 API Key，即可开始使用。');
  const other = addDialog('登录失败', '请重新登录后继续操作。');
  await Promise.resolve();
  assert.equal(target.isConnected, false);
  assert.equal(other.isConnected, true);
  const english = addDialog('Get started', 'Sign in to your DeepSeek account or add an API Key');
  await Promise.resolve();
  assert.equal(english.isConnected, false);
  for (const dispose of disposers.reverse()) dispose();
  const after = addDialog('开始使用', '登录 DeepSeek 账号');
  await Promise.resolve();
  assert.equal(after.isConnected, true);
  dom.window.close();
  console.log('Only the get-started sign-in dialog is dismissed; other dialogs and cleanup are preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });

