'use strict';
// Lobby (频道) view inside the workspace shell. Same approach as workspace-shell.test.cjs: the real shell
// source runs in jsdom against a fake bridge. Synthetic data only.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'../../apps/neko-workbench');
const source=fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.js'),'utf8');
const css=fs.readFileSync(path.join(base,'embedded-dsh/workspace-shell-source.css'),'utf8');
const composerSource=fs.readFileSync(path.join(base,'lobby-composer.js'),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,15));
let JSDOM;
for(const dir of [process.env.NEKO_DOM_DEPS,'/private/tmp/neko-sidebar-dom-20261026','/private/tmp/neko-lobby-dom-7mKS'].filter(Boolean)){try{({JSDOM}=require(path.join(dir,'node_modules/jsdom')));break;}catch{}}
const DOM_SKIP=JSDOM?false:'set NEKO_DOM_DEPS to a directory with jsdom installed';

for(const restarted of [false,true])test(`failed logout stays retryable without another login (restarted: ${restarted})`,{skip:DOM_SKIP},async t=>{
 const text='频道凭据未能完全清除，请重试退出登录。';
 const signedOut=error=>snapshot({connection:'signed-out',auth:{status:'signed-out',message:'登录后即可进入频道。',error,signingIn:false,canRetrySignOut:!!error},me:null,messages:[],members:[],channel:null});
 let attempts=restarted?1:0;
 const f=setup(t,{snap:restarted?signedOut(text):snapshot(),respond:r=>{if(r.action==='sign-out'){const failed=++attempts===1;const state=signedOut(failed?text:'');f.setCurrent(state);return{ok:!failed,error:failed?text:'',state};}}});
 await tick();f.doc.querySelector('.neko-lobby-switch').click();await tick();
 const button=f.doc.querySelector('.neko-lobby-sign-out');
 if(!restarted){button.click();await tick();}
 assert(!button.hidden);assert.equal(button.textContent,'重试退出登录');
 const notice=f.doc.querySelector('.neko-lobby-error');assert(!notice.hidden);assert.equal(notice.textContent,text);
 button.click();await tick();
 assert(button.hidden);assert(notice.hidden);
 assert.equal(f.calls.lobby.filter(r=>r.action==='sign-out').length,restarted?1:2);
 assert(!f.calls.lobby.some(r=>r.action==='sign-in'),'cleanup does not require authorizing again');
});

const ME='11111111-1111-4111-8111-111111111111',ZS='22222222-2222-4222-8222-222222222222',FAKE='33333333-3333-4333-8333-333333333333';
const MYCAT='44444444-4444-4444-8444-444444444444',ZSCAT='55555555-5555-4555-8555-555555555555',CH='66666666-6666-4666-8666-666666666666';
const mid=n=>'aaaaaaaa-aaaa-4aaa-8aaa-'+String(n).padStart(12,'0');
const hue=(text,h=120)=>({kind:'hue',hue:h,text});
const human=(id,name,extra={})=>({kind:'human',user_id:id,name,display_name:name,avatar:hue(name.slice(0,1)),...extra});
const catAuthor=(id,owner,ownerName,name)=>({kind:'cat',cat_id:id,owner_user_id:owner,owner_name:ownerName,name,display_name:ownerName+'的'+name,avatar_key:'bigfish'});
const msg=(n,author,origin,label,text,extra={})=>({id:mid(n),seq:n,channel_id:CH,created_at:1730000000000+n*1000,deleted:false,text,origin,label,author,mentions:[],reply_to:null,cat_depth:origin==='cat'?1:0,...extra});
function snapshot(over={}){
 const messages=[
  msg(1,human(ZS,'张三'),'human','张三','大家好 <@c:'+MYCAT+'> 和 <@u:'+ME+'>'),
  msg(2,{...human(ZS,'张三'),assist_cat:{cat_id:ZSCAT,name:'小橘'}},'human_ai','人＋AI 共同回复 · 张三与小橘','一起写的'),
  msg(3,catAuthor(ZSCAT,ZS,'张三','小橘'),'cat','AI 独立发言 · 张三的小橘','喵',{reply_to:{id:mid(2),seq:2,origin:'human_ai',label:'人＋AI 共同回复 · 张三与小橘'}}),
  msg(4,human(FAKE,'张三的大肥鱼'),'human','张三的大肥鱼','<img src=x onerror="window.__pwned=1">'),
  msg(5,human(ME,'李四'),'human','李四','我自己说'),
  msg(6,{...human(ME,'李四'),assist_cat:{cat_id:MYCAT,name:'大肥鱼'}},'human_ai','人＋AI 共同回复 · 李四与大肥鱼','我们一起说'),
  msg(7,catAuthor(MYCAT,ME,'李四','大肥鱼'),'cat','AI 独立发言 · 李四的大肥鱼','我是大肥鱼'),
  {...msg(8,human(ZS,'张三'),'human','张三',null),deleted:true},
 ];
 return {connection:'online',auth:{status:'signed-in',message:'已登录频道。',error:'',signingIn:false},
  participation:{mode:'assist',available:true,reason:''},loading:false,
  me:{user_id:ME,name:'李四',display_name:'李四',avatar:hue('李'),role:'member',is_admin:false,muted_until:null,banned_at:null,cat:{id:MYCAT,name:'大肥鱼'}},
  channel:{id:CH,name:'公共大厅',topic:'随便聊聊',slow_mode_seconds:0,cats_enabled:true,cat_free_mode_allowed:false},
  messages,hasMore:true,
  members:[{...human(ZS,'张三'),role:'member',online:true},{...human(ME,'李四'),role:'member',online:true},{...human(FAKE,'张三的大肥鱼'),role:'member',online:false},
   {...catAuthor(ZSCAT,ZS,'张三','小橘'),enabled:true,admin_disabled:false,online:true},{...catAuthor(MYCAT,ME,'李四','大肥鱼'),enabled:true,admin_disabled:false,online:true}],
  outbox:[],catSettings:{mode:'assist'},cat:{},suggestion:null,nudge:null,error:'',...over};
}

