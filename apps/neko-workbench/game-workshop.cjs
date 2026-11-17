'use strict';

const WORKSHOP_ORIGIN = 'https://workshop.nekofans.games';
const COMMUNITY_ORIGIN = 'https://community.project-neko.cn';
const GAME_ID = /^[a-f0-9]{24}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{12}$/;
const FLOW_ID = /^[A-Za-z0-9_-]{32}$/;
const PUBLISHER_COOKIE = 'neko_workshop_publisher';
const error = (status, message) => Object.assign(new Error(message), { status });
const signInRequired = () => error('sign-in-required', '请先在 Nekofans 连接 N.E.K.O. 社区账号，再继续。');
const unavailable = () => error('unavailable', '游戏工坊暂时无法连接，请稍后重试。');

function workshopOrigin(value = WORKSHOP_ORIGIN) {
  const target = new URL(value);
  if (target.href !== target.origin + '/' ||
      target.protocol !== 'https:' && !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) {
    throw Error('游戏工坊地址无效');
  }
  return target.origin;
}

function parseWorkshopRoom(value, origin = WORKSHOP_ORIGIN) {
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u0020\u007f#]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const room = url.searchParams.get('room');
  if (url.origin !== origin || url.pathname !== '/' || url.username || url.password ||
      [...url.searchParams].length !== 1 || !ROOM_ID.test(room || '')) return null;
  return { id: room, inviteUrl: origin + '/?room=' + room };
}

function publisherCookie(headers, name, pattern) {
  const prefix = name + '=';
  const values = headers.getSetCookie().filter(value => value.startsWith(prefix));
  if (values.length !== 1) throw unavailable();
  const value = values[0].slice(prefix.length).split(';', 1)[0];
  if (!pattern.test(value)) throw unavailable();
  return { name, value };
}

