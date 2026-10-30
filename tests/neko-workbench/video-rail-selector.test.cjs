'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
let JSDOM; try { ({ JSDOM } = createRequire(path.join(process.env.NEKO_DOM_DEPS || __dirname, 'package.json'))('jsdom')); } catch {}
const source = fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/side-rail-source.js'),'utf8');
const tick = w => new Promise(resolve => w.setTimeout(resolve,0));
function setup(t, initial='bilibili') {
  const dom = new JSDOM('<body><div id="app"><div id="frame"><aside data-slot="sidebar"><div data-slot="settings.launcher"></div></aside><main></main></div></div></body>',{url:'http://127.0.0.1/',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(() => dom.window.close()); const w=dom.window,d=w.document,calls=[],opens=[]; let stored=initial;
  const bridge={action:async()=>{},workspace:async req=>{calls.push(req); if(req.action==='video-platform')return {platform:stored}; if(req.action==='set-video-platform'){stored=req.platform;return {platform:stored};} throw Error('unknown');}};
  w.eval(source+'\nwindow.install=installWorkbenchSideRail');
  const cleanup=w.install({window:w,document:d,bridge,openBilibiliHome:async()=>{opens.push('fallback');}});
  d.addEventListener('neko-video-open',e=>{opens.push(e.detail.platform);e.detail.handled=true;});
  return {w,d,calls,opens,bridge,cleanup,getStored:()=>stored};
}
test('video rail offers a hover menu, saves selection and opens the chosen platform', {skip:!JSDOM}, async t=>{
 const f=setup(t); await tick(f.w); const button=f.d.querySelector('[data-neko-video-entry]'), menu=f.d.querySelector('.neko-side-rail__video-menu');
 assert.equal(button.getAttribute('aria-label'),'哔哩哔哩主页'); assert(menu.hidden); button.dispatchEvent(new f.w.MouseEvent('mouseenter'));
 assert(!menu.hidden); assert.equal(button.getAttribute('aria-expanded'),'true'); assert.equal(menu.getAttribute('role'),'menu');
 const youtube=menu.querySelector('[data-platform=youtube]'); youtube.click(); await tick(f.w);
 assert.equal(f.getStored(),'youtube'); assert.equal(button.dataset.videoPlatform,'youtube'); assert.equal(button.getAttribute('aria-label'),'YouTube 视频'); assert.equal(button.title,'YouTube 视频 · 悬停选择视频平台');
 assert.equal(youtube.getAttribute('aria-checked'),'true'); assert(menu.hidden); assert.deepEqual(f.opens,['youtube']); assert.equal(f.d.activeElement,button);
 assert(button.querySelector('svg:first-child').hasAttribute('hidden')); assert(!button.querySelector('svg:last-child').hasAttribute('hidden'));
 button.click(); await tick(f.w); assert.deepEqual(f.opens,['youtube','youtube']); f.cleanup();
});
test('platform selection restores from workspace state and supports keyboard operation', {skip:!JSDOM}, async t=>{
 const f=setup(t,'youtube'); await tick(f.w); const button=f.d.querySelector('[data-neko-video-entry]'), menu=f.d.querySelector('.neko-side-rail__video-menu');
 assert.equal(button.dataset.videoPlatform,'youtube'); button.focus(); button.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
 assert(!menu.hidden); assert.equal(f.d.activeElement,menu.querySelector('[data-platform=youtube]'));
 menu.dispatchEvent(new f.w.MouseEvent('mouseleave')); await new Promise(resolve=>f.w.setTimeout(resolve,250)); assert(!menu.hidden,'pointer leaving must not hide a keyboard-focused menu');
 f.d.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); assert.equal(f.d.activeElement,menu.querySelector('[data-platform=bilibili]'));
 f.d.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); assert(menu.hidden); assert.equal(f.d.activeElement,button);
 button.dispatchEvent(new f.w.MouseEvent('mouseenter')); menu.querySelector('[data-platform=bilibili]').click(); await tick(f.w); assert.equal(f.getStored(),'bilibili'); assert.deepEqual(f.opens,['bilibili']); f.cleanup();
});
test('late restore cannot overwrite an explicit new selection', {skip:!JSDOM}, async t=>{
 const f=setup(t); await tick(f.w); f.cleanup(); let finish; f.bridge.workspace=req=>req.action==='video-platform'?new Promise(r=>{finish=r;}):Promise.resolve({platform:req.platform});
 const cleanup=f.w.install({window:f.w,document:f.d,bridge:f.bridge,openBilibiliHome:async()=>{}}); await tick(f.w);
 const button=f.d.querySelector('[data-neko-video-entry]');button.dispatchEvent(new f.w.MouseEvent('mouseenter'));f.d.querySelector('[data-platform=youtube]').click(); await tick(f.w);finish({platform:'bilibili'});await tick(f.w);
 assert.equal(button.dataset.videoPlatform,'youtube'); cleanup();
});
