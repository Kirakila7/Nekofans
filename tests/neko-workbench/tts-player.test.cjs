'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createPlayer}=require('../../apps/neko-workbench/tts-player.js');
function harness(){
  const handlers=new Set(),events=[],calls=[],sources=[],timers=[];
  const context={currentTime:0,state:'running',destination:{},createBuffer(_channels,length,rate){const data=new Float32Array(length);return {duration:length/rate,getChannelData:()=>data,data};},createBufferSource(){const source={connect(){},disconnect(){},start(at){this.at=at;},stop(){this.stopped=true;}};sources.push(source);return source;},async resume(){this.state='running';}};
  const bridge={onEvent(fn){handlers.add(fn);return()=>handlers.delete(fn);},async speak(text,id){calls.push(['speak',text,id]);},async stop(id){calls.push(['stop',id]);}};
  let id=0;const player=createPlayer({context,bridge,createId:()=>`id${++id}`,onState:e=>events.push(e),schedule:fn=>(timers.push(fn),fn),cancel:fn=>{const i=timers.indexOf(fn);if(i>=0)timers.splice(i,1);}});
  return {context,bridge,player,events,calls,sources,timers,send:e=>handlers.forEach(fn=>fn(e))};
}
test('PCM plays in order, state starts only when scheduled, and completion waits for playback',async()=>{
  const h=harness();await h.player.speak('你好');h.send({requestId:'id1',type:'audio',pcm:'AAD//w==',sampleRate:48000});
  assert.equal(h.sources.length,1);assert.deepEqual(Array.from(h.sources[0].buffer.data),[0,-1/32768]);
  assert.deepEqual(h.events.map(e=>e.type),['queued']);h.timers.shift()();assert.deepEqual(h.events.map(e=>e.type),['queued','speaking']);
  h.send({requestId:'id1',type:'ended'});assert.equal(h.events.at(-1).type,'speaking');h.sources[0].onended();assert.equal(h.events.at(-1).type,'ended');await h.player.close();
});
test('interrupt stops playback and ignores old audio and end events',async()=>{
  const h=harness();await h.player.speak('一');h.send({requestId:'id1',type:'audio',pcm:'AAA=',sampleRate:48000});await h.player.speak('二');
  assert.equal(h.sources[0].stopped,true);assert.deepEqual(h.calls,[['speak','一','id1'],['stop','id1'],['speak','二','id2']]);
  h.send({requestId:'id1',type:'audio',pcm:'AAA=',sampleRate:48000});h.send({requestId:'id1',type:'ended'});assert.equal(h.sources.length,1);assert.equal(h.events.at(-1).requestId,'id2');await h.player.close();
});
test('invalid PCM stops the backend and reports error',async()=>{
  const h=harness();await h.player.speak('一');h.send({requestId:'id1',type:'audio',pcm:'AA==',sampleRate:48000});assert.equal(h.events.at(-1).type,'error');assert.deepEqual(h.calls.at(-1),['stop','id1']);await h.player.close();
});
test('accepts audio arriving before speak IPC has resolved',async()=>{
  const h=harness();let finish;h.bridge.speak=(_text,id)=>{h.send({requestId:id,type:'audio',pcm:'AAA=',sampleRate:48000});return new Promise(resolve=>{finish=resolve;});};
  const request=h.player.speak('早到');await new Promise(resolve=>setImmediate(resolve));assert.equal(h.sources.length,1);finish();await request;await h.player.close();
});
test('a delayed stop cannot resurrect a superseded request',async()=>{
  const h=harness();await h.player.speak('旧');let finish;h.bridge.stop=()=>new Promise(resolve=>{finish=resolve;});
  const older=h.player.speak('中');await new Promise(resolve=>setImmediate(resolve));const newest=h.player.speak('新');await newest;finish();assert.equal(await older,null);assert.equal(h.events.at(-1).requestId,'id2');
  h.bridge.stop=async()=>{};await h.player.close();
});

