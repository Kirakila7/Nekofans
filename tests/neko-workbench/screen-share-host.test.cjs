'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const deps=process.env.NEKO_DOM_DEPS;
test('side rail and workbench navigation pause sharing; the screen entry itself stays usable',{skip:!deps},async t=>{
 const {JSDOM}=createRequire(path.join(deps,'package.json'))('jsdom');
 const dom=new JSDOM(`<!doctype html><body>
  <aside class="neko-side-rail" data-neko-side-rail><div class="neko-side-rail__theme"><button class="neko-side-rail__button neko-office-switch" aria-label="切换工作界面"><img></button></div>
  <div class="neko-workspace-rail-controls"><button class="neko-side-rail__button neko-workspace-settings" aria-label="工作台设置"><span>⚙</span></button><button class="neko-side-rail__button neko-community-yui" aria-label="社区"><svg><path></path></svg></button></div>
  <nav class="neko-side-rail__bottom"><button class="neko-side-rail__account" aria-label="账号与额度"></button><button class="neko-side-rail__fish" aria-label="养鱼界面"></button></nav></aside>
  <div data-slot="sidebar"><button>项目</button><button class="neko-action">屏幕陪伴</button><button class="other">退出屏幕陪伴</button></div>
  <div class="neko-strip"><button data-workbench-action="screen-share">屏幕陪伴</button></div><main><button>发送</button></main></body>`,{runScripts:'outside-only'});
 t.after(()=>dom.window.close());const w=dom.window,calls=[];
 w.nekoWorkbench={screenShare:async value=>calls.push(value)};
 const source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/screen-share-host.js'),'utf8');w.eval(source);w.eval(source);
 const click=selector=>w.document.querySelector(selector).dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
 for(const selector of ['.neko-office-switch img','.neko-workspace-settings span','.neko-community-yui path','.neko-side-rail__account','.neko-side-rail__fish','[data-slot="sidebar"] button'])click(selector);
 assert.deepEqual(calls,['hide','hide','hide','hide','hide','hide']);
 click('.neko-action');click('[data-workbench-action="screen-share"]');click('main button');assert.equal(calls.length,6);
 click('.other');assert.equal(calls.length,7,'other controls mentioning screen sharing still pause');
});
