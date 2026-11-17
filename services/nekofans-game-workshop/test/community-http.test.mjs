import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { createGameAuthorizationHandler } from '../community/http-authorization.mjs';
import { createCommunitySeats } from '../server/community-seats.mjs';

test('maintainer HTTP adapter uses verified community identity and one-time workshop tickets', async t => {
  const issuer='https://community.project-neko.cn', gameOrigin='https://workshop.nekofans.games';
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const user={id:'11111111-1111-4111-8111-111111111111',name:'红帽'};
  const handler=createGameAuthorizationHandler({issuer,gameOrigin,privateKey,
    authenticate:async request=>request.headers.authorization==='Bearer fixture-user'?user:null});
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const path=`http://127.0.0.1:${server.address().port}/api/game-seats/authorize`;
  const seats=createCommunitySeats({issuer,gameOrigin,publicKey});
  const flow=seats.start('publish','workshop'),query=new URL(flow.url).search;
  const request=async({method='POST',suffix=query,origin=issuer,token='fixture-user'}={})=>fetch(path+suffix,{
    method,headers:{Origin:origin,...token?{Authorization:'Bearer '+token}:{}}});
  assert.equal((await request({token:null})).status,401);
  assert.equal((await request({token:'unknown-user'})).status,401);
  assert.equal((await request({origin:'https://elsewhere.example'})).status,403);
  assert.equal((await request({method:'GET'})).status,405);
  assert.equal((await request({suffix:query+'&target=workshop'})).status,400);
  assert.equal((await request({suffix:query+'&userId='+user.id})).status,400);
  const response=await request();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const {location}=await response.json();
  const ticket=new URLSearchParams(new URL(location).hash.slice(1)).get('communitySeat');
  assert.deepEqual(Object.keys(await (await request()).json()),['location']);
  assert.equal(seats.claim(ticket,flow.cookie,'publish','workshop').id,user.id);
  assert.equal(seats.claim(ticket,flow.cookie,'publish','workshop'),null);
});