function setup(t,{lobby=true,snap=snapshot(),respond,composer=true,home=false}={}){
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><div data-slot="sidebar"><button data-neko-new-session="plus">+</button><div data-neko-seat-mount></div><div data-slot="sidebar.workspaces">native</div><div data-slot="settings.launcher"></div></div><main><textarea>native draft</textarea></main></body>',{runScripts:'outside-only'});
 t.after(()=>dom.window.close());
 const {window:w}=dom,doc=w.document;doc.querySelector('[data-slot="sidebar"]').getBoundingClientRect=()=>({left:64,top:0,right:300,bottom:800,width:236,height:800});doc.querySelector('[data-neko-side-rail]').getBoundingClientRect=()=>({left:0,top:0,right:64,bottom:800,width:64,height:800});
 let layout={seats:[{id:'seat-1',name:'DSH',provider:'dsh',avatarId:'bigfish',projectRoot:''}],activeSeatId:null,officeMode:'dsh',companionCollapsed:false,companionHistoryOpen:false};
 const state={workspaceRoot:'/fixture',workspaceRevision:0,companion:{name:'主agent',ready:true,working:false,messages:[]}};
 const calls={lobby:[],hideSocial:0,community:0};let lobbySub,community,current=snap;
 const bridge={getState:async()=>state,action:async()=>({ok:true}),subscribe:()=>()=>{},
  subscribeCommunity:fn=>{community=fn;return()=>{};},companion:async()=>({}),
  workspace:async r=>{if(r.action==='update')layout={...layout,...r.patch};if(r.action==='codex-state')return {status:'idle',items:[],approvals:[]};if(r.action==='catalog')return {sessions:[],projects:[],providers:{dsh:'ready'}};return structuredClone(layout);}};
 if(lobby){
  bridge.lobby=async r=>{calls.lobby.push(structuredClone(r));const custom=respond?.(r,current);if(custom)return custom;return {ok:true,state:current};};
  bridge.subscribeLobby=fn=>{lobbySub=fn;return()=>{lobbySub=null;};};
 }
 if(composer)w.eval(composerSource);
 if(home)w.eval(fs.readFileSync(path.join(base,'embedded-dsh/chatroom-preview-source.js'),'utf8'));
 w.eval(source+'\nwindow.install=installWorkspaceShell');
 const cleanup=w.install({window:w,document:doc,bridge,cssText:css,mountHome:home ? async stage => {const mark=doc.createElement('span');mark.textContent='home fixture';stage.appendChild(mark);return ()=>{};} : undefined,avatar:id=>id==='bigfish'?'data:image/png;base64,iVBORw0KGgo=':'',
  hideSocial:()=>{calls.hideSocial++;community?.({status:'hidden'});},openCommunity:()=>{calls.community++;community?.({status:'ready'});}});
 t.after(()=>cleanup());
 return {w,doc,calls,cleanup,push:next=>{current=next;lobbySub?.(next);},get current(){return current;},setCurrent:v=>{current=v;}};
}
const rowOf=(doc,n)=>doc.querySelector('.neko-lobby-message[data-id="'+mid(n)+'"]');
const labelOf=(doc,n)=>rowOf(doc,n).querySelector('.neko-lobby-label').textContent;
test('Chat opens the public room in the main area and preserves native and companion drafts across Work',{skip:DOM_SKIP},async t=>{
 const f=setup(t,{home:true}),{doc,calls}=f;await tick();
 const entry=doc.querySelector('[data-neko-public-room]'),panel=doc.querySelector('.neko-lobby-panel'),preview=doc.querySelector('.neko-chatroom-preview');
 const native=doc.querySelector('main textarea'),dock=doc.querySelector('.neko-companion-dock'),draft=dock.querySelector('textarea');draft.value='私聊草稿';
 assert.equal(entry.tagName,'BUTTON');assert(!panel.hidden,'Chat defaults to the real public room');assert(panel.hasAttribute('data-neko-lobby-in-room'));assert(!preview.hidden,'the room directory stays available');
 assert(!preview.contains(panel),'the room conversation is separate from the sidebar directory');
 assert.equal(doc.querySelector('.neko-chatroom-preview__badge').textContent,'频道入口');
 const joins=calls.lobby.filter(r=>r.action==='open').length;assert.equal(joins,1,'default room joins after the initial account snapshot without waiting for an event');entry.click();entry.click();await tick();assert.equal(calls.lobby.filter(r=>r.action==='open').length,joins,'selecting the active room does not join twice');
 const members=doc.querySelector('.neko-lobby-members-toggle');members.click();assert(panel.hasAttribute('data-members-open'));members.click();assert(!panel.hasAttribute('data-members-open'));
 const switchMode=label=>[...doc.querySelectorAll('.neko-home-work-switch button')].find(button=>button.textContent===label).click();
 const closes=calls.lobby.filter(r=>r.action==='close').length;
 switchMode('Work');await tick();assert(panel.hidden);assert.equal(calls.lobby.filter(r=>r.action==='close').length,closes+1);assert(!doc.body.hasAttribute('data-neko-lobby-active'));
 assert.equal(doc.querySelector('main textarea'),native);assert.equal(native.value,'native draft');assert.equal(doc.querySelector('.neko-companion-dock'),dock);assert.equal(draft.value,'私聊草稿');
 switchMode('Chat');await tick();assert(!panel.hidden);assert.equal(calls.lobby.filter(r=>r.action==='open').length,joins+1);assert.equal(draft.value,'私聊草稿');assert.equal(draft.disabled,false);
 doc.querySelector('.neko-community').click();
 // The unified-layout host announces completion of social navigation.
 doc.dispatchEvent(new f.w.CustomEvent('neko-side-surface-change',{detail:{surface:'community'}}));
 await tick();assert.equal(calls.community,1);assert(panel.hidden);assert.equal(calls.lobby.filter(r=>r.action==='close').length,closes+2);assert.equal(doc.querySelector('.neko-companion-dock'),dock);assert.equal(native.value,'native draft');
});

