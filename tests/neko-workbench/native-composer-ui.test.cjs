'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const base=path.join(__dirname,'../../apps/neko-workbench');
function setup(t,options={}){const dom=new JSDOM(fs.readFileSync(path.join(base,'native-composer.html'),'utf8'),{runScripts:'outside-only',url:'https://native-workbench.invalid/'});t.after(()=>dom.window.close());const {window:w}=dom, events=[];if(options.storage)Object.defineProperty(w,'localStorage',{value:options.storage});if(options.setTimeout)w.setTimeout=options.setTimeout;if(options.clearTimeout)w.clearTimeout=options.clearTimeout;let receive;w.nativeComposer={send:x=>events.push(x),onState:cb=>{receive=cb;}};w.eval(fs.readFileSync(path.join(base,'hold-drag.js'),'utf8'));w.eval(fs.readFileSync(path.join(base,'native-composer.js'),'utf8'));const el=w.document.getElementById('message');const snap=(revision,value,extra={})=>receive({enabled:true,busy:false,sessionToken:'s1',revision,value,...extra});snap(1,'',options.initial||{});return {w,el,events,snap,form:w.document.getElementById('composer'),status:w.document.getElementById('status'),expand:w.document.getElementById('expand'),copy:w.document.getElementById('copy')};}
function type(t,value){t.el.value=value;t.el.dispatchEvent(new t.w.Event('input',{bubbles:true}));}
function submit(t){t.form.dispatchEvent(new t.w.Event('submit',{bubbles:true,cancelable:true}));}

test('creation desk is a compact input with accessible model and closable history menus',{skip:!JSDOM},t=>{
 const x=setup(t,{initial:{chatOnly:true}}),d=x.w.document;
 assert.equal(x.el.placeholder,'创造台');assert(d.getElementById('window-drag').hidden);assert(d.getElementById('target').hidden);
 const toggle=d.getElementById('model-toggle');assert.equal(x.form.firstElementChild,toggle);toggle.click();assert(!d.getElementById('model-panel').hidden);assert.equal(x.events.at(-1).type,'model-toggle');
 d.getElementById('records-toggle').click();assert(!d.getElementById('records').hidden);assert(d.getElementById('model-panel').hidden);
 d.getElementById('records-close').click();assert(d.getElementById('records').hidden);assert.equal(x.events.at(-1).open,false);
 toggle.click();d.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(d.getElementById('model-panel').hidden);assert.equal(x.events.at(-1).open,false);
});

test('the compact composer searches visible records and opens a match by keyboard',{skip:!JSDOM},t=>{
 const records=[{id:'dsh:s1',project:'月球',title:'修复页面',enabled:true},
  {id:'two',project:'月球',title:'布局草案',enabled:true},{id:'three',project:'海边',title:'布局草案',enabled:true}];
 const x=setup(t,{initial:{chatOnly:true,records,recordsHasMore:true}}),d=x.w.document;
 const key=(target,options)=>target.dispatchEvent(new x.w.KeyboardEvent('keydown',{...options,bubbles:true,cancelable:true}));
 key(x.el,{key:'k',metaKey:true});
 const search=d.getElementById('records-search');
 assert.equal(d.activeElement,search);assert.equal(x.events.at(-1).type,'records-toggle');
 assert.equal(d.querySelector('#records-list [aria-current=true]').dataset.recordId,'dsh:s1');
 search.value='月球 布局';search.dispatchEvent(new x.w.Event('input',{bubbles:true}));
 assert.deepEqual(Array.from(d.querySelectorAll('#records-list button'),row=>row.dataset.recordId),['two']);
 assert.match(d.getElementById('records-status').textContent,/可加载更多/);
 key(search,{key:'Enter',isComposing:true});assert.equal(x.events.at(-1).type,'records-toggle');
 key(search,{key:'ArrowDown'});assert.equal(d.activeElement.dataset.recordId,'two');
 key(d.activeElement,{key:'ArrowUp'});assert.equal(d.activeElement,search);
 key(search,{key:'Enter'});assert.equal(x.events.at(-1).type,'record-open');assert.equal(x.events.at(-1).id,'two');
 x.snap(1,'',{records,chatOnly:true,recordsOpen:true,settledRecordOpenId:x.events.at(-1).openId});
 key(search,{key:'Escape'});assert(d.getElementById('records').hidden);assert.equal(d.activeElement.id,'model-toggle');
});

