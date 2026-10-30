'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createCompanionAccountProvider} = require('../../apps/neko-workbench/companion-account-provider.cjs');

test('passes persona, recalled memories and prior chat to account bridge once', async () => {
  const calls=[];
  const provider=createCompanionAccountProvider(async (...args)=>{calls.push(args);return {text:'你好'};});
  const signal=new AbortController().signal;
  const events=[];
  for await (const event of provider.stream({signal,maxOutputTokens:123,persona:{id:'bigfish',prompt:'妈妈人设'},memoryContext:[{text:'喜欢小鱼',certainty:'inferred',kind:'preference',evidenceRefs:['消息1']}],messages:[{personaId:'bigfish',role:'user',text:'之前'},{personaId:'bigfish',role:'assistant',text:'好的'},{personaId:'bigfish',role:'user',text:'现在'}]})) events.push(event);
  assert.equal(calls[0][0],'companion-account-chat');
  assert.equal(calls[0][1].text,'现在');
  assert.equal(calls[0][1].maxTokens,123);
  assert.match(calls[0][1].context,/妈妈人设/);
  assert.match(calls[0][1].context,/喜欢小鱼/);
  assert.match(calls[0][1].context,/"certainty":"inferred"/);
  assert.match(calls[0][1].context,/"evidenceRefs":\["消息1"\]/);
  assert.deepEqual(calls[0][1].history,[{role:'user',text:'之前'},{role:'assistant',text:'好的'}]);
  assert(!calls[0][1].context.includes('之前'));
  assert(!calls[0][1].context.includes('现在'));
  assert.deepEqual(events.map(e=>e.type),['delta','complete']);
});

test('abort asks bridge to cancel and never returns a late reply', async () => {
  const calls=[];let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const provider=createCompanionAccountProvider(async (method,args)=>{calls.push({method,args});return method==='companion-account-chat'?pending:{accepted:true};});
  const controller=new AbortController();
  const run=(async()=>{for await (const ignored of provider.stream({signal:controller.signal,persona:{prompt:''},messages:[{role:'user',text:'你好'}]})) {} })();
  controller.abort();finish({text:'迟到回复'});
  await assert.rejects(run,/Cancelled/);
  assert.deepEqual(calls.map(c=>c.method),['companion-account-chat','companion-account-cancel']);
  assert.equal(calls[0].args.requestId,calls[1].args.requestId);
});
