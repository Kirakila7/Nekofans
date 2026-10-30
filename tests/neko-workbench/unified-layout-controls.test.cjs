'use strict';
// Synthetic DOM checks for the unified layout controls: divider keyboard and
// pointer behaviour, configuration dialog clarity, Escape/focus handling,
// drop-zone hover feedback, narrow-window switcher and error messaging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM; try { ({ JSDOM } = require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026', 'node_modules/jsdom'))); } catch {}
const tick = () => new Promise(resolve => setTimeout(resolve, 45));
const source = fs.readFileSync(path.join(__dirname, '../../apps/neko-workbench/embedded-dsh/unified-layout-source.js'), 'utf8');
function fixture(t, initial = {}, { width = 800, failSave = false, videoPlatform = 'bilibili', videoPlatformRequest = null, allowLegacyMultiPane = true } = {}) {
  const dom = new JSDOM(`<body><aside data-neko-side-rail><div class="neko-workspace-rail-controls"></div><button class="neko-community-yui">社区</button><button class="neko-side-rail__bilibili">B站</button></aside><div id="frame" style="display:grid;grid-template-columns:220px ${width}px 0px"><div><aside data-slot="sidebar"><section class="neko-companion-dock"><textarea>pet draft</textarea></section><div data-slot="settings.launcher"></div></aside></div><div class="some_centerCol_HASH_42"><textarea id="draft">coding draft</textarea></div><div></div></div></body>`, { runScripts:'outside-only', pretendToBeVisual:true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  d.querySelector('#frame').getBoundingClientRect = () => ({ left:64, top:0, right:284 + width, bottom:780, width:220 + width, height:780 });
  d.querySelector('[data-slot="sidebar"]').getBoundingClientRect = () => ({ left:64, top:0, right:284, bottom:780, width:220, height:780 });
  d.querySelector('.neko-companion-dock').getBoundingClientRect = () => ({ left:64, top:640, right:284, bottom:730, width:220, height:90 });
  let saved = { enabled:false, side:'workspace', left:'coding', right:null, ratio:0.5, ...initial }, listener = null, fail = failSave;
  const calls = [];
  const bridge = {
    workspace: async r => { calls.push(r); if (r.action === 'video-platform') return videoPlatformRequest ? videoPlatformRequest() : { platform:videoPlatform }; if (r.action === 'pane-layout') return { ...saved }; if (r.action === 'set-pane-layout') { if (fail) throw Error('磁盘不可写'); saved = { ...r.layout }; return { ...saved }; } throw Error('bad request'); },
    community: async r => { calls.push(r); return { ok:true }; },
    subscribeCommunity: fn => { listener = fn; return () => { listener = null; }; },
  };
  w.eval(source + '\nwindow.startUnified=installUnifiedLayout;');
  const cleanup = w.startUnified({ document:d, window:w, bridge, hideLegacy:() => {}, cssText:'', allowLegacyMultiPane });
  // These controls tests exercise the persisted multi-pane configuration after
  // the user explicitly restores it; startup itself now shows two areas.
  if (allowLegacyMultiPane && saved.enabled) w.setTimeout(() => [...d.querySelectorAll('.neko-unified-config button')].find(b => b.textContent === '恢复上次多栏布局')?.click(), 0);
  return { w, d, calls, bridge, cleanup, get saved() { return saved; }, get listener() { return listener; }, setFail(v) { fail = v; } };
}
const q = (f, s) => f.d.querySelector(s);
const key = (f, node, k, extra = {}) => node.dispatchEvent(new f.w.KeyboardEvent('keydown', { key:k, bubbles:true, cancelable:true, ...extra }));
const two = { enabled:true, side:'workspace', left:'coding', right:'community', ratio:0.5 };

test('production temporarily disables every multi-pane entry without rewriting old saved layouts', { skip:!JSDOM }, async t => {
  const old = { enabled:true, side:'workspace', left:'community', right:'coding', ratio:.6, flex:{enabled:true,rootAxis:'x',stackAxis:'y',rootRatio:.6,stackRatio:.5,slots:['social','bilibili','coding']} };
  const f = fixture(t, old, {allowLegacyMultiPane:false}); await tick(); await tick();
  assert.equal(q(f,'.neko-layout-entry'), null);
  assert.equal(q(f,'.neko-layout-presets'), null);
  assert.equal(q(f,'.neko-unified-config'), null);
  const secondCleanup = f.w.startUnified({document:f.d,window:f.w,bridge:f.bridge});
  assert.equal(f.d.querySelectorAll('[data-neko-unified-style]').length, 1, 'reinstall cannot duplicate the production controller');
  secondCleanup();
  assert.equal(f.d.body.hasAttribute('data-neko-flex-mode'), false);
  assert.equal(f.d.body.hasAttribute('data-neko-unified-enabled'), false);
  f.d.dispatchEvent(new f.w.CustomEvent('neko-unified-open-config')); await tick();
  assert.equal(q(f,'.neko-unified-config'), null, 'external settings cannot restore old layouts');
  assert.equal(f.calls.filter(c=>c.action==='set-pane-layout').length,0,'startup does not overwrite saved layouts');
  assert.equal(f.saved.flex.enabled,true); assert.equal(q(f,'#draft').value,'coding draft');
  assert.equal(q(f,'.neko-companion-dock textarea').value,'pet draft'); f.cleanup();
});

test('three-pane video entry switches B站 and YouTube in one slot, preserves other regions and opens the entered video', { skip:!JSDOM }, async t => {
  const f=fixture(t); let social=null;
  f.d.addEventListener('neko-flex-social-geometry', event=>{ if (event.detail) social=event.detail; });
  await tick(); q(f,'.neko-layout-entry').click();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click();
  await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  const original=JSON.stringify(f.saved.flex), code=q(f,'#draft');
  assert(f.calls.some(c=>c.action==='open'&&c.slot==='left'&&c.site==='bilibili'));
  assert(social && social.width>0 && social.height>0); assert.equal(code.value,'coding draft');
  const detail={platform:'youtube'};
  f.d.dispatchEvent(new f.w.CustomEvent('neko-video-open',{detail})); await tick(); await tick();
  assert.equal(detail.handled,true); assert.equal(JSON.stringify(f.saved.flex),original);
  assert(f.calls.some(c=>c.action==='open'&&c.slot==='left'&&c.site==='youtube'));
  assert.equal(code.value,'coding draft'); assert.equal(q(f,'.some_centerCol_HASH_42').getAttribute('data-neko-flex-coding'),'');
  const panel=q(f,'[data-neko-unified-slot="left"]'), input=panel.querySelector('.neko-youtube-url');
  assert.equal(panel.hidden,false); assert.match(panel.getAttribute('aria-label'),/YouTube/); assert.equal(input.hidden,false);
  assert.equal([...panel.querySelectorAll('button')].find(b=>b.textContent==='返回工作区').hidden,true,'three-pane video has no inert return action');
  assert(f.d.querySelector('.neko-flex-move[aria-label="拖动YouTube到其他区域"]'),'the drag handle names the selected provider');
  q(f,'.neko-layout-entry').click(); await tick();
  assert.match(q(f,'.neko-unified-config .summary').textContent,/YouTube/);
  assert([...f.d.querySelectorAll('.neko-flex-slot option')].some(option=>option.value==='bilibili'&&option.textContent==='YouTube'));
  q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  const send=panel.querySelector('.neko-youtube-open'); send.click();
  assert.match(panel.querySelector('.status').textContent,/粘贴/);
  assert(!f.calls.some(c=>c.action==='open-youtube-video'));
  input.value=' https://www.youtube.com/watch?v=jNQXAC9IVRw '; key(f,input,'Enter'); await tick();
  assert(f.calls.some(c=>c.action==='open-youtube-video'&&c.slot==='left'&&c.videoUrl==='https://www.youtube.com/watch?v=jNQXAC9IVRw'));
  input.value='https://www.youtube.com/playlist?list=PL1234567890abcdefgh'; send.click(); await tick();
  assert(f.calls.some(c=>c.action==='open-youtube-video'&&c.slot==='left'&&c.videoUrl==='https://www.youtube.com/playlist?list=PL1234567890abcdefgh'),'playlist is sent through the same video slot');
  const shorts=panel.querySelector('.neko-youtube-shorts'); assert(shorts && !shorts.hidden);
  shorts.click(); await tick();
  assert(f.calls.some(c=>c.action==='open-youtube-shorts'&&c.slot==='left'),'Shorts must open in the existing video slot');
  assert.equal(code.value,'coding draft'); assert.equal(JSON.stringify(f.saved.flex),original);
  f.listener({slot:'left',site:'youtube',status:'ready',tooSmall:true});
  assert.match(panel.querySelector('.status').textContent,/200\s*×\s*200/);
  f.d.dispatchEvent(new f.w.CustomEvent('neko-video-open',{detail:{platform:'bilibili'}})); await tick(); await tick();
  assert(f.calls.filter(c=>c.action==='open'&&c.slot==='left'&&c.site==='bilibili').length>=2);
  assert(f.d.querySelector('.neko-flex-move[aria-label="拖动B站视频到其他区域"]'),'switching back restores the B站 label');
  assert.equal(input.hidden,true); assert.equal(shorts.hidden,true); assert.equal(code.value,'coding draft'); assert.equal(JSON.stringify(f.saved.flex),original);
  f.cleanup();
});

test('switching video while work is collapsed retains the floating work state', { skip:!JSDOM }, async t => {
  const f=fixture(t); await tick(); q(f,'.neko-layout-entry').click();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click();
  await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  const input=q(f,'#draft'), ratio=f.saved.flex.stackRatio;
  key(f,q(f,'.neko-flex-divider'),'End'); await tick();
  assert(f.d.body.hasAttribute('data-neko-flex-workspace-collapsed'));
  const before=input.value;
  for (const platform of ['youtube','bilibili']) {
    f.d.dispatchEvent(new f.w.CustomEvent('neko-video-open',{detail:{platform}})); await tick(); await tick();
    assert(f.d.body.hasAttribute('data-neko-flex-workspace-collapsed'),platform+' must keep the work composer collapsed');
    assert(f.calls.some(c=>c.action==='open'&&c.slot==='left'&&c.site===platform),platform+' must occupy the same video slot');
    assert.equal(input.value,before); assert.equal(f.saved.flex.stackRatio,ratio);
  }
  f.d.dispatchEvent(new f.w.Event('neko-workspace-expand')); await tick();
  assert(!f.d.body.hasAttribute('data-neko-flex-workspace-collapsed'));
  assert.equal(input.value,before); f.cleanup();
});

test('saved YouTube preference restores in the existing video slot, and a late preference cannot override a new selection', { skip:!JSDOM }, async t => {
  const f=fixture(t,{}, {videoPlatform:'youtube'}); await tick();
  q(f,'.neko-layout-entry').click(); [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click();
  await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  assert(f.calls.some(c=>c.action==='open'&&c.slot==='left'&&c.site==='youtube'));
  assert.equal(f.saved.flex.slots[1],'bilibili','legacy stored video slot remains compatible'); f.cleanup();

  let resolvePreference; const pending=new Promise(resolve=>{resolvePreference=resolve;});
  const g=fixture(t,{}, {videoPlatformRequest:()=>pending}); await tick();
  q(g,'.neko-layout-entry').click(); [...g.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click();
  await tick(); q(g,'.neko-unified-config .close').click(); await tick();
  g.d.dispatchEvent(new g.w.CustomEvent('neko-video-open',{detail:{platform:'bilibili'}}));
  resolvePreference({platform:'youtube'}); await tick(); await tick();
  assert(!g.calls.some(c=>c.action==='open'&&c.site==='youtube'),'late persisted value must not undo the user selection');
  assert(g.calls.some(c=>c.action==='open'&&c.site==='bilibili')); g.cleanup();
});

test('YouTube entry opens in the ordinary sidebar without replacing the workspace draft', { skip:!JSDOM }, async t => {
  const f=fixture(t); await tick();
  f.d.dispatchEvent(new f.w.CustomEvent('neko-video-open',{detail:{platform:'youtube'}})); await tick(); await tick();
  assert(f.calls.some(c=>c.action==='open'&&c.slot==='side'&&c.site==='youtube'));
  assert.equal(f.d.body.hasAttribute('data-neko-side-social-active'),true);
  assert.equal(q(f,'#draft').value,'coding draft');
  assert.equal(q(f,'[data-neko-unified-slot="side"] .neko-youtube-url').hidden,false);
  assert.equal([...q(f,'[data-neko-unified-slot="side"]').querySelectorAll('button')].find(b=>b.textContent==='返回聊天室').hidden,false,'the functional sidebar return remains available');
  f.cleanup();
});

test('divider exposes separator semantics and supports arrow, Shift, Home and End keys', { skip:!JSDOM }, async t => {
  const f = fixture(t, two); await tick(); await tick();
  const divider = q(f, '.neko-unified-divider');
  assert.equal(divider.hidden, false);
  assert.equal(divider.getAttribute('role'), 'separator'); assert.equal(divider.getAttribute('aria-orientation'), 'vertical');
  assert.equal(divider.getAttribute('aria-valuemin'), '25'); assert.equal(divider.getAttribute('aria-valuemax'), '75');
  assert.equal(divider.getAttribute('aria-valuenow'), '50'); assert.match(divider.getAttribute('aria-valuetext'), /左面板 50%.*右面板 50%/);
  key(f, divider, 'ArrowRight'); await tick(); await tick();
  assert.equal(f.saved.ratio, 0.55); assert.equal(divider.getAttribute('aria-valuenow'), '55');
  key(f, divider, 'ArrowLeft', { shiftKey:true }); await tick(); await tick();
  assert.ok(Math.abs(f.saved.ratio - 0.45) < 1e-9, 'Shift uses a larger step');
  key(f, divider, 'Home'); await tick(); await tick(); assert.equal(f.saved.ratio, 0.25);
  key(f, divider, 'ArrowLeft'); await tick(); await tick(); assert.equal(f.saved.ratio, 0.25, 'clamped at minimum');
  key(f, divider, 'End'); await tick(); await tick(); assert.equal(f.saved.ratio, 0.75);
  assert.equal(q(f, '.some_centerCol_HASH_42').style.getPropertyValue('--neko-code-width'), '600px');
  assert.deepEqual(Object.keys(f.saved).sort(), ['enabled', 'left', 'ratio', 'right', 'side'], 'persisted schema is unchanged');
  f.cleanup();
});

test('divider pointer drag marks active state, saves once, and double-click resets to half', { skip:!JSDOM }, async t => {
  const f = fixture(t, two); await tick(); await tick();
  const divider = q(f, '.neko-unified-divider');
  const pointer = (type, x) => { const e = new f.w.Event(type, { bubbles:true, cancelable:true }); Object.assign(e, { button:0, pointerId:7, clientX:x }); divider.dispatchEvent(e); };
  const saves = () => f.calls.filter(c => c.action === 'set-pane-layout').length;
  pointer('pointerdown', 684); assert.equal(divider.dataset.dragging, 'true');
  pointer('pointerup', 684); await tick(); assert.equal(saves(), 0, 'a click without movement does not rewrite the layout');
  pointer('pointerdown', 684); pointer('pointermove', 764); pointer('pointerup', 764); await tick(); await tick();
  assert.equal(divider.hasAttribute('data-dragging'), false); assert.equal(saves(), 1); assert.equal(f.saved.ratio, 0.6);
  divider.dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles:true })); await tick(); await tick();
  assert.equal(f.saved.ratio, 0.5);
  f.cleanup();
});

test('configuration dialog states what each region shows and updates the summary live', { skip:!JSDOM }, async t => {
  const f = fixture(t); await tick();
  const trigger = q(f, '.neko-layout-entry'), config = q(f, '.neko-unified-config');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog'); assert.equal(trigger.getAttribute('aria-controls'), config.id);
  assert.equal(config.getAttribute('aria-labelledby'), 'neko-unified-config-title');
  trigger.click(); await tick();
  assert.equal(config.hidden, false); assert.equal(f.d.activeElement, q(f, '[data-target="left"]'), 'focus moves into the dialog');
  const summary = q(f, '[data-neko-unified-summary]');
  assert.match(summary.textContent, /默认显示侧栏与工作区/);
  assert.equal(q(f, '[data-target="side"] .current').textContent, '工作区导航');
  assert.equal(q(f, '[data-target="left"] .current').textContent, '空');
  assert.equal(q(f, '[data-target="right"] .current').textContent, '工作区');
  assert.equal(q(f, '[data-target="right"]').getAttribute('aria-label'), '右面板，当前显示工作区');
  q(f, '[data-target="right"]').click(); q(f, '[data-content="bilibili"]').click(); await tick(); await tick();
  assert.equal(f.saved.right, 'bilibili');
  assert.match(summary.textContent, /侧栏：工作区导航 · 左面板：工作区 · 右面板：B站视频（宽度 50% \/ 50%）/);
  assert.equal(q(f, '[data-target="right"] .current').textContent, 'B站视频');
  q(f, '[data-target="side"]').click(); assert.equal(q(f, '[data-content="coding"]').textContent, '工作区导航');
  assert.equal(q(f, '[data-content="none"]').hidden, true, 'the sidebar cannot be emptied');
  assert.match(q(f, '.neko-unified-config .hint').textContent, /账号和角色生活区/);
  f.cleanup();
});

test('"不显示" empties one main pane but always keeps another pane', { skip:!JSDOM }, async t => {
  const f = fixture(t, { ...two, right:'bilibili' }); await tick();
  q(f, '.neko-layout-entry').click(); await tick();
  q(f, '[data-target="right"]').click();
  const none = q(f, '[data-content="none"]'); assert.equal(none.disabled, false);
  none.click(); await tick(); await tick();
  assert.equal(f.saved.right, null); assert.equal(f.saved.left, 'coding');
  assert.equal(none.getAttribute('aria-pressed'), 'true');
  q(f, '[data-target="left"]').click(); assert.equal(none.disabled, true, 'last remaining pane cannot be cleared');
  assert.match(none.title, /至少保留一个面板/);
  assert.equal(q(f, '.neko-unified-config .toggle').disabled, false);
  f.cleanup();
});

test('Escape closes the dialog and returns focus to the trigger; close button does too', { skip:!JSDOM }, async t => {
  const f = fixture(t, two); await tick();
  const trigger = q(f, '.neko-layout-entry'), config = q(f, '.neko-unified-config');
  trigger.click(); await tick(); assert.equal(config.hidden, false); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  key(f, q(f, '[data-target="right"]'), 'Escape'); await tick();
  assert.equal(config.hidden, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(f.d.activeElement, trigger);
  trigger.click(); await tick(); q(f, '.neko-unified-config .close').click(); await tick();
  assert.equal(config.hidden, true); assert.equal(f.d.activeElement, trigger);
  trigger.click(); await tick();
  const draft = q(f, '#draft'); draft.focus(); key(f, draft, 'Escape'); await tick();
  assert.equal(config.hidden, true); assert.equal(f.d.activeElement, draft, 'Escape from DSH input keeps the user\'s focus');
  assert.equal(draft.value, 'coding draft');
  f.cleanup();
});

test('settings opens layout configuration and focus returns to the settings entry', { skip:!JSDOM }, async t => {
  const f = fixture(t); await tick();
  const entry = f.d.createElement('button'); entry.className = 'neko-workspace-settings'; entry.textContent = '设置';
  q(f, '.neko-workspace-rail-controls').appendChild(entry);
  f.d.dispatchEvent(new f.w.CustomEvent('neko-unified-open-config', { detail:{ returnFocus:entry } })); await tick();
  assert.equal(q(f, '.neko-unified-config').hidden, false);
  assert.equal(f.d.activeElement, q(f, '[data-target="left"]'));
  key(f, f.d.activeElement, 'Escape'); await tick();
  assert.equal(q(f, '.neko-unified-config').hidden, true);
  assert.equal(f.d.activeElement, entry);
  f.cleanup();
  f.d.dispatchEvent(new f.w.CustomEvent('neko-unified-open-config', { detail:{ returnFocus:entry } }));
  assert.equal(q(f, '.neko-unified-config'), null, 'unloaded controller does not recreate the dialog');
});

test('drop zones show current content and highlight only while hovered', { skip:!JSDOM }, async t => {
  const f = fixture(t, two); await tick(); q(f, '.neko-layout-entry').click(); await tick();
  const start = new f.w.Event('dragstart', { bubbles:true }); Object.defineProperty(start, 'dataTransfer', { value:{ setData() {}, effectAllowed:'' } });
  q(f, '[data-content="bilibili"]').dispatchEvent(start);
  const zone = q(f, '[data-neko-drop-slot="right"]');
  assert.equal(zone.hidden, false); assert.match(zone.textContent, /放到右面板/); assert.match(zone.textContent, /当前：社区/);
  const over = new f.w.Event('dragenter', { bubbles:true, cancelable:true }); zone.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true); assert.equal(zone.dataset.active, 'true');
  zone.dispatchEvent(new f.w.Event('dragleave', { bubbles:true })); assert.equal(zone.hasAttribute('data-active'), false);
  zone.dispatchEvent(new f.w.Event('dragenter', { bubbles:true, cancelable:true }));
  q(f, '[data-content="bilibili"]').dispatchEvent(new f.w.Event('dragend', { bubbles:true }));
  assert.equal(zone.hidden, true); assert.equal(zone.hasAttribute('data-active'), false, 'cancelled drag clears highlight');
  f.cleanup();
});

test('narrow window switcher reports pressed state and the content of each pane', { skip:!JSDOM }, async t => {
  const f = fixture(t, two, { width:500 }); await tick(); await tick();
  const mobile = q(f, '.neko-unified-mobile'), [left, right] = mobile.querySelectorAll('button');
  assert.equal(mobile.hidden, false); assert.equal(q(f, '.neko-unified-divider').hidden, true);
  assert.equal(left.getAttribute('aria-pressed'), 'true'); assert.equal(right.getAttribute('aria-pressed'), 'false');
  assert.equal(left.getAttribute('aria-label'), '左面板：工作区'); assert.equal(right.getAttribute('aria-label'), '右面板：社区');
  right.click(); await tick(); await tick();
  assert.equal(right.getAttribute('aria-pressed'), 'true'); assert.equal(left.getAttribute('aria-pressed'), 'false');
  assert(f.calls.some(c => c.action === 'open' && c.slot === 'right' && c.site === 'community'));
  assert.equal(q(f, '.some_centerCol_HASH_42').getAttribute('data-neko-unified-coding'), 'hidden');
  assert.equal(q(f, '#draft').value, 'coding draft');
  f.cleanup();
});

test('failed save restores the confirmed layout and shows a visible notice', { skip:!JSDOM }, async t => {
  const f = fixture(t, two); await tick(); await tick();
  f.setFail(true);
  const divider = q(f, '.neko-unified-divider'), notice = q(f, '.neko-unified-notice');
  key(f, divider, 'ArrowRight'); await tick(); await tick();
  assert.equal(f.saved.ratio, 0.5); assert.equal(divider.getAttribute('aria-valuenow'), '50', 'divider returns to saved position');
  assert.equal(notice.hidden, false); assert.match(notice.textContent, /未能保存.*磁盘不可写/);
  q(f, '.neko-layout-entry').click(); await tick(); assert.equal(notice.hidden, true, 'dialog takes over messaging');
  q(f, '[data-target="right"]').click(); q(f, '[data-content="bilibili"]').click(); await tick(); await tick();
  assert.equal(f.saved.right, 'community'); assert.match(q(f, '.neko-unified-config .message').textContent, /未能保存/);
  assert.equal(q(f, '[data-target="right"] .current').textContent, '社区', 'dialog shows the saved, not the attempted, layout');
  f.setFail(false); q(f, '[data-content="bilibili"]').click(); await tick(); await tick();
  assert.equal(f.saved.right, 'bilibili'); assert.equal(q(f, '.neko-unified-config .message').textContent, '');
  f.cleanup();
});

test('panel header shows load, error and copy feedback above the native view', { skip:!JSDOM }, async t => {
  const f = fixture(t, { ...two, right:'bilibili' }); await tick(); await tick();
  const panel = q(f, '[data-neko-unified-slot="right"]'), note = panel.querySelector('header .note');
  assert.equal(panel.hidden, false); assert.equal(panel.getAttribute('aria-label'), '右面板：B站视频');
  assert.equal(panel.dataset.state, 'loading'); assert.match(note.textContent, /正在加载B站视频/);
  f.listener({ slot:'right', site:'bilibili', status:'ready', canShare:true, canPlayOfficial:true }); assert.equal(note.textContent, ''); assert.equal(panel.hasAttribute('data-state'), false);
  f.listener({ slot:'right', site:'bilibili', status:'error' }); assert.equal(panel.dataset.state, 'error'); assert.match(note.textContent, /刷新/);
  f.listener({ slot:'right', site:'bilibili', status:'ready' });
  [...panel.querySelectorAll('header button')].find(b => b.textContent === '分享').click(); await tick();
  assert.equal(panel.dataset.state, 'ok'); assert.match(note.textContent, /链接已复制/);
  [...panel.querySelectorAll('header button')].find(b => b.textContent === '刷新').click();
  assert.match(note.textContent, /正在刷新/);
  assert(f.calls.some(c => c.action === 'reload' && c.slot === 'right'));
  f.cleanup();
});


async function waitFor(predicate, message) {
  const until = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > until) throw Error(message || 'timed out waiting for state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const frame = f => new Promise(resolve => f.w.requestAnimationFrame(() => resolve()));

test('cancelled and tiny divider drags restore the saved ratio before later changes', { skip:!JSDOM }, async t => {
  const f = fixture(t, two), divider = q(f, '.neko-unified-divider');
  await waitFor(() => divider.getAttribute('aria-valuenow') === '50');
  const pointer = (type, x) => { const e = new f.w.Event(type, { bubbles:true, cancelable:true }); Object.assign(e, { button:0, pointerId:7, clientX:x }); divider.dispatchEvent(e); };
  pointer('pointerdown', 684); pointer('pointermove', 764);
  await waitFor(() => divider.getAttribute('aria-valuenow') === '60');
  pointer('pointercancel', 764);
  await waitFor(() => divider.getAttribute('aria-valuenow') === '50');
  pointer('pointerdown', 684); pointer('pointermove', 690); pointer('pointerup', 690);
  await frame(f); await frame(f);
  assert.equal(divider.getAttribute('aria-valuenow'), '50');
  assert.equal(f.calls.filter(c => c.action === 'set-pane-layout').length, 0);
  q(f, '.neko-layout-entry').click(); q(f, '[data-target="right"]').click(); q(f, '[data-content="bilibili"]').click();
  await waitFor(() => f.saved.right === 'bilibili');
  assert.equal(f.saved.ratio, 0.5, 'subsequent changes do not persist a cancelled drag');
  f.cleanup();
});

test('failed overlapping save reloads durable layout even if prior acknowledgement is delayed', { skip:!JSDOM }, async t => {
  const f = fixture(t), original = f.bridge.workspace;
  await waitFor(() => f.calls.some(c => c.action === 'pane-layout'));
  let release, writes = 0;
  f.bridge.workspace = async r => {
    if (r.action !== 'set-pane-layout') return original(r);
    writes++;
    if (writes === 1) { const result = await original(r); await new Promise(resolve => { release = resolve; }); return result; }
    throw Error('磁盘不可写');
  };
  q(f, '.neko-layout-entry').click(); q(f, '[data-target="right"]').click(); q(f, '[data-content="community"]').click();
  await waitFor(() => !!release && f.saved.right === 'community');
  q(f, '[data-content="bilibili"]').click();
  await waitFor(() => /未能保存/.test(q(f, '.neko-unified-config .message').textContent));
  assert.equal(q(f, '[data-target="right"] .current').textContent, '社区');
  assert.equal(f.d.body.hasAttribute('data-neko-unified-enabled'), true, 'restoration applies enabled state');
  release(); await frame(f); await frame(f);
  assert.equal(f.saved.right, 'community');
  assert.equal(q(f, '[data-target="right"] .current').textContent, '社区');
  f.cleanup();
});

test('failed save falls back to the acknowledged layout if reading it also fails', { skip:!JSDOM }, async t => {
  const f = fixture(t, two), original = f.bridge.workspace;
  await waitFor(() => q(f, '.neko-unified-divider').getAttribute('aria-valuenow') === '50');
  f.bridge.workspace = async r => { if (r.action === 'set-pane-layout' || r.action === 'pane-layout') throw Error('磁盘不可读写'); return original(r); };
  key(f, q(f, '.neko-unified-divider'), 'ArrowRight');
  await waitFor(() => !q(f, '.neko-unified-notice').hidden);
  await frame(f);
  assert.equal(q(f, '.neko-unified-divider').getAttribute('aria-valuenow'), '50');
  assert.equal(f.saved.ratio, 0.5);
  f.cleanup();
});

test('three-pane preset preserves the coding draft, swaps all content slots and resizes both axes', { skip:!JSDOM }, async t => {
  const f=fixture(t); await tick(); q(f,'.neko-layout-entry').click(); await tick();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click(); await tick();
  assert.deepEqual(Array.from(f.saved.flex.slots), ['social','bilibili','coding']);
  q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  const code=q(f,'.some_centerCol_HASH_42'); assert.equal(q(f,'#draft').value,'coding draft');
  assert.equal(code.getAttribute('data-neko-flex-coding'),'');
  assert.equal(code.style.getPropertyValue('--neko-flex-x'),'625px');
  assert.equal(code.style.getPropertyValue('--neko-flex-y'),'390px');
  assert(f.calls.some(c=>c.action==='open' && c.site==='bilibili' && c.bounds.y>=0));
  key(f,q(f,'.neko-unified-divider'),'ArrowRight'); await tick(); await tick();
  assert.equal(f.saved.flex.rootRatio,.56);
  key(f,q(f,'.neko-flex-divider'),'ArrowDown'); await tick(); await tick();
  assert.equal(f.saved.flex.stackRatio,.51);
  q(f,'.neko-layout-entry').click(); await tick();
  const sel=q(f,'.neko-flex-slot select'); sel.value='coding'; sel.dispatchEvent(new f.w.Event('change',{bubbles:true})); await tick();
  assert.deepEqual(Array.from(f.saved.flex.slots), ['coding','bilibili','social']);
  q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  assert.equal(code.style.getPropertyValue('--neko-flex-x'),'64px');
  assert.equal(q(f,'#draft').value,'coding draft'); f.cleanup();
});

test('three-pane handles drag any content into another region without changing drafts', { skip:!JSDOM }, async t => {
  const f=fixture(t); await tick(); q(f,'.neko-layout-entry').click(); await tick();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click(); await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  const handles=[...f.d.querySelectorAll('.neko-flex-move')], drops=[...f.d.querySelectorAll('.neko-flex-drop')];
  const start=handles.find(n=>n.getAttribute('aria-label').includes('聊天室')), target=drops.find(n=>n.textContent==='工作区');
  const loadingDrag = new f.w.Event('dragstart',{bubbles:true,cancelable:true}); start.dispatchEvent(loadingDrag); assert(loadingDrag.defaultPrevented); assert(target.hidden, 'loading B站 is not hidden or disposed by a drag');
  f.listener({slot:'left',site:'bilibili',status:'ready'});
  start.dispatchEvent(new f.w.Event('dragstart',{bubbles:true,cancelable:true}));
  assert.equal(target.hidden,false); target.dispatchEvent(new f.w.Event('drop',{bubbles:true,cancelable:true})); await tick(); await tick();
  assert.deepEqual(Array.from(f.saved.flex.slots),['coding','bilibili','social']);
  assert.equal(q(f,'#draft').value,'coding draft'); assert.equal(q(f,'.neko-companion-dock textarea').value,'pet draft');
  assert(target.hidden); f.cleanup();
});


test('three-pane social shortcuts preserve the layout and switch only the social region', { skip:!JSDOM }, async t => {
  const f=fixture(t); await tick(); q(f,'.neko-layout-entry').click(); await tick();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click(); await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  const saved=JSON.stringify(f.saved.flex), code=q(f,'#draft');
  q(f,'.neko-community-yui').click(); await tick(); await tick();
  assert.equal(JSON.stringify(f.saved.flex),saved); assert(f.calls.some(c=>c.action==='open' && c.site==='community' && c.slot==='side'));
  assert(f.calls.some(c=>c.action==='open' && c.site==='bilibili' && c.slot==='left'));
  q(f,'.neko-side-rail__bilibili').click(); await tick(); await tick();
  assert.equal(JSON.stringify(f.saved.flex),saved); assert.equal(f.d.body.hasAttribute('data-neko-flex-mode'),true); assert.equal(code.value,'coding draft');
  assert(f.calls.some(c=>c.action==='hide' && c.slot==='side')); f.cleanup();
});

test('enabling or restoring the three-pane layout expands a collapsed sidebar even when chatroom is active', {skip:!JSDOM}, async t => {
  const f=fixture(t); await tick(); let expanded=0;
  const expand=f.d.createElement('button'); expand.className='neko-side-rail__expand'; expand.addEventListener('click',()=>{expanded++;expand.hidden=true;}); f.d.querySelector('[data-neko-side-rail]').appendChild(expand);
  f.d.body.setAttribute('data-neko-chatroom-active',''); q(f,'.neko-layout-entry').click(); await tick();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click(); await tick();
  assert.equal(expanded,1); assert.equal(f.saved.flex.enabled,true); f.cleanup();
});

test('rapid adjustments to both split axes preserve both saved ratios', {skip:!JSDOM}, async t => {
  const f=fixture(t); await tick(); q(f,'.neko-layout-entry').click(); await tick();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左侧聊天室 / 右侧上下').click(); await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  key(f,q(f,'.neko-unified-divider'),'ArrowRight'); key(f,q(f,'.neko-flex-divider'),'ArrowDown');
  await tick(); await tick(); assert.equal(f.saved.flex.rootRatio,.56); assert.equal(f.saved.flex.stackRatio,.51);
  f.cleanup();
});

test('same-axis extreme ratios retain visible video and accommodate the chat footer', {skip:!JSDOM}, async t => {
  const f=fixture(t); await tick(); let social;
  f.d.addEventListener('neko-flex-social-geometry',e=>{ if(e.detail) social=e.detail; });
  const footer=f.d.createElement('div'); footer.setAttribute('data-neko-companion-footer',''); footer.getBoundingClientRect=()=>({height:260}); f.d.body.appendChild(footer);
  q(f,'.neko-layout-entry').click(); await tick();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='上下排列').click(); await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  key(f,q(f,'.neko-unified-divider'),'Home'); await tick(); await tick();
  for (let i=0; i<8; i++) { key(f,q(f,'.neko-flex-divider'),'ArrowDown',{shiftKey:true}); await tick(); }
  assert(social.height>=340, 'chat room leaves space for its current footer plus content');
  const video=f.calls.filter(c=>['open','layout'].includes(c.action)&&c.site==='bilibili'||c.action==='layout'&&c.slot==='left').at(-1);
  assert(video && video.bounds.height>=118, 'video retains a usable height beneath its header');
  assert.equal(f.saved.flex.rootRatio,.15); assert.equal(f.saved.flex.stackRatio,.85);
  f.cleanup();
});

test('small windows switch safely between single regions and restore the saved layout when enlarged', {skip:!JSDOM}, async t => {
  const f=fixture(t); await tick(); q(f,'.neko-layout-entry').click(); await tick();
  [...f.d.querySelectorAll('.neko-flex-config button')].find(b=>b.textContent==='左右排列').click(); await tick(); q(f,'.neko-unified-config .close').click(); await tick(); await tick();
  const saved=JSON.stringify(f.saved.flex), frame=q(f,'#frame');
  frame.getBoundingClientRect=()=>({left:64,top:0,right:464,bottom:450,width:400,height:450}); f.w.dispatchEvent(new f.w.Event('resize')); await tick(); await tick();
  const tabs=q(f,'.neko-flex-tabs'); assert.equal(tabs.hidden,false); assert.equal(q(f,'.neko-flex-divider').hidden,true);
  [...tabs.querySelectorAll('button')].find(b=>b.textContent==='工作区').click(); await tick(); await tick();
  assert.equal(f.d.body.hasAttribute('data-neko-flex-social-hidden'),true); assert.equal(q(f,'#draft').value,'coding draft');
  assert.equal(q(f,'.some_centerCol_HASH_42').getAttribute('data-neko-unified-coding'),'');
  q(f,'.neko-side-rail__bilibili').click(); await tick(); await tick();
  assert.equal([...tabs.querySelectorAll('button')].find(b=>b.textContent==='B站').getAttribute('aria-pressed'),'true');
  assert(f.calls.some(c=>c.action==='open'&&c.site==='bilibili'));  assert.equal(JSON.stringify(f.saved.flex),saved);
  frame.getBoundingClientRect=()=>({left:64,top:0,right:1084,bottom:780,width:1020,height:780}); f.w.dispatchEvent(new f.w.Event('resize')); await tick(); await tick();
  assert(tabs.hidden); assert.equal(f.d.body.hasAttribute('data-neko-flex-social-hidden'),false); assert.equal(JSON.stringify(f.saved.flex),saved); assert.equal(q(f,'#draft').value,'coding draft');
  f.cleanup();
});
