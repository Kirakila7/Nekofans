'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {officialDshAuthorizeUrl,createDshLoginBrowser}=require('../../apps/neko-workbench/dsh-login-browser.cjs');
const {createDshLoginWatch}=require('../../apps/neko-workbench/dsh-login-watch.cjs');
const authorize='https://platform.deepseek.com/dsh/authorize?state=SYNTHETIC_STATE&code_challenge=SYNTHETIC_PKCE';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('only the official DSH authorization endpoint may open and its PKCE query stays intact',()=>{
 assert.equal(officialDshAuthorizeUrl(authorize),authorize);
 for(const value of ['http://platform.deepseek.com/dsh/authorize','https://api.deepseek.com/dsh/authorize','https://platform.deepseek.com.evil.test/dsh/authorize','https://platform.deepseek.com:444/dsh/authorize','https://user:password@platform.deepseek.com/dsh/authorize','https://platform.deepseek.com/dsh/authorize#secret','https://platform.deepseek.com/other','file:///C:/example','javascript:alert(1)',null])assert.equal(officialDshAuthorizeUrl(value),null);
});

test('only waiting-browser opens once per attempt; no navigation is inferred from initial or invalid state',async()=>{
 const opened=[],browser=createDshLoginBrowser({openExternal:async url=>opened.push(url)});
 assert.equal(browser.accept({id:'attempt',phase:'initializing',authorizeUrl:authorize}),false);
 assert.equal(browser.accept({id:'attempt',phase:'waiting-browser',authorizeUrl:'https://evil.test/'}),false);
 assert(browser.accept({id:'attempt',phase:'waiting-browser',authorizeUrl:authorize}));assert.equal(browser.accept({id:'attempt',phase:'waiting-browser',authorizeUrl:authorize}),false);await tick();assert.deepEqual(opened,[authorize]);
 browser.dispose();assert.equal(browser.accept({id:'next',phase:'waiting-browser',authorizeUrl:authorize}),false);
});

test('browser failures expose a fixed fallback message and disposed requests do not launch',async()=>{
 const errors=[];let opened=0;
 const browser=createDshLoginBrowser({openExternal:async()=>{throw Error('PRIVATE_URL:'+authorize);},onError:message=>errors.push(message)});browser.accept({id:'a',phase:'waiting-browser',authorizeUrl:authorize});await tick();assert.equal(errors.length,1);assert(!errors[0].includes('SYNTHETIC'));assert.equal(browser.accept({id:'a',phase:'waiting-browser',authorizeUrl:authorize}),false);
 const closing=createDshLoginBrowser({openExternal:()=>opened++});closing.accept({id:'b',phase:'waiting-browser',authorizeUrl:authorize});closing.dispose();await tick();assert.equal(opened,0);
});

test('the native account watch forwards only the browser projection and aborts with its owner',async()=>{
 const forwarded=[];let watches=0,aborted=false,release;
 const watch=createDshLoginWatch({getAccount:()=>({async *watch(signal){watches++;yield{status:'signed-out',credential:'PRIVATE_CREDENTIAL',attempt:{id:'a',phase:'initializing'}};yield{credential:'PRIVATE_CREDENTIAL',links:{private:'PRIVATE_LINK'},attempt:{id:'a',phase:'waiting-browser',authorizeUrl:authorize,other:'PRIVATE_OTHER'}};await new Promise(resolve=>{release=resolve;signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});});}}),emit:(method,params)=>forwarded.push({method,params})});
 watch.start();watch.start();await tick();assert.equal(watches,1);assert.deepEqual(forwarded,[{method:'dsh-login-attempt',params:{id:'a',phase:'waiting-browser',authorizeUrl:authorize}}]);assert(!JSON.stringify(forwarded).includes('PRIVATE_'));watch.dispose();await tick();assert(aborted);release();
});

test('optional or failed account watchers do not break the engine',async()=>{
 for(const getAccount of [()=>null,()=>{throw Error('unavailable');},()=>({async *watch(){throw Error('unavailable');}})]){const watcher=createDshLoginWatch({getAccount,emit:()=>{throw Error('unexpected');}});assert.doesNotThrow(()=>watcher.start());await tick();watcher.dispose();}
});

test('main consumes authorization URLs before generic event logs and never replays them',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../apps/neko-workbench/main.cjs'),'utf8'),prefix=source.slice(source.indexOf('function receive(message,replay=false){'),source.indexOf('  if(message.id){'));
 const projected=[],receive=vm.runInNewContext(prefix+"return 'generic';\n};receive",{dshLoginBrowser:{accept:value=>projected.push(value)}});
 const event={method:'dsh-login-attempt',params:{id:'test',phase:'waiting-browser',authorizeUrl:authorize}};receive(event);receive(event,true);assert.equal(projected.length,1);assert.equal(receive({method:'ordinary'}),'generic');
 assert(source.indexOf("message?.method==='dsh-login-attempt'")<source.indexOf("fs.appendFileSync(path.join(data,'events.jsonl')"));
});
