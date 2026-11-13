'use strict';
// The Codex office surface is retired: saved officeMode/seats stay untouched but
// are projected onto the DSH workbench, the Codex panel is no longer mounted and
// no codex-* bridge endpoint is called. The retired model/effort picker therefore
// cannot be reached. Live model/effort selection belongs to the native DSH
// composer and is covered by native-composer-adapter.test.cjs (catalog identity,
// invalid reasoning, missing capability blocks sending), native-composer-shell /
// native-composer-ui (picker -> send gating) and native-composer-controller
// (selection acknowledgement). Draft retention on failed sends is covered there
// and by the native draft/submit fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
let JSDOM; try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const root = path.resolve(__dirname, '../../apps/neko-workbench/embedded-dsh');
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
async function setup(t) {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></div><main><textarea>DSH draft</textarea></main></body>', { runScripts: 'outside-only', url: 'http://127.0.0.1:4321/' });
  t.after(() => dom.window.close());
  const w = dom.window, doc = w.document, calls = [];
  const saved = { workbenchEdition: 'daily', officeMode: 'codex', seats: [{ id: 'seat-legacy', name: '旧 Codex 座位', provider: 'codex', projectRoot: '/project' }] };
  let layout = structuredClone(saved);
  const sessions = [{ id: 'legacy-codex', provider: 'codex', cwd: '/project', title: '旧 Codex 会话' }, { id: 'native-dsh', provider: 'dsh', cwd: '/project', title: 'DSH 会话' }];
  const bridge = {
    getState: async () => ({ workspaceRoot: '/project', companion: { messages: [] } }),
    companion: async () => {}, subscribeOffice: () => () => {},
    workspace: async request => {
      calls.push(request);
      if (request.action === 'state') return layout;
      if (request.action === 'update') return layout = { ...layout, ...request.patch };
      if (request.action === 'catalog') return { providers: { codex: 'testing', dsh: 'ready' }, sessions, projects: [{ cwd: '/project' }] };
      throw Error('Unexpected action ' + request.action);
    }
  };
  const sidebar = doc.querySelector('[data-slot="sidebar"]'); sidebar.getBoundingClientRect = () => ({ right: 280 });
  w.eval(fs.readFileSync(path.join(root, 'workspace-shell-source.js'), 'utf8') + '\nwindow.install=installWorkspaceShell');
  const cleanup = w.install({ document: doc, window: w, bridge, locateSidebar: () => ({ root: sidebar }), cssText: fs.readFileSync(path.join(root, 'workspace-shell-source.css'), 'utf8') });
  t.after(cleanup); await tick(); await tick();
  return { doc, calls, layout: () => layout, saved };
}
test('retired Codex office surface is projected onto DSH and never mounts the model picker', { skip: !JSDOM }, async t => {
  const h = await setup(t), { doc, calls } = h;
  assert.equal(doc.querySelector('.neko-office-panel'), null, 'the retired Codex panel is never mounted');
  assert.equal(doc.querySelector('.neko-office-model-select'), null, 'the retired model picker is unreachable');
  assert.equal(doc.querySelector('.neko-office-effort-select'), null, 'the retired effort picker is unreachable');
  assert.equal(doc.querySelector('.neko-office-send'), null, 'no retired Codex send control exists');
  assert.equal(doc.body.getAttribute('data-neko-office-mode'), 'dsh', 'saved codex office mode is projected to DSH for display');
  assert.equal(doc.body.getAttribute('data-neko-workbench-edition'), 'daily');
  const actions = calls.map(request => request.action);
  assert(!actions.some(action => /^codex-/.test(action)), 'no retired Codex bridge endpoint is called');
  assert.deepEqual(h.layout(), h.saved, 'saved engine, seat and session bindings are retained without rewriting');
});
test('retired Codex seats and sessions stay saved but are not selectable in the DSH workbench', { skip: !JSDOM }, async t => {
  const h = await setup(t), { doc } = h;
  assert.equal(doc.querySelectorAll('.neko-custom-seat').length, 0, 'the retired Codex seat is not shown');
  assert.equal(doc.querySelectorAll('.neko-workspace-session').length, 1, 'only the DSH session is listed');
  assert.equal(doc.querySelector('.neko-workspace-session').textContent, 'DSH 会话');
  const startup = doc.querySelector('.neko-startup');
  assert.equal(startup.querySelectorAll('.neko-startup__session').length, 1, 'the startup chooser lists only DSH sessions');
  assert(!startup.textContent.includes('旧 Codex 会话'));
  assert.equal(h.saved.seats[0].provider, 'codex', 'the retired seat binding is retained');
  assert.equal(h.layout().officeMode, 'codex', 'the saved office mode is retained');
});
