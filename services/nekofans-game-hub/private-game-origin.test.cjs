'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GAME_ORIGIN, parsePrivateRoomInvite, parseGameLaunchUrl } = require('./private-game-origin.cjs');

const roomId = 'abcdefghijklmnopqrstuvwx';
const invite = GAME_ORIGIN + '/?room=' + roomId;
const launch = value => 'nekofans://join?' + new URLSearchParams({invite:value});

test('launching from the permanent host passes only the public room address', () => {
  assert.equal(parseGameLaunchUrl(launch(invite)), invite);
  assert.equal(parsePrivateRoomInvite(invite).roomId, roomId);
  const temporary = 'https://fixture.trycloudflare.com/?room=' + roomId;
  assert.equal(parseGameLaunchUrl(launch(temporary)), temporary);
});

test('launch requests reject unexpected origins, credentials and extra fields', () => {
  for (const value of [
    launch(invite.replace('play.nekofans.games', 'play.nekofans.games.example')),
    launch(invite.replace('https:', 'http:')),
    launch(invite.replace('://', '://user@')),
    launch(invite + '#seat=secret'),
    launch(invite + '&room=' + roomId),
    launch(invite) + '&invite=' + encodeURIComponent(invite),
    launch(invite).replace('://join?', '://join/another?'),
  ]) assert.equal(parseGameLaunchUrl(value), null);
});
