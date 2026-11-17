import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSeatAgentRunner} from './agent-match-runner.mjs';
const immediate=async()=>{};
test('explicit run waits for opponent and stops at configured move limit',async()=>{
 const queue=[{status:'waiting'},{status:'not-your-turn'},{status:'applied',seat:0,version:1,action:'e2e4'},{status:'not-your-turn'},{status:'applied',seat:0,version:3,action:'g1f3'}],events=[];
 const runner=createSeatAgentRunner({match:{async step(){return queue.shift()}},maxMoves:2,wait:immediate});
 assert.deepEqual(await runner.run({onEvent:e=>events.push(e)}),{status:'move-limit',moves:2});assert.equal(events.length,5);
});
test('uncertain submit, decision required, or conflict stops instead of repeating a turn',async()=>{
 for(const status of ['submission-unknown','decision-required','conflict','rejected']){let n=0;const runner=createSeatAgentRunner({match:{async step(){n++;return {status}}},wait:immediate});assert.deepEqual(await runner.run(),{status,moves:0});assert.equal(n,1)}
});
test('offline waiting has a bound; events expose only explicitly allowed fields',async()=>{
 let n=0;const runner=createSeatAgentRunner({match:{async step(){n++;return {status:'waiting',secret:'do-not-show'}}},wait:immediate,maxWaitCycles:3}),events=[];
 assert.deepEqual(await runner.run({onEvent:e=>events.push(e)}),{status:'wait-limit',moves:0});assert.equal(n,3);assert(!JSON.stringify(events).includes('do-not-show'));
});
test('external cancellation and overlapping starts are handled',async()=>{
 const c=new AbortController();let release;const runner=createSeatAgentRunner({match:{async step(){return {status:'waiting'}}},wait:(_ms,signal)=>new Promise((resolve,reject)=>{release=()=>reject(Error('abort'));signal.addEventListener('abort',release,{once:true})})});
 const one=runner.run({signal:c.signal});await Promise.resolve();await Promise.resolve();assert.equal((await runner.run()).status,'busy');c.abort();assert.equal((await one).status,'cancelled');
});
test('a broken event listener cannot mask an uncertain submission',async()=>{
 const runner=createSeatAgentRunner({match:{async step(){return {status:'submission-unknown'}}},wait:immediate});
 assert.deepEqual(await runner.run({onEvent(){throw Error('view closed')}}),{status:'submission-unknown',moves:0});
});
test('retries bounded pre-submission failures and never leaks error data',async()=>{
 const queue=[{status:'room-unavailable',secret:'hide'},{status:'model-timeout',secret:'hide'},{status:'applied',seat:0,version:1,action:'e2e4'}],waits=[],events=[];
 const runner=createSeatAgentRunner({match:{async step(){return queue.shift()}},maxMoves:1,wait:async ms=>waits.push(ms)});
 assert.deepEqual(await runner.run({onEvent:e=>events.push(e)}),{status:'move-limit',moves:1});
 assert.deepEqual(waits,[2000,4000]);assert(!JSON.stringify(events).includes('hide'));
});
test('persistent pre-submission failure stops at its retry limit',async()=>{
 let n=0;const runner=createSeatAgentRunner({match:{async step(){n++;return {status:'model-unavailable'}}},maxTransientRetries:2,wait:immediate});
 assert.deepEqual(await runner.run(),{status:'model-unavailable',moves:0});assert.equal(n,3);
});