test('public-room and home navigation retain the mounted home and independent work draft',{skip:DOM_SKIP},async t=>{
 const f=setup(t,{home:true}),{doc}=f;await tick();const preview=doc.querySelector('.neko-chatroom-preview'),home=doc.querySelector('.neko-chatroom-preview__home-view'),entry=doc.querySelector('[data-neko-public-room]'),panel=doc.querySelector('.neko-lobby-panel');
 const native=doc.querySelector('main textarea');
 assert.equal(entry.tagName,'BUTTON');assert(!panel.hidden);assert(!preview.hidden);
 const homeButton=doc.querySelector('.neko-chatroom-preview__room-icon.is-home').closest('button');
 homeButton.click();await tick();assert(!home.hidden);assert(panel.hidden);const stage=doc.querySelector('[data-neko-home-stage]'),mounted=stage.firstChild;assert(mounted);
 entry.click();await tick();assert(home.hidden);assert(!panel.hidden);assert(!preview.hidden);
 homeButton.click();await tick();assert(!home.hidden);assert(panel.hidden);assert.equal(stage.firstChild,mounted);
 [...doc.querySelectorAll('.neko-home-work-switch button')].find(b=>b.textContent==='Work').click();await tick();
 [...doc.querySelectorAll('.neko-home-work-switch button')].find(b=>b.textContent==='Chat').click();await tick();
 assert(!home.hidden);assert.equal(stage.firstChild,mounted);assert.equal(doc.querySelector('main textarea'),native);assert.equal(native.value,'native draft');
});

