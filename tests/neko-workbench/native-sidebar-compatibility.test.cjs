'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const base = path.resolve(__dirname, '../../apps/neko-workbench/embedded-dsh');
const { createWorkspaceLayout } = require('../../apps/neko-workbench/workspace-layout.cjs');
let JSDOM;
try { ({ JSDOM } = createRequire(path.join(process.env.NEKO_DOM_DEPS || base, 'package.json'))('jsdom')); } catch {}
const read = name => fs.readFileSync(path.join(base, name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

for (const hash of ['hjANda', 'A1dOCa']) test(`account adapter keeps the native ${hash} control and hides its duplicate label`, { skip: !JSDOM }, async t => {
  const dom = new JSDOM(`<body><div data-slot="settings.launcher"><button class="${hash}_trigger" aria-haspopup="menu" aria-expanded="false" data-collapsed="false" data-signed-out="true" aria-label="Native account"><span class="${hash}_avatar">avatar</span><span class="${hash}_label">Native label</span></button></div><button id="unrelated" aria-haspopup="menu">Other menu</button></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, button = d.querySelector('[data-slot] button'), parent = button.parentElement;
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  w.eval(read('account-habitat-source.js'));
  const stop = w.installNekoAccountHabitat({ remote: { account: { getState: async () => ({ ok: true, value: { status: 'signed-out' } }) } } }, { document: d, window: w, cssText: read('account-habitat-source.css') });
  t.after(stop);
  await tick();
  assert(button.querySelector('[data-neko-account-owned="launcher"]'));
  assert.equal(w.getComputedStyle(button.querySelector(`.${hash}_label`)).display, 'none');
  assert.equal(d.querySelector('#unrelated').hasAttribute('data-neko-account-habitat'), false);
  button.click();
  assert.equal(clicks, 1);
  assert.equal(button.parentElement, parent);
  button.setAttribute('data-signed-out', 'false');
  await tick();
  assert(button.querySelector('.neh-developer-avatar'));
  stop();
  assert.equal(button.getAttribute('aria-label'), 'Native account');
  assert.equal(button.hasAttribute('data-neko-account-habitat'), false);
  assert.notEqual(w.getComputedStyle(button.querySelector(`.${hash}_label`)).display, 'none');
});

test('display-contents slots reserve the real account height and retain sidebar controls across builds', { skip: !JSDOM }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-sidebar-compat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dom = new JSDOM('<body><div class="WinBuild_sidebarCol"><div data-slot="sidebar" style="display:contents"><div class="WinBuild_root"><div class="WinBuild_logoRow"><button aria-label="收起侧边栏">toggle</button></div><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div></div><div class="footer"><div data-slot="settings.launcher" style="display:contents"><button class="A1dOCa_trigger" aria-haspopup="menu">account</button></div></div></div></div><main data-neko-chat-center><textarea>native draft</textarea></main></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, root = d.querySelector('.WinBuild_root'), column = root.parentElement.parentElement, account = d.querySelector('[data-slot="settings.launcher"] button');
  const hiddenRail = d.createElement('aside');
  hiddenRail.setAttribute('data-neko-side-rail', '');
  hiddenRail.style.display = 'none';
  d.body.prepend(hiddenRail);
  w.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(node) { this.callback([{ target: node, isIntersecting: false }]); }
    disconnect() {}
  };
  let height = 44, clicks = 0;
  const resizeObservers = [];
  w.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); resizeObservers.push(this); }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  };
  root.getBoundingClientRect = () => rect(0, 0, 240, w.innerHeight);
  column.getBoundingClientRect = () => rect(0, 0, 281, w.innerHeight);
  d.querySelector('main').getBoundingClientRect = () => rect(281, 0, w.innerWidth - 281, w.innerHeight);
  account.getBoundingClientRect = () => rect(0, w.innerHeight - height, 281, height);
  d.querySelector('.WinBuild_logoRow button').addEventListener('click', () => clicks++);
  const store = createWorkspaceLayout(path.join(dir, 'layout.json'));
  const bridge = { action: async () => ({}), getState: async () => ({ workspaceRoot: '/p', workspaceRevision: 0, companion: { ready: true, messages: [] } }), companion: async () => ({}), workspace: async request => request.action === 'state' ? store.get() : request.action === 'catalog' ? { sessions: [], projects: [], providers: {} } : { items: [], approvals: [] } };
  w.eval(read('workspace-shell-source.js'));
  const stop = w.installWorkspaceShell({ document: d, window: w, bridge, cssText: read('workspace-shell-source.css'), locateSidebar: () => ({ root, slot: root.parentElement }) });
  t.after(stop);
  await tick();
  const input = d.querySelector('.neko-companion-form textarea');
  assert.equal(d.querySelector('.neko-companion-character').parentElement, d.querySelector('.neko-companion-dock'), 'an intersection miss never parks the companion in the removed rail');
  input.value = 'unsent companion draft';
  assert(root.hasAttribute('data-neko-native-sidebar'));
  assert(column.hasAttribute('data-neko-native-sidebar-column'));
  assert(d.querySelector('.WinBuild_logoRow').hasAttribute('data-neko-native-brand-row'));
  assert.equal(d.body.style.getPropertyValue('--neko-sidebar-width'), '281px');
  assert.equal(d.body.style.getPropertyValue('--neko-companion-bottom'), '44px');
  assert(resizeObservers.some(observer => observer.nodes.has(account)));
  height = 64;
  for (const observer of resizeObservers) if (observer.nodes.has(account)) observer.callback([]);
  await tick();
  assert.equal(d.body.style.getPropertyValue('--neko-companion-bottom'), '64px');
  d.querySelector('.neko-collapsed-rail__button').click();
  assert.equal(clicks, 1, 'expand proxies the native toggle without a generated CSS class');
  assert.equal(input.value, 'unsent companion draft');
  assert.equal(d.querySelector('main textarea').value, 'native draft');
  column.setAttribute('data-sidebar-collapsed', 'true');
  d.querySelector('main').removeAttribute('data-neko-chat-center');
  column.getBoundingClientRect = () => rect(0, 0, 72, w.innerHeight);
  d.querySelector('main').getBoundingClientRect = () => rect(72, 0, w.innerWidth - 72, w.innerHeight);
  w.dispatchEvent(new w.Event('resize'));
  await tick();
  assert.equal(d.body.style.getPropertyValue('--neko-companion-width'), '72px');
  assert.equal(d.body.style.getPropertyValue('--neko-companion-bottom'), '64px');
  assert.equal(input.value, 'unsent companion draft', 'collapse retains the same live draft');
  stop();
  assert.equal(root.hasAttribute('data-neko-native-sidebar'), false);
  assert.equal(column.hasAttribute('data-neko-native-sidebar-column'), false);
  assert.equal(d.querySelector('[data-neko-native-sidebar-toggle]'), null);
});
