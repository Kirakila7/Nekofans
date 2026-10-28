'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const deps = process.env.NEKO_DOM_DEPS;
const directory = path.join(__dirname, '../../apps/neko-workbench');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('context sharing is opt-in, names the destination and resets when it changes', { skip: !deps }, async () => {
  const { JSDOM } = createRequire(path.join(deps, 'package.json'))('jsdom');
  const dom = new JSDOM(fs.readFileSync(path.join(directory, 'screen-share.html'), 'utf8'), { runScripts: 'outside-only' });
  const { window } = dom, calls = [];
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  const vision = { effective: { protocol: 'openai-compatible', baseUrl: 'https://vision.example/v1', model: 'visual' }, settings: { mode: 'chat' } };
  const state = () => ({ phase: 'idle', source: null, requests: 0, limit: 120, records: [], vision });
  let receive;
  window.screenShare = {
    subscribe(fn) { receive = fn; return () => {}; },
    async call(method, value) {
      if (method === 'state') return state();
      if (method === 'sources') return [{ id: 'window:1:0', name: 'Example' }];
      if (method === 'start') { calls.push(value); throw Error('fixture stop before capture'); }
      return state();
    }
  };
  window.eval(fs.readFileSync(path.join(directory, 'screen-share-ui.js'), 'utf8'));
  await tick();
  const $ = id => window.document.getElementById(id);
  const disclosure=$('share-context').parentElement.textContent;
  assert.match(disclosure,/已确认的旧版聊天记忆/);
  assert.match(disclosure,/不包含 N\.E\.K\.O\. 原生记忆/);
  $('sources').value = 'window:1:0';
  assert.equal($('share-context').checked, false);
  assert.equal($('recipient').textContent, 'openai-compatible · https://vision.example/v1 · visual');
  $('start').click(); await tick();
  assert.equal(calls[0].contextConsent, null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].target)), { protocol: 'openai-compatible', baseUrl: 'https://vision.example/v1', model: 'visual' });
  $('share-context').checked = true;
  $('start').click(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].contextConsent)), { protocol: 'openai-compatible', baseUrl: 'https://vision.example/v1', model: 'visual' });
  vision.effective.baseUrl = 'https://vision.example/other-tenant'; receive(state());
  assert.equal($('share-context').checked, false);
  assert.equal($('recipient').textContent, 'openai-compatible · https://vision.example/other-tenant · visual');
  $('share-context').checked = true; vision.effective.protocol = 'anthropic'; receive(state());
  assert.equal($('share-context').checked, false);
  assert.equal($('recipient').textContent, 'anthropic · https://vision.example/other-tenant · visual');
  window.close();
});
