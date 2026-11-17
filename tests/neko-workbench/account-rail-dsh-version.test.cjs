'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'','node_modules/jsdom')))}catch{}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
test('rail avatar reaches the native account menu after DSH changes generated CSS class', {skip:!JSDOM}, async t=>{
  const dom=new JSDOM('<body><main><aside data-slot="sidebar"><div data-slot="settings.launcher"><button class="_5Qcc8a_trigger" aria-haspopup="menu" aria-expanded="false" data-collapsed="false" data-signed-out="true" aria-label="账号菜单"><span class="_5Qcc8a_label">更多</span></button></div></aside></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,d=w.document,base=path.resolve(__dirname,'../../apps/neko-workbench/embedded-dsh');
  const native=d.querySelector('button'),ctx={remote:{account:{getState:async()=>({ok:true,value:{status:'credential-stored',attempt:null,links:{}}}),getBalance:async()=>({ok:true,value:{status:'ready',value:[{currency:'USD',balance:'1'}],bonusWallets:[]}})}},locale:{getSnapshot:()=>({active:'en-US'})}};
  let clicks=0;native.addEventListener('click',()=>{clicks++;native.setAttribute('aria-expanded','true');const menu=d.createElement('div');menu.setAttribute('data-menu-material','translucent');menu.setAttribute('role','menu');const viewport=d.createElement('div');viewport.setAttribute('role','presentation');for(const label of ['设置','意见反馈','登录']){const item=d.createElement('button');item.setAttribute('role','menuitem');const text=d.createElement('span');text.className='_itemLabel_4ub78_190';text.textContent=label;item.appendChild(text);viewport.appendChild(item)}menu.appendChild(viewport);d.body.appendChild(menu)});
  w.eval(fs.readFileSync(path.join(base,'account-habitat-source.js'),'utf8')+'\n'+fs.readFileSync(path.join(base,'side-rail-source.js'),'utf8'));
  // A stale bridge projection must not restore the removed Codex account UI.
  const stopHabitat=w.installNekoAccountHabitat(ctx,{document:d,window:w,accountsBridge:{getAccounts:async()=>({neko:{community:{status:'signed-in',name:'合成社区账号'},lobby:{status:'signed-in'}},codex:{status:'signed-in',quota:{status:'ready',buckets:[{label:'Codex 旧额度'}]}}})},cssText:fs.readFileSync(path.join(base,'account-habitat-source.css'),'utf8'),signedOutIconSrc:'data:image/svg+xml,%3Csvg/%3E',developerAvatarSrc:'data:image/png;base64,AAAA'});
  const stopRail=w.installWorkbenchSideRail({document:d,window:w,bridge:{action:async()=>{}},openBilibiliHome:async()=>{},cssText:fs.readFileSync(path.join(base,'side-rail-source.css'),'utf8')});t.after(()=>{stopRail();stopHabitat()});await tick();
  const rail=d.querySelector('.neko-side-rail__account');assert.equal(rail.disabled,false);assert(native.hasAttribute('data-neko-account-habitat'));assert.equal(w.getComputedStyle(native.querySelector('._5Qcc8a_label')).display,'none');
  rail.click();await tick();assert.equal(clicks,1);assert.equal(rail.getAttribute('aria-expanded'),'true');
  const menu=d.querySelector('.neh-menu-card');assert.match(menu.textContent,/DSH/);assert.match(menu.textContent,/N\.E\.K\.O\. 账号/);assert.match(menu.textContent,/聊天室授权/);assert.match(menu.textContent,/合成社区账号/);
  assert.doesNotMatch(menu.textContent,/codex|旧额度/i);assert.equal(menu.querySelector('[data-neko-codex-account]'),null);
  assert.equal(d.querySelectorAll('button[role="menuitem"]').length,3,'native settings, feedback and login actions remain available');
  [...d.querySelectorAll('button[role="menuitem"]')].find(button=>button.textContent==='登录').textContent='退出登录';
  native.setAttribute('data-signed-out','false');await tick();assert.match(native.getAttribute('aria-label'),/已登录/);assert.match(rail.getAttribute('aria-label'),/已登录/);
  assert.doesNotMatch(d.querySelector('.neh-menu-card').textContent,/codex|旧额度/i,'sign-in refresh must not revive the removed account');
});
