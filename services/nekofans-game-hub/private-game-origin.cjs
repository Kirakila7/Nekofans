'use strict';

const GAME_ORIGIN = 'https://play.nekofans.games';

function isPrivateGameOrigin(value) {
  return value === GAME_ORIGIN ||
    (typeof value === 'string' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value));
}

function parsePrivateRoomInvite(value) {
  if (typeof value !== 'string' || value.length > 300 || value.includes('#')) throw TypeError('invalid room invitation');
  let url;
  try { url = new URL(value); } catch { throw TypeError('invalid room invitation'); }
  const entries = [...url.searchParams];
  if (!isPrivateGameOrigin(url.origin) || url.username || url.password || url.pathname !== '/' ||
      entries.length !== 1 || entries[0][0] !== 'room' || !/^[A-Za-z0-9_-]{24}$/.test(entries[0][1])) {
    throw TypeError('invalid room invitation');
  }
  const roomId = entries[0][1];
  return { origin: url.origin, roomId, inviteUrl: url.origin + '/?room=' + roomId };
}

function parseGameLaunchUrl(value) {
  if (typeof value !== 'string' || value.length > 500 || value.includes('#')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'nekofans:' || url.host !== 'join' || url.pathname || url.username || url.password) return null;
    const entries = [...url.searchParams];
    if (entries.length !== 1 || entries[0][0] !== 'invite') return null;
    return parsePrivateRoomInvite(entries[0][1]).inviteUrl;
  } catch { return null; }
}

module.exports = { GAME_ORIGIN, isPrivateGameOrigin, parsePrivateRoomInvite, parseGameLaunchUrl };
