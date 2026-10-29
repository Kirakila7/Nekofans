'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {RETURN_HOME_TIMEOUT_MS,beginReturnHome,expireReturnHomes,selectDesktopPets,nextDesktopRefreshAt}=require('../../apps/neko-workbench/pet-roster.cjs');

const make=(id,active=false)=>({id,sessionId:id,kind:'subagent',metadataReady:true,active});
const orders={catalogOrder:['a','b'],taskOrder:[]};
test('hidden completed helpers expire even when no helper is displayed',()=>{
  const actor=make('a');beginReturnHome(actor,1000);
  assert.equal(nextDesktopRefreshAt([actor],orders,1,1000),1000+RETURN_HOME_TIMEOUT_MS);
  expireReturnHomes([actor],1000+RETURN_HOME_TIMEOUT_MS);
  assert.equal(actor.returningHome,false);assert.equal(actor.displayUntil,0);
  assert.deepEqual(selectDesktopPets([actor],orders,1,1000+RETURN_HOME_TIMEOUT_MS),[]);
});
test('an overflowed return cannot reappear after its bounded lifetime',()=>{
  const active=make('a',true),finished=make('b');beginReturnHome(finished,1000);
  assert.deepEqual(selectDesktopPets([active,finished],orders,1,2000),[active]);
  expireReturnHomes([active,finished],1000+RETURN_HOME_TIMEOUT_MS);
  active.active=false;assert.deepEqual(selectDesktopPets([active,finished],orders,1,1001+RETURN_HOME_TIMEOUT_MS),[]);
});
test('new work cancels return without interrupting active selection',()=>{
  const actor=make('a');beginReturnHome(actor,1000);actor.active=true;actor.displayUntil=0;
  expireReturnHomes([actor],2000);
  assert.equal(actor.returningHome,false);assert.deepEqual(selectDesktopPets([actor],orders,1,2000),[actor]);
});
test('invalid stale deadlines are cleared',()=>{
  const actor={...make('a'),returningHome:true,displayUntil:NaN};expireReturnHomes([actor],1000);
  assert.equal(actor.returningHome,false);assert.equal(actor.displayUntil,0);
});
