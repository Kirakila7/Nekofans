'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const forms=require('../../apps/neko-workbench/compact-questions.js');
const {createWorkbenchQuestionController}=require('../../apps/neko-workbench/embedded-dsh/question-bridge-source.js');
const {createAgentQuestionRelay}=require('../../apps/neko-workbench/agent-question-relay.cjs');
let JSDOM;try{({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS||'','node_modules/jsdom')));}catch{}
const question=(extra={})=>({sessionId:'s1',key:'question:s1:call',revision:1,kind:'question',canAnswer:true,questions:[{id:'q1',header:'选择任务',question:'你想让我做什么？',options:[{label:'整理项目',description:'不会出现在紧凑正文中的详细说明'},{label:'检查布局',description:'第二段详细说明'}]}],...extra});
const clone=x=>JSON.parse(JSON.stringify(x));
function store(initial){let value=initial;const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set(next){value=next;for(const fn of [...listeners])fn();},count:()=>listeners.size};}
function carrier(sessionId='s1',key='question:s1:call'){
 const events=[],state=store({state:'open',channel:'waterfall',closed:false}),q={sessionId,key,kind:'question',questions:question().questions,...state,answer:async batch=>events.push(clone(batch)),holdFocus:()=>events.push('focus'),releaseFocus:()=>events.push('blur'),engage:()=>events.push('engage')};return {q,state,events};
}
test('question DTO and answers retain original labels and reject forged, duplicate or cross-question answers',()=>{
 const q=forms.normalize(question());assert(q);assert.equal(q.questions[0].options[0].label,'整理项目');
 assert.deepEqual(forms.answersFor(q,[{id:'q1',selected:['整理项目']}]),[{id:'q1',selected:['整理项目']}]);
 for(const answers of [[{id:'q2',selected:['整理项目']}],[{id:'q1',selected:['伪造选项']}],[{id:'q1',selected:['整理项目','检查布局']}],[{id:'q1',selected:['整理项目'],custom:'另一个'}],[{id:'q1',selected:['整理项目','整理项目']}],[]])assert.equal(forms.answersFor(q,answers),null);
 assert.deepEqual(forms.answersFor(q,[{id:'q1',selected:[]}]),[{id:'q1',selected:[]}],'explicit skip is a structured empty selection');
 assert.equal(forms.normalize(question({questions:[{...question().questions[0],options:[{label:'x'.repeat(2001)}]}]})),null,'oversize identity is not truncated into another answer');
});
test('compact form shows titles, preserves drafts on hide, and submits only after explicit confirmation',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<section id="q"></section><button id="toggle"></button>',{url:'https://questions.invalid'});t.after(()=>dom.window.close());const d=dom.window.document,host=d.getElementById('q'),events=[],visibility=[];
 const form=forms.mount({host,toggleButton:d.getElementById('toggle'),onAction:value=>events.push(clone(value)),onVisibility:value=>visibility.push(value)});t.after(()=>form.dispose());form.update(question());
 assert(!host.hidden);assert(!host.textContent.includes('不会出现在紧凑正文'));assert.deepEqual([...host.querySelectorAll('.cq-option')].map(b=>b.textContent),['整理项目','检查布局']);
 host.querySelector('.cq-option').click();assert.equal(events.filter(e=>e.type==='answer').length,0);
 host.querySelector('header button').click();assert(host.hidden);assert.equal(events.filter(e=>e.type==='answer').length,0);
 d.getElementById('toggle').click();assert.equal(host.querySelector('[aria-pressed=true]').textContent,'整理项目');
 host.querySelector('.cq-submit').click();await Promise.resolve();assert.deepEqual(events.find(e=>e.type==='answer').answers,[{id:'q1',selected:['整理项目']}]);
 form.update(null);form.update(question({key:'question:s1:next'}));assert(!host.hidden,'next request automatically opens after a completed request');assert.equal(host.querySelector('[aria-pressed=true]'),null,'old selection is not assigned to a new request');
});
test('multi-question form keeps custom and multi-select answers and does not remount input on countdown updates',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<section></section>',{url:'https://questions.invalid'});t.after(()=>dom.window.close());const host=dom.window.document.querySelector('section'),events=[];
 const q=question({questions:[{...question().questions[0],multiSelect:true},{id:'q2',question:'还有什么？',options:[]}]});
 const form=forms.mount({host,onAction:e=>events.push(clone(e))});t.after(()=>form.dispose());form.update(q);
 host.querySelector('.cq-option').click();[...host.querySelectorAll('footer button')].find(b=>b.textContent==='自定义').click();let input=host.querySelector('textarea');input.value='再加一项';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));form.update({...q,remainingMs:900});assert.equal(host.querySelector('textarea'),input,'timer tick preserves the editor and cursor');
 [...host.querySelectorAll('footer button')].find(b=>b.textContent==='›').click();[...host.querySelectorAll('footer button')].find(b=>b.textContent==='跳过').click();host.querySelector('.cq-submit').click();await Promise.resolve();
 assert.deepEqual(events.find(e=>e.type==='answer').answers,[{id:'q1',selected:['整理项目'],custom:'再加一项'},{id:'q2',selected:[]}]);
});
test('native carrier bridge uses the existing answer channel, fences stale requests and releases subscriptions',async()=>{
 const a=carrier(),source=store(new Map([['s1',{pendingInteraction:a.q}]])),updates=[];
 const c=createWorkbenchQuestionController({getSource:()=>source,onChange:rows=>updates.push(clone(rows))});c.refresh();const q=c.current('s1');assert(q);assert.equal(a.state.count(),1);
 assert.equal((await c.perform({...q,type:'answer',key:'old',answers:[{id:'q1',selected:['整理项目']}]})).ok,false);assert.equal(a.events.length,0);
 await c.perform({...q,type:'focus'});await c.perform({...q,type:'engage'});await c.perform({...q,type:'blur'});assert.deepEqual(a.events,['focus','engage','blur']);
 assert.equal((await c.perform({...q,type:'answer',answers:[{id:'q1',selected:['整理项目']}]})).ok,true);assert(c.current('s1').submitted);assert.equal((await c.perform({...q,type:'answer',answers:[{id:'q1',selected:['整理项目']}]})).ok,false);
 a.state.set({state:'continued',channel:'rpc',closed:false});assert(!c.current('s1').submitted);assert.match(c.current('s1').error,/重新确认/);assert.equal(a.events.filter(x=>typeof x==='object').length,1,'continuation never automatically resubmits');
 source.set(new Map());assert.equal(c.current('s1'),null);assert.equal(a.state.count(),0);c.dispose();assert.equal(source.count(),0);
});
test('question drafts survive reopening but never replay an answer or migrate to changed options',{skip:!JSDOM},t=>{
 const dom=new JSDOM('<section></section>',{url:'https://questions.invalid'});t.after(()=>dom.window.close());const host=dom.window.document.querySelector('section'),events=[];
 let form=forms.mount({host,onAction:e=>events.push(e)});form.update(question());host.querySelector('.cq-option').click();form.dispose();
 form=forms.mount({host,onAction:e=>events.push(e)});form.update(question());assert.equal(host.querySelector('[aria-pressed=true]').textContent,'整理项目');assert.equal(events.filter(e=>e.type==='answer').length,0);
 form.update(question({questions:[{...question().questions[0],options:[{label:'另一个选项'}]}]}));assert.equal(host.querySelector('[aria-pressed=true]'),null);form.dispose();
});
test('leaving the floating question window releases pristine focus without answering or engaging the wait',{skip:!JSDOM},t=>{
 const dom=new JSDOM('<section></section>',{url:'https://questions.invalid'});t.after(()=>dom.window.close());const host=dom.window.document.querySelector('section'),events=[];
 const form=forms.mount({host,onAction:e=>events.push(e)});form.update(question());host.querySelector('header button').focus();assert(events.some(e=>e.type==='focus'));dom.window.dispatchEvent(new dom.window.Event('blur'));assert.equal(events.at(-1).type,'blur');assert.equal(events.filter(e=>['answer','engage'].includes(e.type)).length,0);form.dispose();
});
test('native creation input displays pending options without replacing its normal work draft',{skip:!JSDOM},async t=>{
 const base=path.resolve(__dirname,'../../apps/neko-workbench'),dom=new JSDOM(fs.readFileSync(path.join(base,'native-composer.html'),'utf8'),{url:'https://questions.invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document,events=[];let receive;
 w.nativeComposer={send:e=>events.push(clone(e)),onState:fn=>receive=fn};for(const file of ['compact-questions.js','native-composer.js'])w.eval(fs.readFileSync(path.join(base,file),'utf8'));
 const state={value:'原有工作草稿',sessionToken:'s1',revision:1,enabled:true,busy:false,chatOnly:true,question:question()};receive(state);
 assert(!d.getElementById('question-panel').hidden);assert.equal(d.getElementById('message').value,'原有工作草稿');assert(d.getElementById('send').disabled);
 d.querySelector('#question-panel .cq-option').click();d.querySelector('#question-panel .cq-submit').click();await Promise.resolve();
 const answer=events.find(e=>e.type==='question-action'&&e.questionAction==='answer');assert(answer);assert.equal(answer.sessionId,'s1');assert.equal(events.filter(e=>e.type==='submit').length,0);assert.equal(d.getElementById('message').value,'原有工作草稿');
 receive({...state,question:question({sessionId:'s2'})});assert(d.getElementById('question-panel').hidden,'another session cannot take over this creator');
});
test('plan review keeps the full native approval surface instead of reducing it to a title-only approval',async()=>{
 const a=carrier();a.q.kind='plan-review';const source=store(new Map([['s1',{pendingInteraction:a.q}]])),opened=[];
 const c=createWorkbenchQuestionController({getSource:()=>source,openSession:id=>opened.push(id)});c.refresh();const q=c.current('s1');assert.equal(q.kind,'unsupported');assert.equal(q.canAnswer,false);
 assert.equal((await c.perform({...q,type:'answer',answers:[{id:'q1',selected:['整理项目']}]})).ok,false);assert.equal(a.events.length,0);await c.perform({...q,type:'open'});assert.deepEqual(opened,['s1']);c.dispose();
});
test('different session carriers remain separate and only the exact displayed schema can be answered',async()=>{
 const a=carrier(),b=carrier('s2','question:s2:call'),source=store(new Map([['s1',{pendingInteraction:a.q}],['s2',{pendingInteraction:b.q}]]));const c=createWorkbenchQuestionController({getSource:()=>source});c.refresh();const old=c.current('s2');
 b.q.questions=[{...b.q.questions[0],options:[{label:'新的选项'}]}];b.state.set({state:'open',channel:'waterfall',closed:false});assert.notEqual(c.current('s2').revision,old.revision);
 assert.equal((await c.perform({...old,type:'answer',answers:[{id:'q1',selected:['整理项目']}]})).ok,false);assert.equal(b.events.length,0);assert.equal(a.events.length,0);c.dispose();
});
test('pet relay binds answers to the pet session, rejects duplicates, and drops old-host requests',async()=>{
 const sent=[],wc={send:(type,value)=>sent.push({type,value})},host={webContents:wc,isDestroyed:()=>false},relay=createAgentQuestionRelay({getHost:()=>host,getSessionId:id=>id==='fish'?'s1':'s2',timeoutMs:100});
 const q=question();assert.equal(relay.accept({}, {action:'publish',items:[q]}).ok,false);relay.accept(wc,{action:'publish',items:[q]});
 assert.equal((await relay.request('other',{...q,type:'answer',answers:[{id:'q1',selected:['整理项目']}]})).ok,false);
 const request=relay.request('fish',{...q,type:'answer',answers:[{id:'q1',selected:['整理项目']}]});assert.equal(sent.length,1);
 assert.equal((await relay.request('fish',{...q,type:'answer',answers:[{id:'q1',selected:['整理项目']}]})).ok,false);
 assert.equal(relay.accept({}, {action:'result',requestId:sent[0].value.requestId,ok:true}).ok,false);relay.accept(wc,{action:'result',requestId:sent[0].value.requestId,ok:true});assert.deepEqual(await request,{ok:true});
 const waiting=relay.request('fish',{...q,type:'focus'});relay.clear();assert.equal((await waiting).ok,false);assert.equal(relay.forActor('fish'),null);relay.dispose();
});
test('question pipeline is synchronized and IPC stays on authenticated main-frame channels',()=>{
 const base=path.resolve(__dirname,'../../apps/neko-workbench'),main=fs.readFileSync(path.join(base,'main.cjs'),'utf8');
 assert.match(main,/workbench:questions'.*assertWorkbenchCaller\(event\)/);assert.match(main,/senderId.*nativePet\(actor\).*reveal/);assert.match(main,/isPaused:.*petQuestionController/);
 assert.match(fs.readFileSync(path.join(base,'native-composer-controller.cjs'),'utf8'),/event\.senderFrame !== view\.webContents\.mainFrame/);
 const controller=fs.readFileSync(path.join(base,'pet-question-controller.cjs'),'utf8');assert.match(controller,/event\.senderFrame!==row\.window\.webContents\.mainFrame/);assert.match(controller,/event\.senderFrame\?\.url!==url/);
});
