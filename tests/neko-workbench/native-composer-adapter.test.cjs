'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeComposerAdapter} = require('../../apps/neko-workbench/embedded-dsh/native-composer-source.js');

function fixture(options = {}) {
  let selection = {sessionId:'s1'}, main = 's1', selectionListener = null;
  const bindings = new Map(), shells = new Map(), changes = [];
  function add(id) {
    const listeners = new Set(), state = {draft:'old draft', draftRev:1, phase:'plain', attachmentIds:[], occurrences:[]};
    const shell = { sends:0, saves:0, state:{getSnapshot:()=>({...state}), subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}}, actions:{
      setDraft(text){state.draft = text;state.draftRev++;for(const fn of listeners)fn();},
      persistDraft(){shell.saves++;}, submit(){shell.sends++;},
    }};
    bindings.set(id,{sessionId:id,session:{sessionId:id}}); shells.set(id,{shell,state,listeners});
    return shells.get(id);
  }
  const first = add('s1'); add('s2');
  const api = createNativeComposerAdapter({
    getSelection:()=>selection, getMainSessionId:()=>main, getBinding:id=>bindings.get(id),
    getShell:(_binding,id)=>shells.get(id)?.shell,
    subscribeSelection(fn){selectionListener=fn;return()=>{selectionListener=null;}},
    onChange:state=>changes.push(state),
    ...options,
  });
  return {api,first,shells,bindings,changes,select(value){selection=value;selectionListener?.();}, main(value){main=value;}};
}

test('adapter updates and persists only the current retained native session draft', () => {
  const f=fixture(), initial=f.api.snapshot();
  assert.equal(initial.sessionId,'s1'); assert.equal(initial.draft,'old draft');
  const result=f.api.write({sessionId:'s1',revision:1,text:'new draft'});
  assert.equal(result.ok,true); assert.equal(result.state.draft,'new draft'); assert.equal(result.state.revision,2);
  assert.equal(f.first.shell.saves,1); assert.equal(f.shells.get('s2').state.draft,'old draft');
  f.api.dispose(); assert.equal(f.first.listeners.size,0);
});

test('stale revisions, session switches, missing binding and composition fail closed', async () => {
  const f=fixture();
  assert.equal(f.api.write({sessionId:'s1',revision:0,text:'bad'}).code,'draft_changed');
  assert.equal(f.api.write({sessionId:'s1',revision:1,text:'bad',composing:true}).code,'composing');
  assert.equal(f.api.submit({sessionId:'s1',revision:1,composing:true}).code,'composing');
  f.select({sessionId:'s2'}); // The official selection can lead the retained reference.
  assert.equal(f.api.snapshot().available,false);
  assert.equal(f.api.write({sessionId:'s1',revision:1,text:'bad'}).ok,false);
  f.main('s2'); await Promise.resolve();
  assert.equal(f.api.snapshot().sessionId,'s2');
  assert.equal(f.api.write({sessionId:'s1',revision:1,text:'bad'}).code,'session_changed');
  f.bindings.delete('s2'); assert.equal(f.api.snapshot().available,false);
  assert.equal(f.first.state.draft,'old draft'); assert.equal(f.first.shell.sends,0);
});

test('rich drafts, command claims and busy phases cannot be overwritten or sent', () => {
  const f=fixture();
  for (const mutation of [s=>{s.attachmentIds=['a']},s=>{s.occurrences=[{}]},s=>{s.claim={token:'/x'}},s=>{s.phase='adjudicating'}]) {
    Object.assign(f.first.state,{attachmentIds:[],occurrences:[],claim:undefined,phase:'plain'}); mutation(f.first.state);
    assert.equal(f.api.snapshot().available,false);
    assert.equal(f.api.write({sessionId:'s1',revision:1,text:'overwrite'}).ok,false);
    assert.equal(f.api.submit({sessionId:'s1',revision:1}).ok,false);
  }
  assert.equal(f.first.state.draft,'old draft');assert.equal(f.first.shell.sends,0);
});

