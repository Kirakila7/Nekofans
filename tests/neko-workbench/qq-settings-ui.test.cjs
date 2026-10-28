'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {execFileSync}=require('node:child_process');
const deps=process.env.NEKO_DOM_DEPS;

// Optional UI harness: run with NEKO_DOM_DEPS pointing at a directory with
// React 18, react-dom and jsdom. Production has no dependency on this folder.
test('QQ settings start only on request and reuse the official binding panel', {skip:!deps}, async()=>{
  const req=createRequire(path.join(deps,'package.json'));
  const {JSDOM}=req('jsdom'),React=req('react'),{createRoot}=req('react-dom/client'),{act}=req('react');
  const dom=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'http://127.0.0.1/'});
  const previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
  global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
  const actions=[];
  const states={status:{enabled:false,phase:'paused',reason:'未启动'},start:{enabled:false,phase:'error',reason:'连接失败'},pause:{enabled:false,phase:'paused',reason:'已暂停'}};
  window.nekoWorkbench={qqbot:async(action)=>{actions.push(action);return states[action]}};
  let entry;window.__ModuleLoader__={load(value){entry=value}};
  const source=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/vendor/dsh-bili-whale/lib/client.js'),'utf8');
  vm.runInThisContext(source,{filename:'fish-client.js'});
  let officialMounted=0;
  function OfficialPanel(){officialMounted++;return React.createElement('div',{'data-testid':'qq-official'},'官方绑定与设置');}
  let qqModuleReady=false;
  const fakeRequire=(id)=>id==='react'?React:id==='react-dom'?req('react-dom'):id==='@bigfish/qqbot-settings'&&qqModuleReady?{QQBotSettingsSection:OfficialPanel}:(()=>{throw Error('module not loaded: '+id)})();
  const ui=entry.factory(fakeRequire),root=createRoot(document.getElementById('root'));
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  try{
    await act(async()=>{root.render(React.createElement(ui.QQBotSettings));await settle()});
    assert.deepEqual(actions,['status']);assert.equal(officialMounted,0);
    let button=document.querySelector('button');assert.equal(button.textContent,'开始连接 QQ');
    await act(async()=>{button.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await settle()});
    assert.deepEqual(actions,['status','start']);assert.equal(document.querySelector('[data-testid="qq-official"]'),null);
    assert.match(document.querySelector('[role="status"]').textContent,/连接失败/);
    states.start={enabled:true,phase:'running',reason:'插件已启动'};
    await act(async()=>{button.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await settle()});
    assert.deepEqual(actions,['status','start','start']);
    let script=document.querySelector('script[src="/qqbot-workbench/client.js"]');assert.ok(script);
    assert.equal(document.querySelector('[data-testid="qq-official"]'),null);
    await act(async()=>{script.dispatchEvent(new window.Event('error'));await settle()});
    const retry=[...document.querySelectorAll('button')].find(node=>node.textContent==='重试 QQ 设置');assert.ok(retry);
    await act(async()=>{retry.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await settle()});
    script=document.querySelector('script[src="/qqbot-workbench/client.js"]');assert.ok(script);
    qqModuleReady=true;
    await act(async()=>{script.dispatchEvent(new window.Event('load'));await settle()});
    assert.ok(document.querySelector('[data-testid="qq-official"]'));
    assert.equal(document.querySelector('button').textContent,'暂停 QQ 机器人');
    await act(async()=>{document.querySelector('button').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await settle()});
    assert.deepEqual(actions,['status','start','start','pause']);assert.equal(document.querySelector('[data-testid="qq-official"]'),null);
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    global.window=previous.window;global.document=previous.document;global.IS_REACT_ACT_ENVIRONMENT=previous.act;
  }
});

test('real bundled QQ panel renders inside workbench settings against a simulated host', {skip:!deps}, async()=>{
  const req=createRequire(path.join(deps,'package.json'));
  const {JSDOM}=req('jsdom'),React=req('react'),{createRoot}=req('react-dom/client'),{act}=req('react');
  const archive=path.join(__dirname,'../../apps/neko-workbench/vendor/dsh-qqbot-workbench/upstream/tencent-connect-dsh-qqbot-0.5.3.tgz');
  const dom=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'http://127.0.0.1/'});
  const previous={window:global.window,document:global.document,fetch:global.fetch,act:global.IS_REACT_ACT_ENVIRONMENT};
  global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
  const actions=[],requests=[];
  window.nekoWorkbench={qqbot:async(action)=>{actions.push(action);return action==='status'?{enabled:false,phase:'paused'}:{enabled:true,phase:'running'}}};
  global.fetch=async(url)=>{requests.push(String(url));return {ok:true,status:200,json:async()=>String(url).endsWith('/config')?{config:{access:{c2cMode:'disabled',c2cAllow:[],groupMode:'disabled',groupAllow:[]}}}:{phase:'waiting',qrSvg:'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',url:'https://example.test/bind'}}};
  let entries={};window.__ModuleLoader__={load(value){entries[value.id]=value}};
  const fish=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/vendor/dsh-bili-whale/lib/client.js'),'utf8');
  const official=execFileSync('tar',['-xOf',archive,'package/lib/client.js'],{encoding:'utf8'})
    .replace('id: "@tencent-connect/dsh-qqbot"','id: "@bigfish/qqbot-settings"')
    .replace('exports.apply = apply;','exports.QQBotSettingsSection = QQBotSettingsSection;\n\t\texports.apply = apply;');
  assert.match(official,/id: "@bigfish\/qqbot-settings"/);assert.match(official,/exports\.QQBotSettingsSection = QQBotSettingsSection/);
  vm.runInThisContext(fish,{filename:'fish-client.js'});vm.runInThisContext(official,{filename:'qq-settings-client.js'});
  let qqModule;
  const runtimeRequire=id=>id==='react'?React:id==='react-dom'?req('react-dom'):id==='@bigfish/qqbot-settings'?(qqModule??=entries[id].factory(runtimeRequire)):(()=>{throw Error('unexpected '+id)})();
  const ui=entries['dsh-bili-whale'].factory(runtimeRequire),root=createRoot(document.getElementById('root'));
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  try{
    await act(async()=>{root.render(React.createElement(ui.QQBotSettings));await settle()});
    assert.deepEqual(actions,['status']);assert.equal(requests.length,0);
    await act(async()=>{document.querySelector('button').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await settle();await settle()});
    assert.deepEqual(actions,['status','start']);
    assert.ok(requests.includes('/qqbot/im-qqbot/bind'));assert.ok(requests.includes('/qqbot/im-qqbot/config'));
    assert.ok(document.querySelector('img[alt="QQ 扫码二维码"]'));assert.match(document.body.textContent,/扫码绑定 QQ 机器人/);
  }finally{
    await act(async()=>root.unmount());dom.window.close();
    global.window=previous.window;global.document=previous.document;global.fetch=previous.fetch;global.IS_REACT_ACT_ENVIRONMENT=previous.act;
  }
});
