import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

const ACCOUNT = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const STATE = /^[\w-]{32}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'neko-game-seat+jwt' })).toString('base64url');
const FLOW_TTL = 5 * 60 * 1000;
const TICKET_TTL = 45;

export function seatTarget(operation, target) {
  if (typeof target !== 'string') return false;
  if (operation === 'create') return /^[a-f0-9]{24}$/.test(target);
  return operation === 'join' && /^[\w-]{12}$/.test(target);
}

function originOf(value) {
  const url = new URL(value);
  if (url.href !== url.origin + '/' || !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Invalid community game origin');
  return url.origin;
}

function signingKey(value, type) {
  const key = value?.type === type ? value : (type === 'private' ? createPrivateKey(value) : createPublicKey(value));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 community game key');
  return key;
}

const cookieName = state => 'neko_game_' + state;
function flowCookie(state, secret, age, secure) {
  return `${cookieName(state)}=${secret}; Max-Age=${age}; Path=/api/community/seat; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// Mount on the community origin after the existing login middleware. The
// authenticate callback returns the community's own current user ID and name.
export function createCommunitySeatAuthorizer({ issuer, gameOrigin, privateKey, authenticate, now = Date.now }) {
  issuer = originOf(issuer);
  gameOrigin = originOf(gameOrigin);
  const key = signingKey(privateKey, 'private');
  return async function authorize(request, query) {
    const state = query.get('state'), operation = query.get('operation'), target = query.get('target');
    if (!STATE.test(state || '') || !seatTarget(operation, target)) return { status: 400 };
    const user = await authenticate(request);
    if (typeof user?.id !== 'string' || !ACCOUNT.test(user.id)) return { status: 401 };
    const iat = Math.floor(now() / 1000);
    const claims = { iss: issuer, aud: gameOrigin, sub: user.id.toLowerCase(), state, operation, target, iat, exp: iat + TICKET_TTL,
      name: typeof user.name === 'string' ? user.name.slice(0, 24) : '' };
    const input = HEADER + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    const ticket = input + '.' + sign(null, Buffer.from(input), key).toString('base64url');
    const location = new URL('/', gameOrigin);
    location.searchParams.set(operation === 'join' ? 'room' : 'game', target);
    location.hash = new URLSearchParams({ communitySeat: ticket }).toString();
    return { status: 200, location: location.href };
  };
}

export function createCommunitySeats({ issuer, gameOrigin, publicKey, now = Date.now }) {
  issuer = originOf(issuer);
  gameOrigin = originOf(gameOrigin);
  if (issuer === gameOrigin) throw new Error('Community and game origins must differ');
  const key = signingKey(publicKey, 'public');
  const secure = gameOrigin.startsWith('https:');
  const flows = new Map();

  function start(operation, target) {
    const time = now();
    for (const [state, flow] of flows) if (flow.expires <= time) flows.delete(state);
    if (flows.size >= 1024) return null;
    const state = randomBytes(24).toString('base64url');
    const secret = randomBytes(24).toString('base64url');
    flows.set(state, { secret, operation, target, expires: time + FLOW_TTL });
    const url = new URL('/game-seats/authorize', issuer);
    url.search = new URLSearchParams({ state, operation, target }).toString();
    return { url: url.href, cookie: flowCookie(state, secret, FLOW_TTL / 1000, secure) };
  }

  function claim(ticket, cookies, operation, target) {
    if (typeof ticket !== 'string' || ticket.length > 2048) return null;
    const parts = ticket.split('.');
    if (parts.length !== 3 || parts[0] !== HEADER || !SEGMENT.test(parts[1]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[2])) return null;
    const signed = Buffer.from(parts[0] + '.' + parts[1]);
    if (!verify(null, signed, key, Buffer.from(parts[2], 'base64url'))) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { return null; }
    if (!claims || claims.iss !== issuer || claims.aud !== gameOrigin || typeof claims.sub !== 'string' || !ACCOUNT.test(claims.sub) ||
        typeof claims.state !== 'string' || !STATE.test(claims.state) || claims.operation !== operation || claims.target !== target) return null;
    const time = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > time + 5 || claims.exp <= time ||
        claims.exp <= claims.iat || claims.exp - claims.iat > TICKET_TTL) return null;
    const flow = flows.get(claims.state);
    const cookie = `${cookieName(claims.state)}=${flow?.secret}`;
    if (!flow || flow.expires <= now() || flow.operation !== operation || flow.target !== target ||
        !cookies?.split(';').some(value => value.trim() === cookie)) return null;
    flows.delete(claims.state);
    return { id: claims.sub.toLowerCase(), name: typeof claims.name === 'string' ? claims.name : '', cookie: flowCookie(claims.state, '', 0, secure) };
  }

  return { start, claim };
}
