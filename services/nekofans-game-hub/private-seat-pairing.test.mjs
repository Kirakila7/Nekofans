import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSeatPairing} from './private-seat-pairing.mjs';

test('one-use pairing codes independently identify seats and expire',()=>{
 let now=1000;const pairing=createSeatPairing({now:()=>now,ttlMs:60000});
 const old=pairing.issue(0),owner=pairing.issue(0),guest=pairing.issue(1);
 assert.equal(old.code.length,24);assert.equal(pairing.redeem(old.code),null);
 assert.deepEqual(pairing.redeem(guest.code),{seat:1});assert.equal(pairing.redeem(guest.code),null);
 assert.deepEqual(pairing.redeem(owner.code),{seat:0});assert.equal(pairing.redeem(owner.code),null);
 const expired=pairing.issue(1);now+=60000;assert.equal(pairing.redeem(expired.code),null);
 assert.equal(pairing.redeem('invalid'),null);
});
