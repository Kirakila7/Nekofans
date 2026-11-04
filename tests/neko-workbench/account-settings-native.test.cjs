'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const archive=process.env.NEKO_NATIVE_DSH_ASAR,domDeps=process.env.NEKO_DOM_DEPS;

test('real bundled signed-in account section retains identity, balance, billing and error states under the privacy skin',{skip:!archive||!domDeps},async()=>{
 const deps=createRequire(path.join(domDeps,'package.json'));
 const React=deps('react'),{renderToStaticMarkup}=deps('react-dom/server'),{JSDOM}=deps('jsdom');
 const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{runScripts:'outside-only'});
 const previous={window:global.window,document:global.document};global.window=dom.window;global.document=dom.window.document;
 try{
  let entry;window.__ModuleLoader__={load(value){entry=value;}};
  const source=fs.readFileSync(path.join(archive,'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'),'utf8');
  assert.equal(source.split('exports.apply = apply;').length,2);
  vm.runInThisContext(source.replace('exports.apply = apply;','exports.AccountSection = AccountSection; exports.apply = apply;'),{filename:'native-account-fixture-client.js'});
  const primitive=props=>React.createElement('span',null,props.children);
  const component=entry.factory(id=>{
   if(id==='react'||id==='react/jsx-runtime'||id==='react-dom')return deps(id);
   if(id==='@deepseek-ai/dsh-client-ui-primitives')return new Proxy({},{get:()=>primitive});
   if(id==='@deepseek-ai/dsh-client-store')return {};
   throw Error('Unexpected account dependency: '+id);
  }).AccountSection;
  const skin=fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/privacy-settings.js'),'utf8');
  dom.window.eval(skin);const dispose=dom.window.installPrivacySettings();
  const view={status:'credential-stored',links:{usageUrl:'https://example.test/usage',topUpUrl:'https://example.test/top-up'}};
  const labels={nav:'账号与余额',balance:'余额',usage:'用量',topUp:'充值',balanceUnavailable:'余额暂不可用'};
  const render=async details=>{
   document.body.innerHTML=renderToStaticMarkup(React.createElement(component,{t:key=>labels[key]||key,useAccount:pick=>pick({view,details}),useTheme:pick=>pick({active:{colorScheme:'light'}}),start:()=>{throw Error('No authentication in QA');},cancel:()=>{},avatarFailed:()=>{}}));
   await new Promise(resolve=>setImmediate(resolve));
   const cards=[...document.querySelectorAll('section._6qcDqa_section > div')];assert.equal(cards.length,2);
   for(const card of cards)assert.notEqual(window.getComputedStyle(card).display,'none');
   assert.equal(document.querySelector('.neko-settings-account-card'),null);
   assert([...document.querySelectorAll('a[href="https://example.test/usage"]')].some(a=>a.textContent==='用量'));
   assert.equal(document.querySelector('a[href="https://example.test/top-up"]').textContent,'充值');
  };
  await render({profile:{status:'ready',value:{name:'合成账号',contact:'synthetic@example.test'}},balance:{status:'ready',value:[{currency:'CNY',balance:'12.34'}],bonusWallets:[]}});
  assert.match(document.body.textContent,/合成账号/);assert.match(document.body.textContent,/¥12\.34/);
  if(process.env.NEKO_ACCOUNT_QA_HTML)fs.writeFileSync(process.env.NEKO_ACCOUNT_QA_HTML,'<!doctype html>'+document.documentElement.outerHTML);
  await render(undefined);assert.match(document.body.textContent,/loading/);
  await render({profile:{status:'failed'},balance:{status:'failed'}});assert.match(document.body.textContent,/余额暂不可用/);
  await render({balance:{status:'ready',value:[{currency:'CNY',balance:'0'}],bonusWallets:[]}});assert.match(document.body.textContent,/¥0\.00/);
  dispose();
 }finally{dom.window.close();global.window=previous.window;global.document=previous.document;}
});
