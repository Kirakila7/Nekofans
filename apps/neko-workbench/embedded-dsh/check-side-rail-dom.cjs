'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.join(process.env.NEKO_DOM_DEPS || __dirname, 'package.json'))('jsdom');
let active;
(async () => {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="app">
    <aside data-slot="sidebar"><button id="new">新建会话</button><button id="fish" aria-label="养鱼设置">养鱼</button>
      <div data-slot="settings.launcher"><button class="hjANda_trigger" aria-haspopup="menu" aria-expanded="false" aria-label="账号与额度：DSH 已登录，Codex 已登录">Native account</button></div></aside>
    <main><textarea>unsent draft</textarea></main></div></body></html>`, { url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true });
  active = dom; const win = dom.window, doc = win.document;
  const flush = () => new Promise(resolve => win.setTimeout(resolve, 0));
  win.eval(fs.readFileSync(path.join(__dirname, 'side-rail-source.js'), 'utf8'));
  win.__ModuleLoader__ = { load(entry) { this.entry = entry; } };
  win.eval(fs.readFileSync(path.join(__dirname, 'b0-skin/packages/dsh-client-ui-white-label/lib/client.js'), 'utf8'));
  const api = win.__ModuleLoader__.entry.factory(name => name === 'react' ? { createElement() {} } : { createPortal() {} });
  assert.equal(api.installWorkbenchSideRail.toString(), win.installWorkbenchSideRail.toString(), 'installed side rail matches the checked source');
  const original = doc.querySelector('.hjANda_trigger'), parent = original.parentNode, app = doc.querySelector('#app');
  let clicks = 0, closes = 0, home = 0, actions = [], finish;
  original.addEventListener('click', () => { clicks++; original.setAttribute('aria-expanded', 'true'); });
  const stop = win.installWorkbenchSideRail({ document: doc, window: win,
    cssText: fs.readFileSync(path.join(__dirname, 'side-rail-source.css'), 'utf8'),
    bridge: { action: async name => { actions.push(name); } },
    openBilibiliHome: () => { home++; return new Promise(resolve => { finish = resolve; }); },
    beforeAccount: () => { closes++; },
  });
  await flush();
  assert(app.hasAttribute('data-neko-rail-app'));
  const rail = doc.querySelector('[data-neko-side-rail]');
  const bottom = rail.querySelector('nav');
  assert.deepEqual([...bottom.children].map(n => n.getAttribute('aria-label')), ['哔哩哔哩主页', '养鱼界面', '账号与额度：DSH 已登录，Codex 已登录']);
  const fish = rail.querySelector('.neko-side-rail__fish'), bili = rail.querySelector('.neko-side-rail__bilibili'), account = rail.querySelector('.neko-side-rail__account');
  assert(rail.querySelector('.neko-side-rail__space'), 'the center is a flexible blank region');
  account.click(); await flush();
  assert.equal(clicks, 1); assert.equal(closes, 1); assert.equal(account.getAttribute('aria-expanded'), 'true');
  assert.equal(original.parentNode, parent, 'native React account control is neither moved nor replaced');
  assert.equal(original.tabIndex, -1, 'only the visible account button remains in the tab order');
  assert.equal(original.getAttribute('aria-hidden'), 'true', 'screen readers only see the visible account launcher');
  assert(doc.querySelector('#fish').hasAttribute('data-neko-rail-fish-original'), 'native icon/text labels hide the duplicate fish entry');
  fish.click(); await flush(); assert.deepEqual(actions, ['fish-settings'], 'opening fish UI never starts its scheduler');
  bili.click(); bili.click(); await flush(); assert.equal(home, 1, 'double clicks share one in-flight home navigation');
  finish(); await flush(); assert(!bili.hasAttribute('aria-busy'));
  original.setAttribute('aria-label', '账号与额度：DSH 未登录，Codex 已登录'); await flush();
  assert.match(account.getAttribute('aria-label'), /DSH 未登录/);
  original.setAttribute('aria-expanded', 'false'); original.focus(); await flush();
  assert.equal(doc.activeElement, account, 'closing the native popup returns focus to the visible avatar');
  assert.equal(doc.querySelector('textarea').value, 'unsent draft');
  const secondStop = win.installWorkbenchSideRail({ document: doc, window: win, bridge: { action() {} }, openBilibiliHome() {} });
  assert.equal(doc.querySelectorAll('[data-neko-side-rail]').length, 1); secondStop();
  stop();
  assert.equal(doc.querySelector('[data-neko-side-rail]'), null);
  assert(!app.hasAttribute('data-neko-rail-app')); assert(!doc.body.hasAttribute('data-neko-side-rail-layout'));
  assert(!original.hasAttribute('tabindex')); assert(!doc.querySelector('[data-neko-rail-fish-original]'));
  assert(!original.hasAttribute('aria-hidden'));
  assert.equal(original.parentNode, parent);
  dom.window.close(); console.log('PASS side rail order, blank region, native account ownership/focus, login updates, fish settings, homepage coalescing and cleanup');
})().catch(error => { active?.window.close(); console.error(error); process.exitCode = 1; });
