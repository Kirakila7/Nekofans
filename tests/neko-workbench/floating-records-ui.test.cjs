'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('/private/tmp/neko-sidebar-dom-20261026/node_modules/jsdom');
test('record selection is blocked while the draft is pending and reports resize and toggle',()=>{
 const dom=new JSDOM(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.html','utf8'),{runScripts:'outside-only',url:'https://localhost'}),w=dom.window,d=w.document,events=[];let callback;
 w.nativeComposer={send:e=>events.push(e),onState:f=>{callback=f;}};
 w.eval(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.js','utf8'));
 callback({value:'',placeholder:'',enabled:true,busy:false,sessionToken:'old',revision:3,records:[{id:'one',project:'fish',title:'任务',enabled:true}]});
 d.querySelector('#records-toggle').click();assert.equal(d.querySelector('#records').hidden,false);assert.equal(events[0].type,'records-toggle');
 d.querySelector('#records-list button').click();assert.equal(events[1].type,'record-open');assert.equal(d.querySelector('#message').readOnly,true);callback({value:'',placeholder:'',enabled:true,busy:false,sessionToken:'old',revision:3,settledRecordOpenId:events[1].openId,recordsOpen:true,records:[{id:'one',project:'fish',title:'任务',enabled:true}]});assert.equal(d.querySelector('#message').readOnly,false);
 const input=d.querySelector('#message');input.value='draft';input.dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal(events[2].type,'edit');d.querySelector('#records-list button').click();assert.equal(events.filter(e=>e.type==='record-open').length,1);assert.match(d.querySelector('#status').textContent,/草稿/);
 d.querySelector('#records-resize').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));assert.equal(events.at(-1).delta,20);w.close();
});
test('record updates preserve scrolling and focus, and expose paging and retry',()=>{
 const dom=new JSDOM(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.html','utf8'),{runScripts:'outside-only',url:'https://localhost'}),w=dom.window,d=w.document,events=[];let callback;
 w.nativeComposer={send:e=>events.push(e),onState:f=>{callback=f;}};w.eval(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.js','utf8'));
 const state={value:'',enabled:true,busy:false,sessionToken:'s',revision:2,recordsOpen:true,recordsHasMore:true,records:[{id:'dsh:a',project:'fish',title:'A',enabled:true}]};callback(state);
 const list=d.querySelector('#records-list'),row=list.querySelector('button');list.scrollTop=42;row.focus();callback({...state,status:'update'});assert.equal(list.querySelector('button'),row);assert.equal(list.scrollTop,42);assert.equal(d.activeElement,row);
 callback({...state,records:[...state.records,{id:'dsh:b',project:'fish',title:'B',enabled:true}]});assert.equal(list.scrollTop,42);assert.equal(d.activeElement.dataset.recordId,'dsh:a');
 d.querySelector('#records-more').click();d.querySelector('#records-refresh').click();assert.deepEqual(events.map(e=>e.type),['records-more','records-refresh']);w.close();
});

test('late closed-state notification does not collapse records before open is acknowledged',()=>{
 const dom=new JSDOM(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.html','utf8'),{runScripts:'outside-only',url:'https://localhost'}),w=dom.window,d=w.document;let callback;w.nativeComposer={send:()=>{},onState:f=>{callback=f}};w.eval(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.js','utf8'));
 const state={value:'',enabled:false,busy:false,sessionToken:'',revision:0,recordsOpen:false,records:[]};callback(state);d.querySelector('#records-toggle').click();assert(!d.querySelector('#records').hidden);callback(state);assert(!d.querySelector('#records').hidden);callback({...state,recordsOpen:true});assert(!d.querySelector('#records').hidden);w.close();
});

test('large pointer movements retain their full displacement',()=>{
 const dom=new JSDOM(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.html','utf8'),{runScripts:'outside-only',url:'https://localhost'}),w=dom.window,d=w.document,events=[];let callback;w.nativeComposer={send:e=>events.push(e),onState:f=>{callback=f}};w.eval(fs.readFileSync(__dirname+'/../../apps/neko-workbench/native-composer.js','utf8'));
 callback({value:'',enabled:false,busy:false,sessionToken:'',revision:0,recordsOpen:true,records:[]});const h=d.querySelector('#records-resize');h.setPointerCapture=()=>{};
 for(const [type,y] of [['pointerdown',600],['pointermove',250]]){const e=new w.MouseEvent(type,{bubbles:true,button:0,screenX:500,screenY:y});Object.defineProperty(e,'pointerId',{value:4});h.dispatchEvent(e);}assert.equal(events.at(-1).type,'records-resize');assert.equal(events.at(-1).delta,350);w.close();
});