test('message list: origin labels, own labels, badges by origin only, reply quote label, mentions, deleted, text-only rendering',{skip:DOM_SKIP},async t=>{
 const f=setup(t),{doc,w}=f;await tick();doc.querySelector('.neko-lobby-switch').click();await tick();
 const log=doc.querySelector('.neko-lobby-log');
 assert.equal(log.getAttribute('role'),'log');assert.equal(log.getAttribute('aria-live'),'polite');
 assert.equal(doc.querySelector('.neko-lobby-title').textContent,'公共大厅');assert.equal(doc.querySelector('.neko-lobby-topic').textContent,'随便聊聊');
 assert.equal(doc.querySelector('.neko-lobby-online').textContent,'2 人在线');
 assert.equal(labelOf(doc,1),'张三');
 assert.equal(labelOf(doc,2),'人＋AI 共同回复 · 张三与小橘');
 assert.equal(labelOf(doc,3),'AI 独立发言 · 张三的小橘');
 assert.equal(labelOf(doc,5),'我');
 assert.equal(labelOf(doc,6),'人＋AI 共同回复 · 我与大肥鱼');
 assert.equal(labelOf(doc,7),'AI 独立发言 · 我的大肥鱼');
 assert.equal(rowOf(doc,3).dataset.kind,'cat');assert.match(rowOf(doc,3).querySelector('.neko-lobby-badge').textContent,/猫猫/);
 assert.match(rowOf(doc,2).querySelector('.neko-lobby-badge').textContent,/人＋AI/);assert.equal(rowOf(doc,2).dataset.kind,'human');
 assert.equal(rowOf(doc,1).querySelector('.neko-lobby-badge'),null);
 const fake=rowOf(doc,4);assert.equal(fake.dataset.kind,'human');assert.equal(fake.querySelector('.neko-lobby-badge'),null,'a human named 张三的大肥鱼 gets no cat badge');
 assert.equal(fake.querySelector('.neko-lobby-label').textContent,'张三的大肥鱼');
 assert.equal(fake.querySelector('img:not(.neko-lobby-avatar)'),null,'no <img> element is created from message text');
 assert.equal(fake.querySelector('.neko-lobby-text').textContent,'<img src=x onerror="window.__pwned=1">');await tick();assert.equal(w.__pwned,undefined);
 const quote=rowOf(doc,3).querySelector('.neko-lobby-quote');
 assert.equal(quote.querySelector('.neko-lobby-quote__label').textContent,'回复 '+labelOf(doc,2),'reply quote uses the quoted message label');
 const mentions=[...rowOf(doc,1).querySelectorAll('.neko-lobby-mention')].map(n=>[n.textContent,n.dataset.kind]);
 assert.deepEqual(mentions,[['@我的大肥鱼','cat'],['@我','human']]);
 assert.equal(rowOf(doc,1).querySelector('.neko-lobby-text').textContent,'大家好 @我的大肥鱼 和 @我');
 assert.equal(rowOf(doc,8).querySelector('.neko-lobby-deleted').textContent,'消息已删除');assert.equal(rowOf(doc,8).querySelector('.neko-lobby-reply-to'),null);
 assert(!doc.querySelector('.neko-lobby-older').hidden,'load older is offered when hasMore');
 doc.querySelector('.neko-lobby-older').click();await tick();assert.equal(f.calls.lobby.at(-1).action,'load-older');
 assert.equal(doc.querySelector('[data-admin]'),null,'non-admins see no admin controls');
});
test('composer: maxLength 2000, Enter sends, Shift+Enter does not, @ picker turns names into tokens, reply target, failed retry',{skip:DOM_SKIP},async t=>{
 const f=setup(t),{doc,w,calls}=f;await tick();doc.querySelector('.neko-lobby-switch').click();await tick();
 const input=doc.querySelector('.neko-lobby-form textarea');assert.equal(input.maxLength,2000);assert.equal(input.disabled,false);
 const key=(k,extra={})=>input.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...extra}));
 const type=v=>{input.value=v;input.setSelectionRange(v.length,v.length);input.dispatchEvent(new w.Event('input',{bubbles:true}));};
 type('第一行');key('Enter',{shiftKey:true});await tick();assert(!calls.lobby.some(r=>r.action==='send'),'Shift+Enter is a newline, not a send');
 rowOf(doc,3).querySelector('.neko-lobby-reply-to').click();
 assert(!doc.querySelector('.neko-lobby-reply').hidden);assert.equal(doc.querySelector('.neko-lobby-reply__text').textContent,'回复 AI 独立发言 · 张三的小橘');
 type('你好 @小');const picker=doc.querySelector('.neko-lobby-picker');assert(!picker.hidden);
 assert.deepEqual([...picker.children].map(n=>n.textContent),['🐾 张三的小橘']);
 key('Enter');assert(picker.hidden,'Enter picks the highlighted member');assert.equal(input.value,'你好 @张三的小橘 ');
 type(input.value+'<b>hi</b>');key('Enter');await tick();
 const sent=calls.lobby.find(r=>r.action==='send');
 assert.deepEqual(sent,{action:'send',text:'你好 <@c:'+ZSCAT+'> <b>hi</b>',origin:'human',replyToId:mid(3)});
 assert.equal(input.value,'');assert(doc.querySelector('.neko-lobby-reply').hidden,'reply target clears after send');
 f.push(snapshot({outbox:[{clientMessageId:'77777777-7777-4777-8777-777777777777',kind:'human',status:'failed',error:'发送超时，请重试。',text:'没发出去 <@u:'+ZS+'>',replyToId:null,origin:'human',assistCatId:null}]}));await tick();
 const failed=doc.querySelector('.neko-lobby-message--outbox');assert(failed);assert.equal(failed.dataset.outbox,'failed');
 assert.equal(failed.querySelector('.neko-lobby-failed').textContent,'发送超时，请重试。');assert.equal(failed.querySelector('.neko-lobby-text').textContent,'没发出去 @张三');
 failed.querySelector('.neko-lobby-retry').click();await tick();assert.deepEqual(calls.lobby.at(-1),{action:'send-retry',clientMessageId:'77777777-7777-4777-8777-777777777777'});
});

