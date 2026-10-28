'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
let JSDOM; try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const root = path.resolve(__dirname, '../../apps/neko-workbench/embedded-dsh');
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const deep = { model: 'fixture-deep', displayName: 'Fixture Deep', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'high', description: 'Thorough' }] };
const fast = { model: 'fixture-fast', displayName: 'Fixture Fast', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }] };
async function setup(t) {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></div><main><textarea>DSH draft</textarea></main></body>', { runScripts: 'outside-only', url: 'http://127.0.0.1:4321/' });
  t.after(() => dom.window.close()); const w = dom.window, doc = w.document, calls = [];
  let layout = { officeMode: 'codex', seats: [] }, officeSubscriber;
  const fixture = { models: [deep, fast], modelError: false, sendError: false, pendingSend: null, office: null, saved: {} };
  const sessions = ['existing', 'another'].map(id => ({ id, provider: 'codex', cwd: '/project', title: id }));
  const bridge = { getState: async () => ({ workspaceRoot: '/project', companion: { messages: [] } }), companion: async () => {}, subscribeOffice: fn => { officeSubscriber = fn; return () => {}; }, workspace: async r => {
    calls.push(r);
    if (r.action === 'state') return layout;
    if (r.action === 'update') return layout = { ...layout, ...r.patch };
    if (r.action === 'codex-state') return { status: 'idle', thread: null, items: [], approvals: [] };
    if (r.action === 'codex-model-choices') return fixture.saved;
    if (r.action === 'codex-model-choice') return fixture.saved[r.id] = { model: r.model, effort: r.effort };
    if (r.action === 'catalog') return { providers: { codex: 'ready' }, sessions };
    if (r.action === 'codex-models') { if (fixture.modelError) throw Error('private server detail'); return { models: fixture.models }; }
    if (r.action === 'codex-read') return { status: 'idle', thread: { ...sessions.find(s => s.id === r.id), model: 'native-saved-model' }, items: [], approvals: [] };
    if (r.action === 'codex-send') {
      if (fixture.sendError) throw Error('连接失败，请重试');
      if (fixture.pendingSend) await fixture.pendingSend;
      return fixture.office = { status: 'idle', thread: { id: r.id || 'created', cwd: r.cwd, title: 'Task', model: r.model || 'native-default' }, items: [], approvals: [] };
    }
    throw Error('Unexpected action ' + r.action);
  } };
  const sidebar = doc.querySelector('[data-slot="sidebar"]'); sidebar.getBoundingClientRect = () => ({ right: 280 });
  w.eval(fs.readFileSync(path.join(root, 'workspace-shell-source.js'), 'utf8') + '\nwindow.install=installWorkspaceShell');
  const cleanup = w.install({ document: doc, window: w, bridge, locateSidebar: () => ({ root: sidebar }), cssText: fs.readFileSync(path.join(root, 'workspace-shell-source.css'), 'utf8') }); t.after(cleanup); await tick();
  return { w, doc, calls, fixture, publish: next => officeSubscriber(next), change(selector, value) { const n = doc.querySelector(selector); n.value = value; n.dispatchEvent(new w.Event('change', { bubbles: true })); }, async send(text) { const n = doc.querySelector('.neko-office-form textarea'); n.value = text; n.dispatchEvent(new w.Event('input', { bubbles: true })); doc.querySelector('.neko-office-form').requestSubmit(); await tick(); } };
}
test('model and effort selection reaches send, stays with its thread, and a second message continues the created conversation', { skip: !JSDOM }, async t => {
  const h = await setup(t), { doc, calls } = h;
  assert.equal(doc.querySelectorAll('.neko-office-model-select option').length, 3);
  h.change('.neko-office-model-select', deep.model); h.change('.neko-office-effort-select', 'high');
  assert.match(doc.querySelector('.neko-office-form-footer').textContent, /Fixture Deep.*高/);
  await h.send('first'); let sends = calls.filter(r => r.action === 'codex-send');
  assert.equal(sends[0].model, deep.model); assert.equal(sends[0].effort, 'high'); assert.equal(sends[0].id, null);
  await h.send('second'); sends = calls.filter(r => r.action === 'codex-send'); assert.equal(sends[1].id, 'created'); assert.equal(sends[1].effort, 'high');
  doc.querySelector('.neko-workspace-session').click(); await tick();
  assert.equal(doc.querySelector('.neko-office-model-select').value, '', 'an unrelated existing conversation retains its native settings');
  h.change('.neko-office-model-select', fast.model);
  assert(![...doc.querySelector('.neko-office-effort-select').options].some(o => o.value === 'high'));
  await h.send('existing'); sends = calls.filter(r => r.action === 'codex-send'); assert.equal(sends[2].id, 'existing'); assert.equal(sends[2].model, fast.model); assert.equal(sends[2].effort, null);
  assert.equal(doc.querySelector('main textarea').value, 'DSH draft');
  assert.equal(h.fixture.saved.created.effort, 'high'); assert.equal(h.fixture.saved.existing.model, fast.model);
});
test('a missing model blocks explicit sends, retains the draft, and native default remains an explicit recovery choice', { skip: !JSDOM }, async t => {
  const h = await setup(t), { doc, fixture, calls } = h;
  h.change('.neko-office-model-select', deep.model); fixture.models = [fast];
  doc.querySelector('.neko-office-model-refresh').click(); await tick();
  assert(doc.querySelector('.neko-office-send').disabled); assert.match(doc.querySelector('.neko-office-model-status').textContent, /暂不可用/);
  await h.send('keep draft'); assert(!calls.some(r => r.action === 'codex-send')); assert.equal(doc.querySelector('.neko-office-form textarea').value, 'keep draft');
  h.change('.neko-office-model-select', ''); fixture.modelError = true; doc.querySelector('.neko-office-model-refresh').click(); await tick();
  assert.match(doc.querySelector('.neko-office-model-status').textContent, /读取失败/); assert(!doc.body.textContent.includes('private server detail'));
  assert(!doc.querySelector('.neko-office-send').disabled); await h.send('native'); assert.equal(calls.find(r => r.action === 'codex-send').model, null);
});
test('send failures preserve the message and visible error while active tasks lock model controls', { skip: !JSDOM }, async t => {
  const h = await setup(t), { doc, fixture, calls } = h; fixture.sendError = true;
  await h.send('retry me'); assert.equal(doc.querySelector('.neko-office-form textarea').value, 'retry me'); assert.match(doc.querySelector('.neko-office-error').textContent, /连接失败/);
  fixture.sendError = false; let release; fixture.pendingSend = new Promise(resolve => release = resolve);
  const running = h.send('start'); await tick(); assert(doc.querySelector('.neko-office-model-select').disabled); assert(doc.querySelector('.neko-office-send').disabled);
  release(); await running; fixture.pendingSend = null;
  h.publish({ ...fixture.office, status: 'working' }); assert(doc.querySelector('.neko-office-effort-select').disabled); assert(!doc.querySelector('.neko-office-stop').hidden);
  await h.send('must wait'); assert.equal(calls.filter(r => r.action === 'codex-send').length, 2);
  h.publish({ ...fixture.office, status: 'idle' }); assert(!doc.querySelector('.neko-office-model-select').disabled); assert.equal(doc.querySelector('.neko-office-form textarea').value, 'must wait');
});
