'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {migrateChatRouting}=require('../../apps/neko-workbench/chat-routing.cjs');
test('a trial switching DSH storage restores defaults for a partial root without replacing the companion',()=>{
 const companion={id:'main',name:'大肥鱼',chatBackend:'chat-api',messages:[]};
 const state={rootId:'real-root',actors:[companion],dshRoot:{sessionId:'real-root'}};
 migrateChatRouting(state);assert.equal(state.actors[0],companion);assert.equal(state.dshRoot.id,'dsh-root');
 assert.deepEqual(state.dshRoot.messages,[]);assert.equal(state.dshRoot.sessionId,'real-root');assert.equal(state.dshRoot.active,false);
});