test('mode bar and three status dots; unavailable participation leaves only 她不参与',{skip:DOM_SKIP},async t=>{
 const f=setup(t),{doc,calls}=f;await tick();doc.querySelector('.neko-lobby-switch').click();await tick();
 const modes=[...doc.querySelectorAll('.neko-lobby-mode')];
 assert.deepEqual(modes.map(b=>b.textContent),['她不参与','一起回复','她自己说话']);
 assert.deepEqual(modes.map(b=>b.getAttribute('aria-pressed')),['false','true','false']);
 const dots=Object.fromEntries([...doc.querySelectorAll('.neko-lobby-dot')].map(n=>[n.dataset.status,[n.dataset.on,n.textContent]]));
 assert.deepEqual(dots,{private:['true','私聊可用'],connection:['true','大厅已连接'],participation:['true','她在陪你一起回复']});
 modes[2].click();await tick();assert.deepEqual(calls.lobby.at(-1),{action:'mode-set',mode:'independent'});
 f.push(snapshot({participation:{mode:'assist',available:false,reason:'需要聊天 API'}}));await tick();
 assert.deepEqual(modes.map(b=>b.disabled),[false,true,true]);assert.equal(modes[0].getAttribute('aria-pressed'),'true');
 assert.equal(doc.querySelector('.neko-lobby-reason').textContent,'需要聊天 API');
 assert.equal(doc.querySelector('.neko-lobby-dot[data-status="participation"]').dataset.on,'false');
 assert.equal(doc.querySelector('.neko-lobby-dot[data-status="private"]').dataset.on,'true','private chat state is independent of the lobby');
 f.push(snapshot({connection:'offline',participation:{mode:'assist',available:false,reason:'大厅未连接'}}));await tick();
 assert.equal(doc.querySelector('.neko-lobby-dot[data-status="connection"]').textContent,'大厅未连接');assert(doc.querySelector('.neko-lobby-form textarea').disabled);
 assert.equal(doc.querySelector('.neko-lobby-dot[data-status="private"]').dataset.on,'true');
});

