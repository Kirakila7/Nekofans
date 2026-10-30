'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom')));}catch{}
const base=path.join(__dirname,'../../apps/neko-workbench');
function setup(t){const dom=new JSDOM(fs.readFileSync(path.join(base,'native-composer.html'),'utf8'),{runScripts:'outside-only'});t.after(()=>dom.window.close());const {window:w}=dom, events=[];let receive;w.nativeComposer={send:x=>events.push(x),onState:cb=>{receive=cb;}};w.eval(fs.readFileSync(path.join(base,'native-composer.js'),'utf8'));const el=w.document.getElementById('message');const snap=(revision,value,extra={})=>receive({enabled:true,busy:false,sessionToken:'s1',revision,value,...extra});snap(1,'');return {w,el,events,snap,form:w.document.getElementById('composer'),status:w.document.getElementById('status'),expand:w.document.getElementById('expand')};}
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
