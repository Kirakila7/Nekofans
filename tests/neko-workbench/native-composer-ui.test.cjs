'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const base=path.join(__dirname,'../../apps/neko-workbench');
function setup(t,options={}){const dom=new JSDOM(fs.readFileSync(path.join(base,'native-composer.html'),'utf8'),{runScripts:'outside-only',url:'https://native-workbench.invalid/'});t.after(()=>dom.window.close());const {window:w}=dom, events=[];if(options.storage)Object.defineProperty(w,'localStorage',{value:options.storage});if(options.setTimeout)w.setTimeout=options.setTimeout;if(options.clearTimeout)w.clearTimeout=options.clearTimeout;let receive;w.nativeComposer={send:x=>events.push(x),onState:cb=>{receive=cb;}};w.eval(fs.readFileSync(path.join(base,'native-composer.js'),'utf8'));const el=w.document.getElementById('message');const snap=(revision,value,extra={})=>receive({enabled:true,busy:false,sessionToken:'s1',revision,value,...extra});snap(1,'',options.initial||{});return {w,el,events,snap,form:w.document.getElementById('composer'),status:w.document.getElementById('status'),expand:w.document.getElementById('expand'),copy:w.document.getElementById('copy')};}
function type(t,value){t.el.value=value;t.el.dispatchEvent(new t.w.Event('input',{bubbles:true}));}
function submit(t){t.form.dispatchEvent(new t.w.Event('submit',{bubbles:true,cancelable:true}));}