test('sign-in state: unconfigured and signed-out gates; signing in joins the lobby',{skip:DOM_SKIP},async t=>{
 const signedOut=snapshot({connection:'signed-out',auth:{status:'signed-out',message:'登录后即可进入频道。',error:'',signingIn:false},me:null,messages:[],members:[],channel:null,hasMore:false});
 const f=setup(t,{snap:signedOut,respond:(r)=>{if(r.action==='sign-in'){f.setCurrent(snapshot());return {ok:true,state:snapshot()};}}}),{doc,calls}=f;await tick();
 doc.querySelector('.neko-lobby-switch').click();await tick();
 assert(!calls.lobby.some(r=>r.action==='open'),'no join before sign-in');
 assert.equal(doc.querySelector('.neko-lobby-gate__text').textContent,'登录后即可进入频道。');assert(!doc.querySelector('.neko-lobby-sign-in').hidden);
 assert(doc.querySelector('.neko-lobby-form textarea').disabled);
 doc.querySelector('.neko-lobby-sign-in').click();await tick();await tick();
 assert.equal(calls.lobby.filter(r=>r.action==='open').length,1);assert(doc.querySelector('.neko-lobby-gate').hidden);
 f.push(snapshot({connection:'unconfigured',auth:{status:'unconfigured',message:'频道服务未配置。',error:'',signingIn:false}}));await tick();
 assert(!doc.querySelector('.neko-lobby-gate').hidden);assert.equal(doc.querySelector('.neko-lobby-gate__text').textContent,'频道服务未配置。');
 assert(doc.querySelector('.neko-lobby-sign-in').hidden);
});

test('message list keeps at most 300 nodes',{skip:DOM_SKIP},async t=>{
 const many=Array.from({length:320},(_,i)=>msg(i+1,human(ZS,'张三'),'human','张三','第'+(i+1)+'条'));
 const f=setup(t,{snap:snapshot({messages:many})}),{doc}=f;await tick();doc.querySelector('.neko-lobby-switch').click();await tick();
 const rows=doc.querySelectorAll('.neko-lobby-log > .neko-lobby-message');assert.equal(rows.length,300);
 assert.equal(rows[0].dataset.id,mid(21));assert.equal(rows[299].dataset.id,mid(320),'the newest messages stay');
});

test('without bridge.lobby the shell installs no lobby UI and keeps working',{skip:DOM_SKIP},async t=>{
 const {doc}=setup(t,{lobby:false});await tick();
 assert.equal(doc.querySelector('.neko-lobby-switch'),null);assert.equal(doc.querySelector('.neko-lobby-panel'),null);
 assert(doc.querySelector('.neko-companion-dock'));assert(doc.querySelector('.neko-community'));
});