test('model choice is catalog-bound and holds sends until the matching selection acknowledgement',{skip:!JSDOM},t=>{
 const options=[{id:'flash',label:'DeepSeek-V4.1-Flash',reasoningOptions:[{id:'high',label:'High'}]},{id:'other',label:'Other model',reasoningOptions:[{id:'high',label:'High'}]}];
 const fields={chatOnly:true,modelOptions:options,modelId:'flash',modelLabel:'DeepSeek-V4.1-Flash',reasoningId:'high',reasoningLabel:'High'};
 const x=setup(t,{initial:fields}),d=x.w.document;x.snap(1,'保留任务草稿',fields);
 const select=d.getElementById('model-select');select.value='other';select.dispatchEvent(new x.w.Event('change',{bubbles:true}));
 const request=x.events.at(-1);assert.equal(request.type,'model-select');assert.equal(request.modelId,'other');assert.equal(request.reasoningId,'high');assert.equal(request.sessionToken,'s1');assert(request.selectionId>0);
 assert(d.getElementById('send').disabled);assert(x.el.readOnly);submit(x);assert.equal(x.events.filter(event=>event.type==='submit').length,0);
 x.snap(1,'保留任务草稿',{...fields,modelBusy:true});assert(d.getElementById('send').disabled);
 x.snap(1,'保留任务草稿',{...fields,modelId:'other',modelLabel:'Other model',settledModelSelectionId:request.selectionId});
 assert(!d.getElementById('send').disabled);assert(!x.el.readOnly);assert.equal(x.el.value,'保留任务草稿');assert.equal(select.value,'other');
 x.snap(1,'保留任务草稿',{...fields,reasoningId:''});assert.equal(d.getElementById('reasoning-select').selectedOptions[0].textContent,'使用模型默认值');
});