function createGameWorkshop({ origin = WORKSHOP_ORIGIN, communityOrigin = COMMUNITY_ORIGIN, getAccount, getTicket, openPage, fetchImpl = globalThis.fetch }) {
  origin = workshopOrigin(origin);
  let session, authorizing, generation = 0;
  const owner = () => {
    const account = getAccount();
    return account?.status === 'signed-in' ? account.userId : null;
  };
  function invalidate() {
    generation++;
    session = null;
    authorizing = null;
  }

  async function request(path, { body, cookie } = {}) {
    const isPost = body !== undefined;
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method: isPost ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          ...(isPost ? { 'Content-Type': 'application/json', Origin: origin } : {}),
          ...(cookie ? { Cookie: cookie.name + '=' + cookie.value } : {}),
        },
        ...(isPost ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      });
    } catch { throw unavailable(); }
    if (response.status === 401) throw signInRequired();
    if (response.status === 404) throw error('not-found', '找不到这个作品或房间。');
    if (response.status === 409) throw error('room-full', '无法取得席位，这个房间可能已坐满。');
    if (response.status === 422) throw error('invalid-html', '请选择已接入 Nekofans 联机接口的 HTML 文件。');
    if (!response.ok) throw unavailable();
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('application/json')) throw unavailable();
    const result = await response.json().catch(() => { throw unavailable(); });
    return { result, headers: response.headers };
  }

  async function authorize(userId, version) {
    const intent = { operation: 'publish', target: 'workshop' };
    const flow = await request('/api/community/seat/start', { body: intent });
    let url;
    try { url = new URL(flow.result.url); } catch { throw unavailable(); }
    const state = url.searchParams.get('state');
    if (url.origin !== communityOrigin || url.pathname !== '/game-seats/authorize' || url.username ||
        url.password || url.hash || [...url.searchParams].length !== 3 || !FLOW_ID.test(state || '') ||
        url.searchParams.get('operation') !== intent.operation || url.searchParams.get('target') !== intent.target) throw unavailable();
    const cookie = publisherCookie(flow.headers, 'neko_game_' + state, FLOW_ID);
    const ticket = await getTicket({ op: 'workshop-publish', state, origin });
    if (version !== generation || owner() !== userId) throw signInRequired();
    if (ticket?.status === 'sign-in-required' || ticket?.status === 'account-changed') throw signInRequired();
    if (ticket?.status !== 'ready' || ticket.userId !== userId ||
        typeof ticket.ticket !== 'string' || ticket.ticket.length > 2040) throw unavailable();
    const claim = await request('/api/community/seat', { body: { ...intent, ticket: ticket.ticket }, cookie });
    if (version !== generation || owner() !== userId) throw signInRequired();
    if (claim.result?.signedIn !== true) throw unavailable();
    return { userId, cookie: publisherCookie(claim.headers, PUBLISHER_COOKIE, /^[A-Za-z0-9_-]{43}$/) };
  }

  async function currentSession() {
    if (!owner()) {
      await getTicket({ op: 'workshop-identity' });
      if (!owner()) throw signInRequired();
    }
    const userId = owner();
    if (session?.userId === userId) return session;
    if (authorizing?.userId === userId) return authorizing.promise;
    const version = generation;
    const promise = authorize(userId, version).then(value => { session = value; return value; });
    authorizing = { userId, promise };
    try { return await promise; }
    finally { if (authorizing?.promise === promise) authorizing = null; }
  }

  async function withPublisher(run) {
    const snapshot = await currentSession();
    try {
      const result = await run(snapshot.cookie);
      if (owner() !== snapshot.userId || session !== snapshot) throw signInRequired();
      return result;
    } catch (failure) {
      if (failure.status !== 'sign-in-required' || owner() !== snapshot.userId) throw failure;
      if (session === snapshot) session = null;
      const renewed = await currentSession();
      const result = await run(renewed.cookie);
      if (owner() !== renewed.userId || session !== renewed) throw signInRequired();
      return result;
    }
  }

  async function publish(project) {
    const title = typeof project?.title === 'string' ? project.title.trim() : '';
    const html = project?.html, mode = project?.mode;
    if (!title || title.length > 60 || !['turns', 'shared'].includes(mode) ||
        typeof html !== 'string' || Buffer.byteLength(html) > 512 * 1024 ||
        !/\bNekofansGame\s*\.\s*connect\s*\(/u.test(html)) {
      throw error('invalid-html', '请填写作品名并上传不超过 512 KB 的 Nekofans 联机 HTML。');
    }
    const { result } = await withPublisher(cookie => request('/api/games', { body: { title, html, mode }, cookie }));
    if (!GAME_ID.test(result?.id ?? '')) throw unavailable();
    return { id: result.id, title, mode };
  }

  async function list() {
    const result = await withPublisher(async cookie => {
      const response = await request('/api/publisher', { cookie });
      if (response.result?.signedIn !== true) throw signInRequired();
      return response.result;
    });
    return (Array.isArray(result.projects) ? result.projects : [])
      .filter(value => GAME_ID.test(value?.id ?? '') && typeof value.title === 'string' && ['turns','shared'].includes(value.mode))
      .map(({ id, title, mode }) => ({ id, title: title.slice(0, 60), mode }));
  }

  async function create(gameId) {
    if (!GAME_ID.test(gameId ?? '')) throw error('not-found', '请先发布游戏。');
    const { result } = await withPublisher(cookie => request('/api/publisher/seat', {
      body: { operation: 'create', target: gameId }, cookie,
    }));
    if (result?.gameId !== gameId || result.player !== 0 || !ROOM_ID.test(result.id ?? '')) throw unavailable();
    return { inviteUrl: origin + '/?room=' + result.id };
  }

  async function openRoom(value) {
    const room = parseWorkshopRoom(value, origin);
    if (!room) throw error('not-found', '游戏邀请链接无效。');
    const { result } = await request('/api/rooms/' + room.id);
    if (typeof result?.community !== 'boolean') throw unavailable();
    if (!result.community) { await openPage({ url: room.inviteUrl }); return; }
    await withPublisher(async cookie => {
      const { result: account } = await request('/api/publisher', { cookie });
      if (account?.signedIn !== true) throw signInRequired();
      await openPage({ url: room.inviteUrl, cookie });
    });
  }

  return Object.freeze({ origin, invalidate, parseRoom: value => parseWorkshopRoom(value, origin), publish, list, create, openRoom });
}

module.exports = { WORKSHOP_ORIGIN, workshopOrigin, parseWorkshopRoom, createGameWorkshop };