test('submit is delivered to native input only once per revision, without claiming completion', () => {
  const f=fixture(); let result=f.api.submit({sessionId:'s1',revision:1});
  assert.equal(result.ok,true); assert.equal(result.code,'submitted_to_native'); assert.equal(f.first.shell.sends,1);
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).code,'already_submitted');
  f.select({sessionId:'s2'});f.main('s2');f.api.snapshot();f.select({sessionId:'s1'});f.main('s1');f.api.snapshot();
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).code,'already_submitted');
  assert.equal(f.first.shell.sends,1);
});

test('missing native API, unexpected snapshot or changed binding never sends', () => {
  const f=fixture(); f.first.state.draftRev=undefined;
  assert.equal(f.api.snapshot().available,false);
  assert.equal(f.api.submit({sessionId:'s1',revision:1}).ok,false);
  f.first.state.draftRev=1; delete f.first.shell.actions.submit;
  assert.equal(f.api.snapshot().available,false);
  assert.equal(f.first.shell.sends,0);
});

test('native session and input errors are surfaced without claiming send success', () => {
  const f=fixture(), listeners=new Set(); let session={sessionId:'s1',pendingSubmissions:[]};
  Object.assign(f.bindings.get('s1').session,{getSnapshot:()=>session,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}});
  f.api.snapshot(); session={...session,promptError:{error:'private native details'}};
  for(const fn of listeners)fn();
  const state=f.api.snapshot();assert.match(state.status,/工作会话出现错误/);assert(!state.status.includes('private'));
  assert.equal(f.changes.at(-1).status,state.status);f.api.dispose();assert.equal(listeners.size,0);
});

test('floating task feed follows only the retained Chat target and releases the old subscription', async () => {
  const sources = new Map();
  for (const id of ['s1','s2']) {
    const listeners = new Set();
    sources.set(id,{listeners,value:{legacy:{nodes:[{kind:'user',seq:1,content:[{type:'text',text:id + ' task'}]},{kind:'assistant',seq:2,blocks:[{kind:'reasoning',text:'private reasoning'},{kind:'text',text:id + ' answer'}]},{kind:'context',seq:3,content:[{type:'text',text:'system context'}]}],partial:{turn:1,step:2,blocks:[{kind:'text',text:'live reply'}]},runningCalls:[{name:'file_read',argsRaw:'private args'}]}},getSnapshot(){return this.value},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}});
  }
  const f=fixture({getTranscript:(_binding,id)=>sources.get(id)});
  Object.assign(f.bindings.get('s1').session,{getSnapshot:()=>({running:true,openState:'open'})});
  const initial=f.api.snapshot();
  assert.deepEqual(initial.taskMessages.map(row=>row.text),['s1 task','s1 answer','live reply']);
  assert.equal(initial.taskRunning,true);assert.match(initial.taskStatus,/file_read/);
  assert(!JSON.stringify(initial).includes('private'));assert(!JSON.stringify(initial).includes('system context'));
  sources.get('s1').value.legacy.partial.blocks[0].text='stream advanced';
  for(const fn of sources.get('s1').listeners)fn();
  assert.equal(f.changes.at(-1).taskMessages.at(-1).text,'stream advanced');
  const late=[...sources.get('s1').listeners][0];
  f.select({sessionId:'s2'});f.main('s2');await Promise.resolve();
  assert.equal(sources.get('s1').listeners.size,0);late();
  assert.equal(f.changes.at(-1).sessionId,'s2');assert.equal(f.changes.at(-1).taskMessages[0].text,'s2 task');
  f.api.dispose();assert.equal(sources.get('s2').listeners.size,0);
});

test('task feed reports unavailable/error states and bounds messages without claiming completion',()=>{
  const f=fixture();assert.match(f.api.snapshot().taskStatus,/暂不可用/);
  Object.assign(f.bindings.get('s1').session,{getSnapshot:()=>({lastAgentError:'private provider error',pendingSubmissions:[{requestId:'q',text:'queued text'}]})});
  const state=f.api.snapshot();assert.match(state.taskStatus,/出现错误/);assert.equal(state.taskMessages[0].pending,true);assert(!JSON.stringify(state).includes('private provider'));
  f.api.dispose();
});
