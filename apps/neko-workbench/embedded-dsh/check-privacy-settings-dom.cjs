'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const deps = createRequire(path.join(process.env.NEKO_DOM_DEPS || __dirname, 'package.json'));
const { JSDOM } = deps('jsdom');
let activeDom;

(async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  activeDom = dom;
  const win = dom.window, doc = win.document, flush = () => new Promise(resolve => win.setTimeout(resolve, 0));
  win.eval(fs.readFileSync(path.join(__dirname, 'privacy-settings.js'), 'utf8'));
  win.__ModuleLoader__ = { load(entry) { this.entry = entry; } };
  win.eval(fs.readFileSync(path.join(__dirname, 'b0-skin/packages/dsh-client-ui-skin/lib/client.js'), 'utf8'));
  const plugin = win.__ModuleLoader__.entry.factory(() => { throw Error('Unexpected dependency'); });
  assert.equal(plugin.installPrivacySettings.toString().replace(/^ {4}/gm, ''), win.installPrivacySettings.toString(), 'the installed bundle matches its source');
  doc.body.innerHTML = `<main role="dialog">
    <section class="_6qcDqa_section"><div class="_6qcDqa_card" id="account">Account</div><div class="_6qcDqa_balanceCard" id="wallet">Balance</div></section>
    <section id="general"><div id="target"><div><div id="heading">在使用官方模型 API 时上传 Session Log</div><div>帮助改进 DeepSeek 模型与产品</div></div><button role="switch" aria-checked="true">Upload</button></div>
      <div id="other"><div><div>其他设置</div></div><button role="switch" aria-checked="true"></button></div></section>
    <section><div class="_6qcDqa_card" id="unrelated-card">Other card</div></section></main>`;
  const row = doc.querySelector('#target'), parent = row.parentElement, native = row.querySelector('button');
  let persisted = true, saves = 0;
  native.addEventListener('click', () => { persisted = !persisted; saves++; native.setAttribute('aria-checked', String(persisted)); });
  const dispose = plugin.installPrivacySettings(doc);
  await flush();
  let header = row.previousElementSibling, disclosure = header.querySelector('button');
  assert.match(disclosure.textContent, /隐私 \/ 高级设置/);
  assert.match(disclosure.textContent, /会话日志上传：已开启/);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(disclosure.getAttribute('aria-controls'), row.id);
  assert.equal(win.getComputedStyle(row).display, 'none');
  assert.equal(native.getAttribute('aria-checked'), 'true'); assert.equal(saves, 0);
  assert.equal(win.getComputedStyle(doc.querySelector('#account')).display, 'none');
  assert.equal(win.getComputedStyle(doc.querySelector('#wallet')).display, 'none');
  assert(!doc.querySelector('#unrelated-card').classList.contains('neko-settings-account-card'));
  assert(!doc.querySelector('#other').hasAttribute('data-neko-privacy-collapsed'));
  native.removeAttribute('aria-checked'); await flush();
  assert.match(disclosure.textContent, /状态待确认/); assert.equal(saves, 0);
  native.setAttribute('aria-checked', 'true'); await flush();

  disclosure.click(); await flush();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.notEqual(win.getComputedStyle(row).display, 'none');
  assert.equal(row.parentElement, parent); assert.equal(row.querySelector('button'), native);
  assert.equal(saves, 0, 'opening settings never saves a privacy preference');
  native.click(); await flush();
  assert.equal(persisted, false); assert.equal(saves, 1);
  assert.match(disclosure.textContent, /会话日志上传：已关闭/);
  native.focus(); disclosure.click(); await flush();
  assert.equal(doc.activeElement, disclosure, 'collapse does not leave focus inside hidden controls');
  disclosure.click(); await flush();
  assert.equal(native.getAttribute('aria-checked'), 'false'); assert.equal(saves, 1);
  doc.querySelector('#heading').textContent = 'Upload Session Log when using the official model API';
  await flush();
  assert.match(disclosure.textContent, /Privacy \/ advanced settings/);
  assert.match(disclosure.textContent, /Session Log upload: off/);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');

  doc.querySelector('#heading').textContent = 'Session Log vNext'; await flush();
  assert(!row.hasAttribute('data-neko-privacy-collapsed'), 'unknown native copy stays visible');
  assert.equal(row.querySelector('button'), native); assert.equal(saves, 1);
  doc.querySelector('#heading').textContent = 'Upload Session Log when using the official model API'; await flush();
  header = row.previousElementSibling; disclosure = header.querySelector('button');
  assert.match(disclosure.textContent, /Session Log upload: off/);

  const general = doc.querySelector('#general'); general.remove(); await flush();
  assert(!header.isConnected); assert(!row.hasAttribute('data-neko-privacy-collapsed'));
  const replacement = doc.createElement('section');
  replacement.innerHTML = '<div id="native-privacy-id"><div><div>在使用官方模型 API 时上传 Session Log</div></div><label><input type="checkbox" checked></label></div>';
  doc.querySelector('main').appendChild(replacement); await flush();
  const newRow = replacement.querySelector('#native-privacy-id'), checkbox = newRow.querySelector('input');
  header = newRow.previousElementSibling; disclosure = header.querySelector('button');
  assert.equal(doc.querySelectorAll('.neko-privacy-settings').length, 1, 'reopening settings has no stale disclosure');
  assert.equal(disclosure.getAttribute('aria-controls'), 'native-privacy-id');
  assert.match(disclosure.textContent, /已开启/);
  disclosure.click(); checkbox.click(); await flush();
  assert.equal(checkbox.checked, false); assert.match(disclosure.textContent, /已关闭/);
  const checkboxAfterClick = newRow.querySelector('input');
  dispose(); await flush();
  assert.equal(doc.querySelector('.neko-privacy-settings'), null);
  assert.equal(doc.querySelector('[data-neko-privacy-style]'), null);
  assert.equal(doc.querySelector('.neko-settings-account-card'), null);
  assert(!newRow.hasAttribute('data-neko-privacy-collapsed')); assert.equal(newRow.id, 'native-privacy-id');
  assert.equal(newRow.querySelector('input'), checkboxAfterClick); assert.equal(checkbox.checked, false);
  assert.notEqual(win.getComputedStyle(doc.querySelector('#account')).display, 'none');
  checkbox.click(); await flush();
  assert.equal(doc.querySelector('.neko-privacy-settings'), null, 'unload stops observing the native page');
  dom.window.close();
  console.log('PASS visible privacy entry, live on/off status, native save, keyboard focus, locale, remount, scoped cards and cleanup');
})().catch(error => { activeDom?.window.close(); console.error(error); process.exitCode = 1; });