test('floating task view streams safe text while preserving input, scrolling and session boundaries',{skip:!JSDOM},t=>{
 const x=setup(t),d=x.w.document;
 x.snap(2,'kept draft',{taskOpen:true,taskStatus:'任务运行中',taskRunning:true,taskMessages:[{id:'a',role:'assistant',text:'<img src=x onerror=alert(1)>',streaming:true}]});
 assert.equal(d.querySelector('#task').hidden,false);assert.equal(d.querySelector('#task-list img'),null);assert.match(d.querySelector('#task-list').textContent,/<img/);assert.equal(x.el.value,'kept draft');
 const list=d.querySelector('#task-list');Object.defineProperty(list,'scrollHeight',{value:900,configurable:true});Object.defineProperty(list,'clientHeight',{value:200});list.scrollTop=52;list.dispatchEvent(new x.w.Event('scroll'));
 x.snap(2,'kept draft',{taskOpen:true,taskStatus:'任务运行中',taskMessages:[{id:'a',role:'assistant',text:'next chunk'}]});assert.equal(list.scrollTop,52);assert.equal(x.el.value,'kept draft');
 x.snap(1,'',{sessionToken:'s2',taskOpen:true,taskMessages:[{id:'b',role:'user',text:'other project'}]});assert.equal(list.textContent.includes('next chunk'),false);assert.match(list.textContent,/other project/);
 d.querySelector('#records-toggle').click();assert.equal(d.querySelector('#task').hidden,true);assert.equal(x.events.at(-1).type,'records-toggle');
 d.querySelector('#task-toggle').click();assert.equal(d.querySelector('#records').hidden,true);assert.equal(x.events.at(-1).type,'task-toggle');
});
test('floating composer serializes edits and submits only the latest acknowledged draft',{skip:!JSDOM},t=>{
 const x=setup(t);type(x,'a');type(x,'ab');assert.equal(x.events.length,1);assert.equal(x.events[0].value,'a');submit(x);assert.equal(x.events.length,1);assert.equal(x.el.readOnly,true);
 x.snap(2,'a',{settledEditId:x.events[0].editId});assert.equal(x.events.length,2);assert.equal(x.events[1].value,'ab');assert.equal(x.events[1].revision,2);
 x.snap(3,'ab',{settledEditId:x.events[1].editId});assert.equal(x.events.length,3);assert.equal(x.events[2].type,'submit');assert.equal(x.events[2].value,'ab');assert.equal(x.events[2].revision,3);
 x.snap(3,'ab');assert.equal(x.el.readOnly,true);x.snap(4,'',{settledSubmitId:x.events[2].submissionId});assert.equal(x.el.readOnly,false);assert.equal(x.el.value,'');
});
test('draft conflict and session switch retain unacknowledged input without sending it',{skip:!JSDOM},t=>{
 const x=setup(t);type(x,'本地未同步');const id=x.events[0].editId;x.snap(2,'外部草稿',{settledEditId:id,editConflict:true});assert.equal(x.el.value,'本地未同步');assert.match(x.status.textContent,/草稿已变化/);submit(x);assert.equal(x.events.length,1);
 const y=setup(t);type(y,'旧会话草稿');y.snap(1,'新会话内容',{sessionToken:'s2'});assert.equal(y.el.value,'旧会话草稿');assert.equal(y.el.readOnly,true);assert.match(y.status.textContent,/会话已切换/);submit(y);assert.equal(y.events.length,1);
});
test('IME composition waits until completion and cannot submit mid-composition',{skip:!JSDOM},t=>{
 const x=setup(t);x.el.dispatchEvent(new x.w.CompositionEvent('compositionstart',{bubbles:true}));type(x,'你');submit(x);assert.equal(x.events.length,0);x.el.dispatchEvent(new x.w.CompositionEvent('compositionend',{bubbles:true}));assert.equal(x.events.length,1);assert.equal(x.events[0].value,'你');
});
test('expand waits for all pending edits and IME before closing the floating input',{skip:!JSDOM},t=>{
 const x=setup(t);type(x,'a');type(x,'ab');x.expand.click();assert.deepEqual(x.events.map(e=>e.type),['edit']);assert.equal(x.el.readOnly,true);
 x.snap(2,'a',{settledEditId:x.events[0].editId});assert.deepEqual(x.events.map(e=>e.type),['edit','edit']);
 x.snap(3,'ab',{settledEditId:x.events[1].editId});assert.deepEqual(x.events.map(e=>e.type),['edit','edit','expand']);
 const y=setup(t);y.el.dispatchEvent(new y.w.CompositionEvent('compositionstart',{bubbles:true}));type(y,'你');y.expand.click();assert.equal(y.events.length,0);assert.equal(y.el.readOnly,false);
 y.el.dispatchEvent(new y.w.CompositionEvent('compositionend',{bubbles:true}));assert.equal(y.events[0].type,'edit');y.snap(2,'你',{settledEditId:y.events[0].editId});assert.equal(y.events[1].type,'expand');
});
test('conflicted and composing-on-switch drafts remain visible until user explicitly confirms expansion',{skip:!JSDOM},t=>{
 const x=setup(t);type(x,'未同步');x.expand.click();x.snap(2,'外部草稿',{settledEditId:x.events[0].editId,editConflict:true});assert.equal(x.el.value,'未同步');assert.equal(x.events.some(e=>e.type==='expand'),false);
 x.expand.click();assert.match(x.status.textContent,/保留在本机/);assert.equal(x.events.some(e=>e.type==='expand'),false);x.expand.click();assert.equal(x.events.at(-1).type,'expand');
 const y=setup(t);y.el.dispatchEvent(new y.w.CompositionEvent('compositionstart',{bubbles:true}));type(y,'正在输入');y.snap(1,'新会话',{sessionToken:'s2'});assert.equal(y.el.value,'正在输入');assert.match(y.status.textContent,/会话已切换/);y.el.dispatchEvent(new y.w.CompositionEvent('compositionend',{bubbles:true}));assert.equal(y.events.length,0);
});
test('unsynced drafts survive a recreated view per session without automatic replay',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const old=setup(t,{storage});type(old,'私人未确认');assert.equal(records.size,1);
 const other=setup(t,{storage,initial:{sessionToken:'s2'}});assert.equal(other.el.value,'');assert.equal(other.events.length,0);
 const restored=setup(t,{storage});assert.equal(restored.el.value,'私人未确认');assert.equal(restored.el.readOnly,true);assert.match(restored.status.textContent,/未同步的本地草稿/);assert.equal(restored.events.length,0);assert.equal(restored.copy.hidden,false);
 restored.copy.click();assert(restored.status.textContent.includes(/Mac/i.test(restored.w.navigator.platform)?'⌘C':'Ctrl+C'));restored.expand.click();assert.equal(records.size,1);restored.expand.click();assert.equal(restored.events.at(-1).type,'expand');assert.equal(records.size,1);
});
test('confirmed expansion retains an uncopied draft across reopening until native state matches',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const old=setup(t,{storage});type(old,'尚未复制的内容');old.snap(2,'原生内容',{settledEditId:old.events[0].editId,editConflict:true});
 old.expand.click();assert.match(old.status.textContent,/保留在本机/);assert.equal(old.events.some(e=>e.type==='expand'),false);old.expand.click();assert.equal(old.events.at(-1).type,'expand');assert.equal(records.size,1);
 const reopened=setup(t,{storage});assert.equal(reopened.el.value,'尚未复制的内容');assert.equal(reopened.el.readOnly,true);assert.equal(reopened.events.length,0);
 // Selecting text does not prove that clipboard copying succeeded. A failed
 // or skipped copy must still leave the recovery available on next opening.
 reopened.copy.click();reopened.expand.click();reopened.expand.click();assert.equal(records.size,1);
 const again=setup(t,{storage});assert.equal(again.el.value,'尚未复制的内容');assert.equal(again.el.readOnly,true);
 const matched=setup(t,{storage,initial:{value:'尚未复制的内容'}});assert.equal(matched.el.value,'尚未复制的内容');assert.equal(matched.el.readOnly,false);assert.equal(records.size,0);
});
test('confirmed native drafts clear only their own recovery record, including IME',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const x=setup(t,{storage});x.el.dispatchEvent(new x.w.CompositionEvent('compositionstart',{bubbles:true}));type(x,'猫');assert.equal(records.size,1);
 const restored=setup(t,{storage});assert.equal(restored.el.value,'猫');assert.equal(restored.events.length,0);
 x.el.dispatchEvent(new x.w.CompositionEvent('compositionend',{bubbles:true}));x.snap(2,'猫',{settledEditId:x.events[0].editId});assert.equal(records.size,0);
});
test('storage failure is visible and never prevents native draft synchronization',{skip:!JSDOM},t=>{
 const storage={getItem(){throw Error('unavailable')},setItem(){throw Error('unavailable')},removeItem(){throw Error('unavailable')}};
 const x=setup(t,{storage});type(x,'暂存');assert.match(x.status.textContent,/不能保存到本机/);assert.equal(x.events[0].type,'edit');
 x.snap(2,'暂存',{settledEditId:x.events[0].editId});assert.equal(x.el.value,'暂存');assert.equal(x.events.length,1);
});
test('failed recovery storage blocks expansion of a conflicted unsynced draft',{skip:!JSDOM},t=>{
 const storage={getItem(){throw Error('unavailable')},setItem(){throw Error('unavailable')},removeItem(){throw Error('unavailable')}};
 const x=setup(t,{storage});type(x,'唯一副本');x.snap(2,'原生草稿',{settledEditId:x.events[0].editId,editConflict:true});
 x.copy.click();x.expand.click();x.expand.click();assert.equal(x.events.some(e=>e.type==='expand'),false);
 assert.equal(x.el.value,'唯一副本');assert.equal(x.el.readOnly,true);assert.match(x.status.textContent,/保持窗口打开/);
});
test('confirmation in one session leaves another session recovery untouched',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const one=setup(t,{storage});type(one,'session one');const two=setup(t,{storage,initial:{sessionToken:'s2'}});type(two,'session two');assert.equal(records.size,2);
 two.snap(2,'session two',{sessionToken:'s2',settledEditId:two.events[0].editId});assert.equal(records.size,1);
 const restored=setup(t,{storage});assert.equal(restored.el.value,'session one');assert.equal(restored.el.readOnly,true);assert.equal(restored.events.length,0);
});
test('a lost edit acknowledgment cannot strand or overwrite a hidden draft',{skip:!JSDOM},t=>{
 let timeout;const x=setup(t,{setTimeout:fn=>{timeout=fn;return 1},clearTimeout:()=>{}});type(x,'等待确认的草稿');assert.equal(x.events.length,1);timeout();
 assert.equal(x.el.value,'等待确认的草稿');assert.equal(x.el.readOnly,true);assert.match(x.status.textContent,/无法确认/);assert.equal(x.copy.hidden,false);
 submit(x);assert.equal(x.events.length,1);x.expand.click();assert.equal(x.events.length,1);x.expand.click();assert.equal(x.events.at(-1).type,'expand');
});
test('a lost submission acknowledgment preserves the text and prevents an automatic retry',{skip:!JSDOM},t=>{
 let timeout; const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const x=setup(t,{storage,setTimeout:fn=>{timeout=fn;return 1},clearTimeout:()=>{}});x.snap(2,'可能已发送的任务');submit(x);
 assert.equal(x.events.length,1);assert.equal(x.events[0].type,'submit');assert.equal(x.el.readOnly,true);assert.equal(records.size,1,'save before dispatch in case the app exits');
 // Native state can advance before its submit reply; never erase the only
 // visible copy until the request is settled.
 x.snap(3,'');assert.equal(x.el.value,'可能已发送的任务');timeout();
 assert.equal(x.el.value,'可能已发送的任务');assert.equal(x.el.readOnly,true);assert.match(x.status.textContent,/可能已发送/);assert.equal(records.size,1);
 submit(x);assert.equal(x.events.length,1,'unknown result must not be retried');
 x.snap(3,'',{settledSubmitId:x.events[0].submissionId});assert.equal(x.el.value,'可能已发送的任务');assert.equal(records.size,1);assert.match(x.status.textContent,/勿重复发送/);
 x.expand.click();assert.equal(x.events.length,1);assert.match(x.status.textContent,/核对后/);x.expand.click();assert.equal(x.events.at(-1).type,'expand');assert.equal(records.size,0);
});
test('an unacknowledged submission remains marked uncertain after restart even if native draft matches',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const old=setup(t,{storage});old.snap(2,'需核对的任务');submit(old);assert.equal(records.size,1);
 const restored=setup(t,{storage,initial:{value:'需核对的任务'}});assert.equal(restored.el.value,'需核对的任务');assert.equal(restored.el.readOnly,true);assert.match(restored.status.textContent,/可能已发送/);submit(restored);assert.equal(restored.events.length,0);
 restored.expand.click();assert.match(restored.status.textContent,/核对后/);assert.equal(records.size,1);restored.expand.click();assert.equal(restored.events.at(-1).type,'expand');assert.equal(records.size,0);
});
test('an acknowledged submission cancels its timeout and clears its recovery copy',{skip:!JSDOM},t=>{
 let timeout,cleared=false;const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const x=setup(t,{storage,setTimeout:fn=>{timeout=fn;return 37},clearTimeout:id=>{if(id===37)cleared=true}});x.snap(2,'已经交付的任务');submit(x);assert.equal(records.size,1);
 x.snap(3,'',{settledSubmitId:x.events[0].submissionId});assert.equal(cleared,true);assert.equal(records.size,0);timeout();assert.equal(x.el.value,'');assert.equal(x.el.readOnly,false);
});
test('changing session while submission is pending protects the old session text',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const x=setup(t,{storage});x.snap(2,'旧会话任务');submit(x);x.snap(1,'新会话草稿',{sessionToken:'s2'});
 assert.equal(x.el.value,'旧会话任务');assert.equal(x.el.readOnly,true);assert.match(x.status.textContent,/可能已发送/);assert.equal(records.size,1);
 submit(x);assert.equal(x.events.filter(e=>e.type==='submit').length,1);
 const saved=JSON.parse([...records.values()][0]);assert.equal(saved.sessionToken,'s1');assert.equal(saved.value,'旧会话任务');
});

test('files waits for draft confirmation and fails closed on conflicts or absent session',{skip:!JSDOM},t=>{
 const x=setup(t),files=x.w.document.getElementById('files');type(x,'内容');files.click();assert.deepEqual(x.events.map(e=>e.type),['edit']);
 x.snap(2,'内容',{settledEditId:x.events[0].editId});assert.deepEqual(x.events.map(e=>e.type),['edit','files']);assert.equal(x.events[1].sessionToken,'s1');assert.equal(x.events[1].revision,2);
 const y=setup(t);type(y,'未同步');y.snap(2,'其他',{settledEditId:y.events[0].editId,editConflict:true});assert(y.w.document.getElementById('files').disabled);y.w.document.getElementById('files').click();assert.equal(y.events.length,1);
 const z=setup(t,{initial:{enabled:false,sessionToken:''}});assert(z.w.document.getElementById('files').disabled);z.w.document.getElementById('files').click();assert.equal(z.events.length,0);
});
