'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ScreenObservation } = require('../../apps/neko-workbench/screen-observation-runtime.cjs');
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([255,216,...Array(30).fill(7)]).toString('base64');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = n => ({ id: `window:${n}:0`, name: 'selected '+n });
function frame(runtime, seq) { return { generation: runtime.generation, seq, capturedAt: Date.now(), width: 640, height: 360, image: jpeg }; }
function fixture(t, extra={}) {
  const jobs=[], replies=[];
  const runtime=new ScreenObservation({intervalMs:1,onReply:value=>replies.push(value),observe:input=>new Promise((resolve,reject)=>jobs.push({input,resolve,reject})),...extra});
  t.after(()=>runtime.stop());runtime.start(source(1));return {runtime,jobs,replies};
}
test('one in-flight request and latest-only backpressure binds each exact frame',async t=>{
  const {runtime:r,jobs}=fixture(t);r.frame(frame(r,1));r.frame(frame(r,2));r.frame(frame(r,3));assert.equal(jobs.length,1);assert.equal(r.latest.seq,3);
  jobs[0].resolve({text:'first'});await tick();assert.equal(jobs.length,2);assert.equal(jobs[1].input.frame.seq,3);assert.equal(r.records[0].text,'first');
  jobs[1].resolve({text:'third'});await tick();assert.deepEqual(r.records.map(x=>x.text),['first','third']);assert(!JSON.stringify(r.read()).includes('base64'));
});
test('pause clears partial reply and rejects both old frames and late chunks/completion',async t=>{
  const {runtime:r,jobs,replies}=fixture(t);const old=frame(r,1);r.frame(old);jobs[0].input.onText('partial');assert.equal(r.reply.streaming,true);
  r.pause();const n=replies.length;jobs[0].input.onText('late');jobs[0].resolve({text:'late'});await tick();assert.equal(replies.length,n);assert.equal(r.records.length,0);assert.equal(r.frame(old).accepted,false);assert.equal(r.reply,null);
});
test('changing source invalidates stale work and keeps new source frame isolated',async t=>{
  const {runtime:r,jobs}=fixture(t);r.frame(frame(r,1));r.start(source(2));r.frame(frame(r,1));jobs[0].resolve({text:'old-source'});await tick();
  assert.equal(jobs.length,2);assert.equal(r.source.id,'window:2:0');assert.equal(r.records.length,0);jobs[1].resolve({text:'new-source'});await tick();assert.equal(r.records[0].text,'new-source');
});
test('question interrupts auto observation and takes priority over sampling',async t=>{
  const {runtime:r,jobs}=fixture(t);r.frame(frame(r,1));r.ask('what is this');assert(jobs[0].input.signal.aborted);r.frame(frame(r,2));jobs[0].resolve({text:'discard'});await tick();
  assert.equal(jobs[1].input.question,'what is this');assert.equal(jobs[1].input.frame.seq,2);jobs[1].resolve({text:'answer'});await tick();assert.equal(r.records[0].question,'what is this');
});
test('quiet responses are suppressed, duplicate replies do not spam, and budget pauses',async t=>{
  const {runtime:r,jobs,replies}=fixture(t,{maxRequests:2});r.frame(frame(r,1));jobs[0].input.onText('[安');jobs[0].input.onText('[安静]');jobs[0].resolve({text:'[安静]'});await tick();assert(!replies.some(x=>x?.text));assert.equal(r.capability,'responded');
  r.frame(frame(r,2));await new Promise(resolve=>setTimeout(resolve,5));jobs[1].resolve({text:'hello'});await tick();r.frame(frame(r,3));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(jobs.length,2);assert.equal(r.phase,'paused');
});
test('bad frame bounds, time and sequence are rejected before invoking provider',t=>{
  const {runtime:r,jobs}=fixture(t);for(const patch of [{seq:-1},{capturedAt:0},{width:8000},{image:'data:image/jpeg;base64,notimage'}])assert.throws(()=>r.frame({...frame(r,1),...patch}));assert.equal(jobs.length,0);
  r.frame(frame(r,1));assert.throws(()=>r.frame(frame(r,1)));jobs[0].resolve({text:'ok'});
});
test('regular chat busy defers observation and stop clears waiting frames',async t=>{
  const {runtime:r,jobs}=fixture(t,{isChatBusy:()=>true});r.frame(frame(r,1));assert.equal(jobs.length,0);r.stop();await tick();assert.equal(jobs.length,0);assert.equal(r.latest,null);
});
test('provider failure pauses instead of retrying indefinitely',async t=>{
  const {runtime:r,jobs}=fixture(t);r.frame(frame(r,1));jobs[0].reject(Object.assign(new Error('image model required'),{code:'api'}));await tick();assert.equal(r.phase,'paused');assert.equal(r.error,'image model required');assert.equal(r.requests,1);
});

test('resume keeps bounded completed text and repeated queued questions are rejected instead of lost',async t=>{
 const {runtime:r,jobs}=fixture(t);r.frame(frame(r,1));jobs[0].resolve({text:'completed observation'});await tick();r.pause();r.start(source(1));assert.equal(r.records[0].text,'completed observation');
 r.ask('first queued');assert.throws(()=>r.ask('must not overwrite'),/等待/);r.frame(frame(r,1));await tick();assert.equal(jobs[1].input.question,'first queued');jobs[1].resolve({text:'answer'});await tick();
});
