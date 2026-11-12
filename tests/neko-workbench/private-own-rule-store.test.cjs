'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createOwnRuleStore}=require('../../apps/neko-workbench/private-own-rule-store.cjs');
const seat=()=>({roomId:'r'.repeat(24),seat:0});
test('only the exact successfully submitted local rule is available to that room and seat',async()=>{
 const session=seat();let sent;const store=createOwnRuleStore({getOwnSeatSession:()=>session,submitRule:async x=>{sent=x.rule;return {status:'ready'}}});
 assert.deepEqual(await store.submit({text:' 我的秘密规则 '}),{status:'ready'});assert.equal(sent,'我的秘密规则');
 assert.equal((await store.getOwnRule({roomId:session.roomId,seat:0})).text,sent);assert.equal(await store.getOwnRule({roomId:session.roomId,seat:1}),null);assert.equal(await store.getOwnRule({roomId:'other',seat:0}),null);
 assert(!JSON.stringify(store.view()).includes(sent));assert.equal((await store.submit({text:'different'})).status,'already-submitted');
});
test('ambiguous submission cannot be silently retried or asserted ready',async()=>{
 const session=seat();let calls=0;const store=createOwnRuleStore({getOwnSeatSession:()=>session,submitRule:async()=>{calls++;throw Error('network after submit')}});
 assert.equal((await store.submit({text:'测试规则'})).status,'submission-unknown');assert.equal(await store.getOwnRule({roomId:session.roomId,seat:0}),null);
 store.clear();assert.equal((await store.submit({text:'测试规则'})).status,'reconciliation-required');assert.equal(calls,1);
});
test('re-pair prevents a late successful response and cannot bypass reconciliation',async()=>{
 let active=seat(),resolve;const store=createOwnRuleStore({getOwnSeatSession:()=>active,submitRule:()=>new Promise(r=>{resolve=r})});
 const running=store.submit({text:'测试规则'});await Promise.resolve();active=seat();resolve({status:'ready'});assert.equal((await running).status,'submission-unknown');assert.equal(await store.getOwnRule({roomId:active.roomId,seat:0}),null);assert.equal((await store.submit({text:'测试规则'})).status,'reconciliation-required');
});
test('unsupported or invalid rules do not get saved',async()=>{
 const session=seat();const store=createOwnRuleStore({getOwnSeatSession:()=>session,submitRule:async()=>({status:'unsupported'})});
 assert.equal((await store.submit({text:'一个规则'})).status,'unsupported');assert.equal(await store.getOwnRule({roomId:session.roomId,seat:0}),null);assert.equal((await store.submit({text:' '})).status,'invalid');
});
test('a confirmed local rule flows into the local agent, without the opposing rule',async()=>{
 const {createPrivateAgentSession}=require('../../apps/neko-workbench/private-agent-session.cjs'), path=require('node:path');
 const root=path.resolve(__dirname,'../..'), actions=[];let passed;
 const session={...seat(),transport:{async readState(){return {ready:true,actions}},async submitMove({seat,expectedVersion,action}){actions.push({seat,action,version:expectedVersion+1});return {status:'applied',version:expectedVersion+1}}}};
 const store=createOwnRuleStore({getOwnSeatSession:()=>session,submitRule:async({rule})=>{assert.equal(rule,'本方的规则');return {status:'ready'}}});
 assert.equal((await store.submit({text:'本方的规则'})).status,'ready');
 const provider={async *stream(input){passed=input;yield {type:'delta',text:'{"action":"e2e4"}'};yield {type:'complete'}}};
 const agent=createPrivateAgentSession({repositoryRoot:root,getOwnSeatSession:()=>session,getOwnRule:store.getOwnRule,getOwnPersona:async()=>({id:'bigfish',name:'大肥鱼',prompt:'本方伙伴'}),provider});
 assert.equal((await agent.run({maxMoves:1})).status,'move-limit');assert(JSON.stringify(passed.messages).includes('本方的规则'));assert.equal(actions[0].action,'e2e4');
});
test('cancellation of a stalled submission remains unknown and cannot auto-retry',async()=>{
 const session=seat(),controller=new AbortController();let started;const ready=new Promise(resolve=>{started=resolve});const store=createOwnRuleStore({getOwnSeatSession:()=>session,submitRule:()=>{started();return new Promise(()=>{})}});
 const pending=store.submit({text:'测试规则',signal:controller.signal});await ready;controller.abort();assert.equal((await pending).status,'submission-unknown');assert.equal(store.view().status,'reconciliation-required');
});
