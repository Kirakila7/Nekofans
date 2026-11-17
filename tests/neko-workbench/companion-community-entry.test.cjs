'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
let JSDOM; try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function setup(t) {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div><button class="neko-side-rail__expand" hidden>展开</button></aside><section id="frame"><aside data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><footer><div data-slot="settings.launcher"></div></footer></aside></section><main></main></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close()); const w = dom.window, d = w.document, root = d.querySelector('[data-slot="sidebar"]'), fixture = { calls: 0, error: '', pending: null };
  root.getBoundingClientRect = () => ({ right: 300 });
  let community;
  const bridge = { getState: async () => ({ companion: { ready: true, messages: [] } }), companion: async () => {}, subscribeCommunity: fn => { community = fn; return () => {}; }, workspace: async r => r.action === 'state' ? { officeMode: 'dsh', seats: [] } : r.action === 'codex-state' ? { items: [], approvals: [] } : r.action === 'catalog' ? { sessions: [], providers: { dsh: 'ready' } } : {} };
  const source = path.resolve(__dirname, '../../apps/neko-workbench/embedded-dsh');
  w.eval(fs.readFileSync(path.join(source, 'workspace-shell-source.js'), 'utf8') + '\nwindow.install=installWorkspaceShell');
  const cleanup = w.install({ window: w, document: d, bridge, locateSidebar: () => ({ root }), cssText: fs.readFileSync(path.join(source, 'workspace-shell-source.css'), 'utf8'), openCommunity: async () => { fixture.calls++; if (fixture.pending) await fixture.pending; if (fixture.error) throw Error(fixture.error); community({ status: 'ready' }); } }); t.after(cleanup);
  await tick(); const dock = d.querySelector('.neko-companion-dock'), character = d.querySelector('.neko-companion-character');
  dock.getBoundingClientRect = () => ({ left: 64, right: 300, top: 500, bottom: 620, width: 236, height: 120 });
  character.getBoundingClientRect = () => ({ left: 150, right: 226, top: 500, bottom: 590, width: 76, height: 90 });
  w.dispatchEvent(new w.Event('resize')); await tick();
  const pointer = (type, x, y = 500) => { const e = new w.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(e, 'pointerId', { value: 1 }); character.dispatchEvent(e); };
  return { w, d, fixture, character, pointer, menu: d.querySelector('.neko-companion-menu'), visit: d.querySelector('.neko-companion-menu__visit'), chat: d.querySelector('.neko-companion-form textarea') };
}
test('clicking the main pet offers community visiting without changing the chat draft; keyboard and outside dismissal work', { skip: !JSDOM }, async t => {
  const h = await setup(t), { w, d, character, menu, visit, chat, fixture, pointer } = h;
  chat.value = '保留聊天草稿'; pointer('pointerdown', 180); pointer('pointerup', 180); character.click();
  assert(!menu.hidden); assert.equal(character.getAttribute('aria-expanded'), 'true'); assert.equal(fixture.calls, 0); assert.equal(d.activeElement, visit);
  visit.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); assert.equal(d.activeElement, d.querySelector('.neko-companion-menu__chat'));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert(menu.hidden); assert.equal(d.activeElement, character);
  character.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); visit.click(); await tick();
  assert.equal(fixture.calls, 1); assert(menu.hidden); assert.equal(chat.value, '保留聊天草稿');
  character.click(); d.querySelector('main').dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true })); assert(menu.hidden);
  character.click(); pointer('pointerdown', 180); pointer('pointerup', 180); character.click(); assert(menu.hidden, 'a second tap on the pet closes its menu');
});
test('dragging, dragging back to the origin, and pointer cancellation never open the visit menu', { skip: !JSDOM }, async t => {
  const { character, pointer, menu, fixture } = await setup(t);
  pointer('pointerdown', 100); pointer('pointermove', 180); pointer('pointermove', 100); pointer('pointerup', 100); character.click(); assert(menu.hidden);
  pointer('pointerdown', 100); pointer('pointermove', 100, 530); pointer('pointerup', 100, 530); character.click(); assert(menu.hidden);
  pointer('pointerdown', 100); pointer('pointercancel', 100); character.click(); assert(menu.hidden); assert.equal(fixture.calls, 0);
  pointer('pointerdown', 100); pointer('pointerup', 100); character.click(); assert(!menu.hidden);
});
test('the main pet keeps its menu and draft after restoring a collapsed sidebar and a failed community visit', { skip: !JSDOM }, async t => {
  const { d, fixture, character, menu, visit, chat } = await setup(t), frame = d.querySelector('#frame'), expand = d.querySelector('.neko-side-rail__expand');
  frame.setAttribute('data-sidebar-collapsed', 'true'); expand.hidden = false; await tick();
  assert.equal(d.querySelector('.neko-rail-companion'), null); assert.equal(character.parentElement, d.querySelector('.neko-companion-dock'));
  frame.removeAttribute('data-sidebar-collapsed'); expand.hidden = true; await tick();
  character.click(); assert(!menu.hidden); assert.equal(fixture.calls, 0, 'a click opens the main pet menu without starting a visit');
  chat.value = '继续陪我聊天'; fixture.error = '社区暂时离线'; let release; fixture.pending = new Promise(resolve => release = resolve);
  visit.click(); visit.click(); assert(visit.disabled); assert.equal(fixture.calls, 1); release(); await tick();
  assert(!menu.hidden); assert(!visit.disabled); assert.match(menu.textContent, /社区暂时离线/); assert.equal(chat.value, '继续陪我聊天');
  expand.addEventListener('click', () => { frame.removeAttribute('data-sidebar-collapsed'); expand.hidden = true; });
  d.querySelector('.neko-companion-menu__chat').click(); await tick(); assert.equal(character.parentElement, d.querySelector('.neko-companion-dock')); assert(menu.hidden); assert.equal(chat.value, '继续陪我聊天');
});
