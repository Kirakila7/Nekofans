'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {authorizeSpeak,authorizeStop}=require('../../apps/neko-workbench/tts-guard.cjs');
test('only enabled main pet can synthesize exactly the completed reply',()=>{
  const good={senderId:'main',enabled:true,expected:'你好',input:{text:'你好',requestId:'abc-123'}};
  assert.doesNotThrow(()=>authorizeSpeak(good));
  for(const patch of [{senderId:'task'},{enabled:false},{expected:null},{input:{text:'私密信息',requestId:'abc-123'}},{input:{text:'你好',requestId:'../a'}}])assert.throws(()=>authorizeSpeak({...good,...patch}));
});
test('stop is restricted to the settings window or a matching main-pet request id',()=>{
  assert.doesNotThrow(()=>authorizeStop({senderId:'main',isSettings:false,input:{requestId:'abc'}}));
  assert.doesNotThrow(()=>authorizeStop({isSettings:true,input:{}}));
  assert.throws(()=>authorizeStop({senderId:'task',input:{requestId:'abc'}}));
  assert.throws(()=>authorizeStop({senderId:'main',input:{requestId:''}}));
});
