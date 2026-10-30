'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bundle() {
  const file = path.resolve(__dirname, '../../apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js');
  let entry;
  const sandbox = { window: { __ModuleLoader__: { load(value) { entry = value; } } }, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return entry.factory(name => {
    if (name === 'react') return { createElement() {} };
    if (name === 'react-dom') return { createPortal() {} };
    throw new Error(`Unexpected dependency: ${name}`);
  });
}

test('native project files only target the current DSH session and fail closed', () => {
  const api=bundle(), button={}, calls=[];let attach, dispose, selected='s1', main='s1', target={sessionId:'s1'};
  const ctx={ uiWorkspace:{selection:{getSnapshot:()=>({sessionId:selected})},get mainReference(){return {sessionId:main}}},inject(names,callback){assert.deepEqual(Array.from(names),['sidebarRight']);attach=callback;} };
  const opener=api.createNativeFilesOpener(ctx);assert.throws(()=>opener(button),/文件目录暂不可用/);
  const sidebar={commandTarget(element){assert.equal(element,button);return target;},openTabFromTarget(kind,captured){calls.push([kind,captured]);}};
  attach({sidebarRight:sidebar,effect(effect){dispose=effect();}});opener(button,'s1');assert.deepEqual(calls,[['files',target]]);
  assert.throws(()=>opener(button,'stale'),/请先打开工作会话/);main='other';assert.throws(()=>opener(button),/请先打开工作会话/);main='s1';
  target={sessionId:'different'};assert.throws(()=>opener(button),/工作会话已切换/);target=undefined;assert.throws(()=>opener(button),/工作会话已切换/);
  dispose();assert.throws(()=>opener(button),/文件目录暂不可用/);assert(!Array.from(api.inject).includes('sidebarRight'));
});

class Styles {
  values = new Map();
  getPropertyValue(name) { return this.values.get(name)?.value || ''; }
  getPropertyPriority(name) { return this.values.get(name)?.priority || ''; }
  setProperty(name, value, priority = '') { this.values.set(name, { value, priority }); }
  removeProperty(name) { const previous = this.getPropertyValue(name); this.values.delete(name); return previous; }
}
class Element extends EventTarget {
  attributes = new Map();
  style = new Styles();
  previousElementSibling = null;
  parentElement = Object.freeze({ native: true });
  constructor(label, width = 216, tag = 'button') { super(); this.textContent = label; this.width = width; this.tag = tag; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) { return selector === this.tag; }
  querySelectorAll() { return []; }
  closest() { return null; }
  getBoundingClientRect() {
    const width = this.tag === 'button' ? Number.parseFloat(this.style.getPropertyValue('--neko-new-session-size')) || this.width : this.width;
    const top = this.tag === 'button' ? 100 : 140;
    return { left: 16, right: 16 + width, top, bottom: top + 36, width, height: 36 };
  }
  click() { return this.dispatchEvent(new Event('click')); }
}

test('new-session discovery supports the custom Chinese and English names without hashed classes', () => {
  const api = bundle();
  for (const label of ['新建会话', '新会话', '新建对话', 'New chat', 'New session', 'New conversation (Ctrl+N)']) {
    const button = new Element(label);
    button.setAttribute('aria-label', label);
    const host = new Element('', 216, 'div');
    host.setAttribute('data-neko-role-host', '');
    host.previousElementSibling = button;
    assert.equal(api.locateNewSessionButton({ nav: { previousElementSibling: host } }, host), button);
  }
  const collapse = new Element('收起侧边栏');
  assert.equal(api.locateNewSessionButton({ nav: { previousElementSibling: collapse } }, null), null, 'never change another native button');
});

