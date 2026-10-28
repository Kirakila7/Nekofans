'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const deps = createRequire(path.join(process.env.NEKO_DOM_DEPS, 'package.json'));
const { JSDOM } = deps('jsdom');
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
dom.window.eval(fs.readFileSync(path.join(__dirname, 'session-log-row-removal.js'), 'utf8'));
const dispose = dom.window.installSessionLogRowRemoval(dom.window.document);
const doc = dom.window.document;
doc.body.innerHTML = '<section><div id="target"><div><div>在使用官方模型 API 时上传 Session Log</div><div>帮助改进 DeepSeek 模型与产品</div></div><button role="switch" aria-checked="true"></button></div><div id="other"><div><div>其他设置</div></div><button role="switch"></button></div></section>';
Promise.resolve().then(() => {
  const target = doc.querySelector('#target');
  assert(target.hasAttribute('data-neko-hide-session-log-row'));
  assert.equal(target.querySelector('button').getAttribute('aria-checked'), 'true');
  assert.equal(doc.querySelector('#other').hasAttribute('data-neko-hide-session-log-row'), false);
  target.firstElementChild.firstElementChild.textContent = 'Upload Session Log when using the official model API';
  return Promise.resolve();
}).then(() => {
  assert(doc.querySelector('#target').hasAttribute('data-neko-hide-session-log-row'));
  dispose();
  assert.equal(doc.querySelector('#target').hasAttribute('data-neko-hide-session-log-row'), false);
  dom.window.close();
  console.log('Session Log row hidden without changing the switch; unrelated rows and cleanup verified.');
}).catch(error => { console.error(error); process.exitCode = 1; });

