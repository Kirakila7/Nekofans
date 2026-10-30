'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const base=path.join(__dirname,'../../apps/neko-workbench');
function setup(t,options={}){const dom=new JSDOM(fs.readFileSync(path.join(base,'native-composer.html'),'utf8'),{runScripts:'outside-only',url:'https://native-workbench.invalid/'});t.after(()=>dom.window.close());const {window:w}=dom, events=[];if(options.storage)Object.defineProperty(w,'localStorage',{value:options.storage});if(options.setTimeout)w.setTimeout=options.setTimeout;if(options.clearTimeout)w.clearTimeout=options.clearTimeout;let receive;w.nativeComposer={send:x=>events.push(x),onState:cb=>{receive=cb;}};w.eval(fs.readFileSync(path.join(base,'native-composer.js'),'utf8'));const el=w.document.getElementById('message');const snap=(revision,value,extra={})=>receive({enabled:true,busy:false,sessionToken:'s1',revision,value,...extra});snap(1,'',options.initial||{});return {w,el,events,snap,form:w.document.getElementById('composer'),status:w.document.getElementById('status'),expand:w.document.getElementById('expand'),copy:w.document.getElementById('copy')};}
function type(t,value){t.el.value=value;t.el.dispatchEvent(new t.w.Event('input',{bubbles:true}));}
function submit(t){t.form.dispatchEvent(new t.w.Event('submit',{bubbles:true,cancelable:true}));}
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
 x.expand.click();assert.match(x.status.textContent,/先复制/);assert.equal(x.events.some(e=>e.type==='expand'),false);x.expand.click();assert.equal(x.events.at(-1).type,'expand');
 const y=setup(t);y.el.dispatchEvent(new y.w.CompositionEvent('compositionstart',{bubbles:true}));type(y,'正在输入');y.snap(1,'新会话',{sessionToken:'s2'});assert.equal(y.el.value,'正在输入');assert.match(y.status.textContent,/会话已切换/);y.el.dispatchEvent(new y.w.CompositionEvent('compositionend',{bubbles:true}));assert.equal(y.events.length,0);
});
test('unsynced drafts survive a recreated view per session without automatic replay',{skip:!JSDOM},t=>{
 const records=new Map(),storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const old=setup(t,{storage});type(old,'私人未确认');assert.equal(records.size,1);
 const other=setup(t,{storage,initial:{sessionToken:'s2'}});assert.equal(other.el.value,'');assert.equal(other.events.length,0);
 const restored=setup(t,{storage});assert.equal(restored.el.value,'私人未确认');assert.equal(restored.el.readOnly,true);assert.match(restored.status.textContent,/未同步的本地草稿/);assert.equal(restored.events.length,0);assert.equal(restored.copy.hidden,false);
 restored.copy.click();assert.match(restored.status.textContent,/⌘C/);restored.expand.click();assert.equal(records.size,1);restored.expand.click();assert.equal(restored.events.at(-1).type,'expand');assert.equal(records.size,0);
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
