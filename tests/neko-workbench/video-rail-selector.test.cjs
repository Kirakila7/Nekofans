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
test('video rail opens Bilibili directly without a platform selector', {skip:!JSDOM}, async t=>{
 const f=setup(t);await tick(f.w);const button=f.d.querySelector('[data-neko-video-entry]');
 assert.equal(button.getAttribute('aria-label'),'哔哩哔哩主页');assert(!button.hasAttribute('aria-haspopup'));button.dispatchEvent(new f.w.MouseEvent('mouseenter'));assert(!f.d.querySelector('.neko-side-rail__video-menu'));assert(!f.d.querySelector('[data-platform=youtube]'));
 button.click();await tick(f.w);assert.deepEqual(f.opens,['bilibili']);f.cleanup();
});
test('a legacy YouTube preference cannot restore a removed entry or alter saved user state', {skip:!JSDOM}, async t=>{
 const f=setup(t,'youtube');await tick(f.w);const button=f.d.querySelector('[data-neko-video-entry]');assert.equal(button.dataset.videoPlatform,'bilibili');button.click();await tick(f.w);assert.deepEqual(f.opens,['bilibili']);assert.equal(f.getStored(),'youtube');assert.equal(f.calls.length,0);assert(!f.d.querySelector('[data-neko-side-rail]').textContent.includes('YouTube'));f.cleanup();
});