test('lobby source renders text only and never targets the dock',()=>{
 const start=source.indexOf('function createLobbyView');assert(start>0);
 const lobby=source.slice(start);
 assert.doesNotMatch(lobby,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
 assert.doesNotMatch(lobby,/companion-dock|\bdock\b/,'the lobby view has no handle on the dock');
 const bundle=fs.readFileSync(path.join(base,'embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js'),'utf8');
 assert(bundle.includes(source),'synced into the shipped bundle');assert(bundle.includes(JSON.stringify(css)));
});

test('assist flow: nudge, suggestion card; adopt requires click; card discard keeps input; enter in assist box', {skip: DOM_SKIP}, async t => {
 const f = setup(t, { snap: snapshot({ suggestion: null, nudge: null, participation: { mode: 'off', available: true, reason: '' } }) }), {doc, w, calls} = f; await tick();
 doc.querySelector('.neko-lobby-switch').click(); await tick();
 assert(doc.querySelector('.neko-lobby-assist').hidden, 'assist section hidden in off mode');
 f.push(snapshot({ participation: { mode: 'assist', available: true } })); await tick();
 assert(!doc.querySelector('.neko-lobby-assist').hidden); assert(doc.querySelector('.neko-lobby-nudge').hidden, 'no nudge yet');
 f.push(snapshot({ participation: { mode: 'assist', available: true }, nudge: { messageId: mid(1), who: 'human' } })); await tick();
 assert(!doc.querySelector('.neko-lobby-nudge').hidden); assert.equal(doc.querySelector('.neko-lobby-nudge__text').textContent, '有人 @ 了你，要她帮你想想怎么回吗？');
 doc.querySelector('.neko-lobby-nudge-help').click(); await tick();
 assert.equal(calls.lobby.at(-1).action, 'suggest'); assert(doc.querySelector('.neko-lobby-assist__body').hidden === false, 'body visible when card exists');
 f.push(snapshot({ participation: { mode: 'assist', available: true }, suggestion: { state: 'ready', text: '她的建议内容', targetId: mid(1), draftEpoch: 0 } })); await tick();
 assert.equal(doc.querySelector('.neko-lobby-card').dataset.state, 'ready');
 const input = doc.querySelector('.neko-lobby-form textarea'); input.value = '已有草稿'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
 doc.querySelector('.neko-lobby-card-adopt').click(); await tick();
 assert(!doc.querySelector('.neko-lobby-adopt-choice').hidden, 'non-empty draft asks replace or append');
 assert.equal(input.value, '已有草稿', 'draft is not overwritten yet');
 doc.querySelector('.neko-lobby-adopt-append').click(); await tick();
 assert(doc.querySelector('.neko-lobby-adopt-choice').hidden); assert.equal(input.value, '已有草稿\n她的建议内容', 'append');
 assert.equal(calls.lobby.filter(r => r.action === 'suggest-discard').length, 1);
 assert(!calls.lobby.some(r => r.action === 'send'), 'a suggestion never sends without the user pressing 发送');
 assert(!doc.querySelector('.neko-lobby-marker').hidden, '人＋AI marker shows after adopt');
 doc.querySelector('.neko-lobby-send').click(); await tick();
 const sent = calls.lobby.find(r => r.action === 'send');
 assert.deepEqual(sent, { action: 'send', text: '已有草稿\n她的建议内容', origin: 'human_ai', replyToId: mid(1), assistCatId: MYCAT }, 'only the explicit send carries human_ai');
 const assistInput = doc.querySelector('.neko-lobby-assist-input'); assistInput.value = '委婉拒绝';
 assistInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
 assert.equal(calls.lobby.filter(r => r.action === 'suggest').at(-1).instruction, '委婉拒绝', 'Enter in assist box triggers suggest');
});

test('admins see admin controls, members see only delete for their own human messages', {skip: DOM_SKIP}, async t => {
 const member = snapshot({ me: { ...snapshot().me, is_admin: false } }), admin = snapshot({ me: { ...snapshot().me, is_admin: true } });
 const f = setup(t, { snap: member }), {doc} = f; await tick(); doc.querySelector('.neko-lobby-switch').click(); await tick();
 assert(doc.querySelector('.neko-lobby-admin-open') === null, 'no 管理 button for members');
 assert(doc.querySelector('.neko-lobby-members').hidden === false, 'member list visible'); assert(doc.querySelector('.neko-lobby-member-more') === null, 'no member menu buttons');
 const myRow = rowOf(doc, 5), otherRow = rowOf(doc, 1);
 assert(myRow.querySelector('.neko-lobby-delete') !== null, 'my own human message has delete');
 assert(otherRow.querySelector('.neko-lobby-delete') === null, 'others\' messages have no delete for members');
 f.push(admin); await tick();
 assert(doc.querySelector('.neko-lobby-admin-open') !== null, 'admins see 管理 button');
 assert(rowOf(doc, 1).querySelector('.neko-lobby-delete') !== null, 'admins delete any message');
 const zsKey = 'u:' + ZS, zsItem = () => doc.querySelector('.neko-lobby-member[data-key="' + zsKey + '"]');
 assert(!doc.querySelector('.neko-lobby-member[data-key="u:' + ME + '"] .neko-lobby-member-more'), 'no admin menu on yourself');
 zsItem().querySelector('.neko-lobby-member-more').click(); await tick();
 assert(zsItem().querySelector('.neko-lobby-member-menu') !== null, 'admin menu opens');
 const keys = [...doc.querySelectorAll('.neko-lobby-member')].map(n => n.dataset.key);
 assert.deepEqual(keys, ['u:' + ME, 'c:' + MYCAT, 'u:' + ZS, 'c:' + ZSCAT, 'u:' + FAKE], 'online humans first, cats under owners, offline last');
 doc.querySelector('.neko-lobby-mute').click(); await tick();
 assert.deepEqual(f.calls.lobby.at(-1), { action: 'admin-mute', userId: ZS, minutes: 10 });
 f.push(member); await tick();
 assert.equal(doc.querySelector('[data-admin]'), null, 'admin controls leave the DOM when admin rights go away');
});

test('replace choice keeps undo; undo restores draft; clearing input voids marker and undo', {skip: DOM_SKIP}, async t => {
 const f = setup(t, { snap: snapshot({ suggestion: { state: 'ready', text: '她的建议', targetId: null, draftEpoch: 0 }, participation: { mode: 'assist', available: true } }) }), {doc, w} = f; await tick();
 doc.querySelector('.neko-lobby-switch').click(); await tick();
 const input = doc.querySelector('.neko-lobby-form textarea'); input.value = '原来的'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
 doc.querySelector('.neko-lobby-card-adopt').click(); await tick();
 doc.querySelector('.neko-lobby-adopt-replace').click(); await tick();
 assert(doc.querySelector('.neko-lobby-adopt-choice').hidden); assert.equal(input.value, '她的建议', 'replaced');
 assert(!doc.querySelector('.neko-lobby-undo').hidden, 'undo bar shown');
 assert(!doc.querySelector('.neko-lobby-marker').hidden, 'marker shown');
 doc.querySelector('.neko-lobby-undo-button').click(); await tick();
 assert.equal(input.value, '原来的', 'undo restores'); assert(doc.querySelector('.neko-lobby-marker').hidden);
 input.value = ''; input.dispatchEvent(new w.Event('input', { bubbles: true }));
 assert(doc.querySelector('.neko-lobby-marker').hidden); assert(doc.querySelector('.neko-lobby-undo').hidden);
});

test('猫猫设置 shows the needs-Chat-API state and saves only changed fields; 管理 dialog is admin-only', {skip: DOM_SKIP}, async t => {
 const noApi = snapshot({ participation: { mode: 'off', available: false, reason: '需要聊天 API' }, catSettings: { mode: 'assist', name: '大肥鱼', avatarKey: 'bigfish', independentTrigger: 'mention', note: '' } });
 const f = setup(t, { snap: noApi }), {doc, w, calls} = f; await tick(); doc.querySelector('.neko-lobby-switch').click(); await tick();
 doc.querySelector('.neko-lobby-cat-settings').click(); await tick();
 const dlg = doc.querySelector('.neko-lobby-dialog[data-dialog="cat"]'); assert(dlg);
 assert.equal(dlg.querySelector('.neko-lobby-cat-api').dataset.ready, 'false'); assert.match(dlg.querySelector('.neko-lobby-cat-api').textContent, /需要聊天 API/);
 assert.deepEqual([...dlg.querySelectorAll('.neko-lobby-cat-mode .neko-lobby-choice')].map(b => b.disabled), [false, true, true]);
 assert.match(dlg.querySelector('.neko-lobby-cat-preview').textContent, /李四的大肥鱼/);
 const name = dlg.querySelector('.neko-lobby-cat-name'); name.value = '小鱼'; name.dispatchEvent(new w.Event('input', { bubbles: true }));
 dlg.querySelector('.neko-lobby-cat-trigger [data-value="free"]').click();
 dlg.querySelector('.neko-lobby-dialog-save').click(); await tick();
 assert.deepEqual(calls.lobby.at(-1), { action: 'cat-save', name: '小鱼', independentTrigger: 'free' }, 'mode is not overwritten while the API is missing');
 assert.equal(doc.querySelector('.neko-lobby-dialog'), null, 'closes after save');
 assert.equal(doc.querySelector('.neko-lobby-admin-open'), null);
 f.push(snapshot({ me: { ...snapshot().me, is_admin: true } })); await tick();
 doc.querySelector('.neko-lobby-admin-open').click(); await tick();
 const admin = doc.querySelector('.neko-lobby-dialog[data-dialog="admin"]'); assert(admin);
 admin.querySelector('.neko-lobby-admin-topic').value = '新话题'; admin.querySelector('.neko-lobby-admin-slow').value = '30';
 admin.querySelector('.neko-lobby-admin-free').checked = true;
 admin.querySelector('.neko-lobby-dialog-save').click(); await tick();
 assert.deepEqual(calls.lobby.at(-1), { action: 'admin-channel', topic: '新话题', slowModeSeconds: 30, catFreeAllowed: true });
 doc.querySelector('.neko-lobby-admin-open').click(); await tick(); assert(doc.querySelector('.neko-lobby-dialog[data-dialog="admin"]'));
 f.push(snapshot()); await tick();
 assert.equal(doc.querySelector('.neko-lobby-dialog'), null, 'the admin dialog closes when admin rights go away');
});

test('local home and lobby retain independent navigation and home stage',{skip:DOM_SKIP},async t=>{
 const {doc}=setup(t,{home:true});await tick();
 const home=doc.querySelector('button[aria-label*="我的小窝"]');assert(home);home.click();await tick();
 const homeView=doc.querySelector('.neko-chatroom-preview__home-view'),stage=doc.querySelector('[data-neko-home-stage]');
 assert(!homeView.hidden);assert.match(stage.textContent,/home fixture/);
 const lobby=doc.querySelector('.neko-lobby-panel'),open=doc.querySelector('.neko-lobby-switch');open.click();await tick();
 assert(!lobby.hidden,'opening lobby shows its own panel');assert.match(stage.textContent,/home fixture/,'home is not destroyed');
 open.click();await tick();assert(lobby.hidden);assert(!homeView.hidden);assert.match(stage.textContent,/home fixture/);
});