test('plus and community share the native row without moving or replacing its React button', () => {
  const api = bundle();
  const host = new Element('', 216, 'div');
  const button = new Element('新建会话');
  button.setAttribute('aria-label', '新建会话');
  const parent = button.parentElement;
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  const layout = api.createSidebarActionsLayout({ host });
  assert.equal(layout.update(button), true);
  assert.equal(button.parentElement, parent);
  assert.equal(button.getAttribute('data-neko-new-session'), 'plus');
  assert.equal(button.getAttribute('aria-label'), '新建会话');
  assert.equal(button.getAttribute('title'), '新建会话');
  const native = button.getBoundingClientRect();
  const left = 16 + Number.parseFloat(host.style.getPropertyValue('--neko-community-left'));
  const top = 140 + Number.parseFloat(host.style.getPropertyValue('--neko-community-top'));
  assert.equal(top, native.top, 'both controls are on exactly the same row');
  assert.equal(left, native.right + 8);
  assert.equal(left + Number.parseFloat(host.style.getPropertyValue('--neko-community-width')), 232);
  button.click(); button.click();
  assert.equal(clicks, 2, 'original click listener is still the only owner of new-session behavior');
  assert.match(api.CSS, /data-neko-new-session="plus"[\s\S]*content: '\+'/);
  layout.release();
  assert.equal(button.getAttribute('data-neko-new-session'), null);
  assert.equal(button.getAttribute('title'), null);
  assert.equal(button.getAttribute('aria-label'), '新建会话');
  assert.equal(host.getAttribute('data-neko-actions-paired'), null);
});

test('collapsed rails keep separate non-overlapping plus and community targets, then expand cleanly', () => {
  const api = bundle();
  const host = new Element('', 216, 'div');
  const button = new Element('New chat');
  const layout = api.createSidebarActionsLayout({ host });
  for (const width of [216, 60, 40, 216]) {
    host.width = width;
    assert.equal(layout.update(button), true);
    const plus = Number.parseFloat(button.style.getPropertyValue('--neko-new-session-size'));
    const left = Number.parseFloat(host.style.getPropertyValue('--neko-community-left'));
    const community = Number.parseFloat(host.style.getPropertyValue('--neko-community-width'));
    assert(plus >= 16);
    assert(community >= 16);
    assert(left >= plus + 4);
    assert.equal(left + community, width);
  }
  layout.release();
});

test('native re-render, temporarily hidden sidebar, and repeated unload restore only owned state', () => {
  const api = bundle();
  const host = new Element('', 216, 'div');
  const old = new Element('新会话');
  old.style.setProperty('--neko-new-session-size', '42px', 'important');
  const next = new Element('New session');
  next.setAttribute('title', 'Native tooltip with shortcut');
  const layout = api.createSidebarActionsLayout({ host });
  layout.update(old);
  layout.update(next);
  assert.equal(old.getAttribute('data-neko-new-session'), null);
  assert.equal(old.getAttribute('aria-label'), null);
  assert.equal(old.style.getPropertyValue('--neko-new-session-size'), '42px');
  assert.equal(old.style.getPropertyPriority('--neko-new-session-size'), 'important');
  assert.equal(next.getAttribute('title'), 'Native tooltip with shortcut');
  host.width = 0;
  assert.equal(layout.update(next), false);
  assert.equal(next.getAttribute('data-neko-new-session'), null);
  host.width = 216;
  assert.equal(layout.update(next), true);
  layout.release(); layout.release();
  assert.equal(next.getAttribute('title'), 'Native tooltip with shortcut');
  assert.equal(next.getAttribute('aria-label'), null);
  assert.equal(host.style.values.size, 0);
});

test('unload does not erase native label or style changes made after the layout attached', () => {
  const api = bundle();
  const host = new Element('', 216, 'div');
  const button = new Element('New chat');
  const layout = api.createSidebarActionsLayout({ host });
  layout.update(button);
  button.setAttribute('aria-label', 'New conversation');
  button.setAttribute('title', 'Updated native tooltip');
  button.style.setProperty('--neko-new-session-size', '30px');
  layout.release();
  assert.equal(button.getAttribute('aria-label'), 'New conversation');
  assert.equal(button.getAttribute('title'), 'Updated native tooltip');
  assert.equal(button.style.getPropertyValue('--neko-new-session-size'), '30px');
});


test('a native clone cannot turn copied layout markers into persistent native state', () => {
  const api = bundle();
  const host = new Element('', 216, 'div');
  const clone = new Element('新建会话');
  clone.setAttribute('aria-label', '新建会话');
  clone.setAttribute('data-neko-new-session', 'plus');
  clone.style.setProperty('--neko-new-session-size', '36px');
  const layout = api.createSidebarActionsLayout({ host });
  assert.equal(layout.update(clone), true);
  layout.release();
  assert.equal(clone.getAttribute('data-neko-new-session'), null);
  assert.equal(clone.style.getPropertyValue('--neko-new-session-size'), '');
  assert.equal(clone.getAttribute('aria-label'), '新建会话');
});