test('uncertain model changes require a confirmed refresh, and model errors block task submission',{skip:!JSDOM},t=>{
 let timeout;const fields={modelOptions:[{id:'flash',label:'DeepSeek-V4.1-Flash',reasoningOptions:[{id:'high',label:'High'}]}],modelId:'flash',reasoningId:'high'};
 const x=setup(t,{initial:fields,setTimeout:fn=>{timeout=fn;return 71},clearTimeout:()=>{}}),d=x.w.document;x.snap(1,'保留任务',fields);
 d.getElementById('reasoning-select').dispatchEvent(new x.w.Event('change',{bubbles:true}));const selection=x.events.at(-1);timeout();assert(d.getElementById('send').disabled);
 d.getElementById('model-refresh').click();assert.equal(x.events.at(-1).selectionId,selection.selectionId);
 x.snap(1,'保留任务',fields);assert(d.getElementById('send').disabled);
 x.snap(1,'保留任务',{...fields,settledModelSelectionId:selection.selectionId});assert(!d.getElementById('send').disabled);
 x.snap(1,'保留任务',{...fields,modelError:'默认模型暂不可用'});submit(x);assert(d.getElementById('send').disabled);assert.equal(x.events.some(event=>event.type==='submit'),false);assert.equal(x.el.value,'保留任务');
});
test('floating composer serializes edits and submits only the latest acknowledged draft',{skip:!JSDOM},t=>{
 const x=setup(t);type(x,'a');type(x,'ab');assert.equal(x.events.length,1);assert.equal(x.events[0].value,'a');submit(x);assert.equal(x.events.length,1);assert.equal(x.el.readOnly,true);
 x.snap(2,'a',{settledEditId:x.events[0].editId});assert.equal(x.events.length,2);assert.equal(x.events[1].value,'ab');assert.equal(x.events[1].revision,2);
 x.snap(3,'ab',{settledEditId:x.events[1].editId});assert.equal(x.events.length,3);assert.equal(x.events[2].type,'submit');assert.equal(x.events[2].value,'ab');assert.equal(x.events[2].revision,3);
 x.snap(3,'ab');assert.equal(x.el.readOnly,true);x.snap(4,'',{settledSubmitId:x.events[2].submissionId});assert.equal(x.el.readOnly,false);assert.equal(x.el.value,'');
});
test('daily chat-only input retains project records, draft edits and send but hides full workspace actions',{skip:!JSDOM},t=>{
 const x=setup(t,{initial:{chatOnly:true,recordsOpen:false}}),files=x.w.document.getElementById('files'),records=x.w.document.getElementById('records-toggle');
 assert(x.expand.hidden);assert(files.hidden);assert(!records.hidden);assert.match(x.w.document.getElementById('target').textContent,/项目记录/);
 x.expand.click();files.click();assert.equal(x.events.length,0);records.click();assert.equal(x.events.at(-1).type,'records-toggle');
 type(x,'日常工作草稿');const edit=x.events.at(-1);assert.equal(edit.type,'edit');x.snap(2,'日常工作草稿',{chatOnly:true,settledEditId:edit.editId});submit(x);assert.equal(x.events.at(-1).type,'submit');assert.equal(x.events.at(-1).value,'日常工作草稿');
});
test('work floating handle long-presses anywhere without editing or submitting the draft',{skip:!JSDOM},async t=>{
 const x=setup(t);x.snap(1,'保留工作草稿');const handle=x.w.document.getElementById('window-drag');handle.dispatchEvent(new x.w.MouseEvent('pointerdown',{button:0,screenX:300,screenY:200}));await new Promise(r=>setTimeout(r,410));handle.dispatchEvent(new x.w.MouseEvent('pointermove',{screenX:340,screenY:230}));assert.deepEqual(x.events.map(e=>e.type),['move']);assert.equal(x.events[0].dx,40);assert.equal(x.events[0].dy,30);assert.equal(x.el.value,'保留工作草稿');handle.dispatchEvent(new x.w.MouseEvent('pointerup'));handle.dispatchEvent(new x.w.MouseEvent('pointermove',{screenX:400,screenY:400}));assert.equal(x.events.length,2);assert.equal(x.events[1].finished,true);assert.equal(x.events[1].dx,0);assert.equal(x.events[1].dy,0);assert.equal(x.el.value,'保留工作草稿');handle.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert.equal(x.events.at(-1).reset,true);
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
 restored.copy.click();assert.match(restored.status.textContent,/⌘C/);restored.expand.click();assert.equal(records.size,1);restored.expand.click();assert.equal(restored.events.at(-1).type,'expand');assert.equal(records.size,1);
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
 x.expand.click();assert.equal(x.events.length,1);assert.match(x.status.textContent,/本机副本会保留/);x.expand.click();assert.equal(x.events.at(-1).type,'expand');assert.equal(records.size,1);
});
test('an unacknowledged submission remains marked uncertain after restart even if native draft matches',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const old=setup(t,{storage});old.snap(2,'需核对的任务');submit(old);assert.equal(records.size,1);
 const restored=setup(t,{storage,initial:{value:'需核对的任务'}});assert.equal(restored.el.value,'需核对的任务');assert.equal(restored.el.readOnly,true);assert.match(restored.status.textContent,/可能已发送/);submit(restored);assert.equal(restored.events.length,0);
 restored.expand.click();assert.match(restored.status.textContent,/本机副本会保留/);assert.equal(records.size,1);restored.expand.click();assert.equal(restored.events.at(-1).type,'expand');assert.equal(records.size,1);
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

test('lobby target must be identified before sending, and updates follow the session',{skip:!JSDOM},t=>{
 const x=setup(t),target=x.w.document.getElementById('target'),send=x.w.document.getElementById('send');
 x.snap(1,'draft',{targetRequired:true,targetLabel:''});assert.match(target.textContent,/未确认/);assert.equal(send.disabled,true);submit(x);assert.equal(x.events.length,0);
 x.snap(1,'draft',{targetRequired:true,targetLabel:'示例项目 · 工作会话'});assert.match(target.textContent,/示例项目 · 工作会话/);assert.equal(send.disabled,false);
 x.snap(2,'',{sessionToken:'s2',targetRequired:true,targetLabel:''});assert.match(target.textContent,/未确认/);assert.equal(send.disabled,true);
});

test('an explicit uncertain native-submit result retains the recovery and blocks repeat',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const x=setup(t,{storage});type(x,'可能已发送');const edit=x.events.at(-1);x.snap(2,'可能已发送',{settledEditId:edit.editId});submit(x);
 const submission=x.events.at(-1);assert.equal(submission.type,'submit');x.snap(2,'可能已发送',{settledSubmitId:submission.submissionId,submitUnknown:true});
 assert.match(x.status.textContent,/可能已发送/);assert.equal(x.el.value,'可能已发送');assert.equal(x.el.readOnly,true);assert.equal(records.size,1);
 submit(x);assert.equal(x.events.filter(e=>e.type==='submit').length,1);
 x.expand.click();assert.match(x.status.textContent,/本机副本会保留/);assert.equal(records.size,1);assert.equal(x.events.some(e=>e.type==='expand'),false);
 x.expand.click();assert.equal(x.events.at(-1).type,'expand');assert.equal(records.size,1,'expanding must not delete the only recovery copy');
 const reopened=setup(t,{storage});assert.equal(reopened.el.value,'可能已发送');assert.equal(reopened.el.readOnly,true);assert.match(reopened.status.textContent,/可能已发送/);assert.equal(reopened.events.length,0);assert.equal(records.size,1);
});
