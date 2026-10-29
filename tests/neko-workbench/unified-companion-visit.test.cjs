'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const tick = () => new Promise(resolve => setTimeout(resolve, 45));
const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/unified-layout-source.js'), 'utf8');
function fixture(t, initial) {
  const dom = new JSDOM('<body><aside data-neko-side-rail><div class="neko-workspace-rail-controls"></div></aside><div id="frame" style="display:grid;grid-template-columns:220px 800px 0px"><div><aside data-slot="sidebar"><section class="neko-companion-dock"><textarea>pet draft</textarea></section><div data-slot="settings.launcher"></div></aside></div><div class="some_centerCol_HASH_42"><textarea id="draft">coding draft</textarea></div><div></div></div></body>', { runScripts:'outside-only', pretendToBeVisual:true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  d.querySelector('#frame').getBoundingClientRect = () => ({left:64,top:0,right:1084,bottom:780,width:1020,height:780});
  d.querySelector('[data-slot="sidebar"]').getBoundingClientRect = () => ({left:64,top:0,right:284,bottom:780,width:220,height:780});
  d.querySelector('.neko-companion-dock').getBoundingClientRect = () => ({left:64,top:640,right:284,bottom:730,width:220,height:90});
  let saved = {...initial}, listener = null, legacyClosed = 0;
  const calls = [];
  const bridge = {
    workspace: async r => { calls.push(r); if (r.action === 'pane-layout') return {...saved}; if (r.action === 'set-pane-layout') { saved = {...r.layout}; return {...saved}; } throw Error('bad workspace request'); },
    community: async r => { calls.push(r); return {ok:true}; },
    subscribeCommunity: fn => { listener = fn; return () => { listener = null; }; },
  };
  w.eval(source + '\nwindow.startUnified=installUnifiedLayout;');
  const cleanup = w.startUnified({document:d,window:w,bridge,hideLegacy:()=>legacyClosed++,cssText:''});
  return {w,d,calls,cleanup,get saved(){return saved},get legacyClosed(){return legacyClosed},get listener(){return listener}};
}
function visit(f) {
  const detail = {handled:false,promise:null};
  f.d.dispatchEvent(new f.w.CustomEvent('neko-unified-open-community', {detail}));
  return detail;
}
const base = {enabled:true,side:'workspace',left:'coding',right:null,ratio:0.5};
test('companion visit opens community in the sidebar and preserves coding', {skip:!JSDOM}, async t => {
  const f = fixture(t, {...base,enabled:false}); await tick();
  const event = visit(f);
  assert.equal(event.handled,true); await event.promise; await tick();
  assert.deepEqual(f.saved,{...base,enabled:false});
  assert(f.calls.some(c=>c.action==='open'&&c.slot==='side'&&c.site==='community'));
  assert.equal(f.d.querySelector('#draft').value,'coding draft');
  f.cleanup();
});
test('visit opens the sidebar without waiting on a visible companion menu or site load', {skip:!JSDOM}, async t => {
  const f = fixture(t, {...base,right:'bilibili'}); await tick();
  const menu = f.d.createElement('div'); menu.setAttribute('role','menu'); f.d.body.appendChild(menu); await tick();
  const before = f.calls.filter(c=>c.action==='open').length;
  const event = visit(f); assert.equal(event.handled,true); assert(event.promise && typeof event.promise.then==='function');
  const result = await Promise.race([event.promise.then(()=> 'resolved'),new Promise(resolve=>setTimeout(()=>resolve('timeout'),200))]);
  assert.equal(result,'resolved','menu action must complete before remote site is loaded');
  assert.deepEqual(f.saved,{...base,right:'bilibili'});
  assert.equal(f.calls.filter(c=>c.action==='open').length,before,'views remain detached until menu closes');
  menu.hidden=true; await tick(); await tick();
  assert(f.calls.some(c=>c.action==='open' && c.slot==='side' && c.site==='community'));
  assert.equal(f.d.querySelector('#draft').value,'coding draft'); assert.equal(f.d.querySelector('.neko-companion-dock textarea').value,'pet draft');
  f.cleanup();
});
test('visit retains a previously saved layout without activating it', {skip:!JSDOM}, async t => {
  const initial = {...base,side:'community',right:'bilibili'};
  const f = fixture(t, initial); await tick();
  const event = visit(f); assert.equal(event.handled,true); await event.promise; await tick();
  assert.deepEqual(f.saved,initial); assert(f.calls.some(c=>c.action==='open'&&c.slot==='side'&&c.site==='community'));
  assert.equal(f.calls.filter(c=>c.action==='open'&&c.slot!=='side').length,0);
  assert(!f.calls.some(c=>c.action==='open'&&!c.slot),'must not use legacy single-view open');
  f.cleanup();
});
test('visit does not activate a previously saved left and right split', {skip:!JSDOM}, async t => {
  const f=fixture(t,{...base,left:'bilibili',right:'coding'}); await tick();
  const event=visit(f); assert.equal(event.handled,true); await event.promise; await tick();
  assert.equal(f.saved.left,'bilibili');assert.equal(f.saved.right,'coding');
  assert(f.calls.some(c=>c.action==='open'&&c.slot==='side'&&c.site==='community'));
  f.cleanup();
});

test('shipped workbench bridge routes companion community through unified layout and falls back to legacy only when unhandled', {skip:!JSDOM}, async t => {
  const bundle = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js'), 'utf8');
  assert.match(bundle, /installWorkspaceShell\(\{[^\n]*openCommunity:\s*\(\)\s*=>\s*openWorkbenchCommunity\(\)/, 'companion and sidebar use the routed community action');
  const match = bundle.match(/function openWorkbenchCommunity\(\)\s*\{[\s\S]*?\n\s*\}/);
  assert(match, 'routed action exists in shipped bundle');
  const dom = new JSDOM('<body></body>'); t.after(() => dom.window.close());
  let legacyCalls = 0;
  const legacy = {open: async site => { legacyCalls++; assert.equal(site,'community'); return 'legacy'; }};
  const call = new Function('document','CustomEvent','currentCommunityPane', `return (${match[0]});`)(dom.window.document,dom.window.CustomEvent,legacy);
  const receive = event => { event.detail.handled=true; event.detail.promise=Promise.resolve('unified'); };
  dom.window.document.addEventListener('neko-unified-open-community',receive);
  assert.equal(await call(),'unified'); assert.equal(legacyCalls,0,'handled unified route must not open legacy pane');
  dom.window.document.removeEventListener('neko-unified-open-community',receive);
  assert.equal(await call(),'legacy'); assert.equal(legacyCalls,1,'unhandled route opens the legacy pane');
});
