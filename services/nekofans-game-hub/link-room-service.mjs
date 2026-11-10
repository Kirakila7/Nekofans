import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// A loopback-only prototype: link rooms do not turn an arbitrary web page into
// a synchronized game, and there is no public deployment or persistence here.
export function createLinkRoomService({ agentReady = () => false } = {}) {
  const rooms = new Map();
  const id = () => randomBytes(24).toString('base64url');
  const digest = token => createHash('sha256').update(token).digest();
  const text = (value, limit) => typeof value === 'string' && value.trim() && [...value.trim()].length <= limit ? value.trim() : null;
  const cleanUrl = value => {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
    } catch { return null; }
  };
  const makeSeat = () => {
    const token = id();
    return { token, seat: { hash: digest(token), rule: null, conditionConfirmed: false, playerReady: false } };
  };
  const find = (roomId, token) => {
    const room = rooms.get(roomId);
    if (!room || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
    const hashed = digest(token);
    const seat = room.seats.findIndex(s => s && timingSafeEqual(s.hash, hashed));
    return seat < 0 ? null : { room, seat };
  };
  const fail = (status, error) => ({ status, body: { error } });
  function create(input = {}) {
    const gameUrl = cleanUrl(input.gameUrl), title = text(input.title, 80), victoryCondition = text(input.victoryCondition, 500);
    if (!gameUrl || !title || !victoryCondition) return fail(400, '请填写游戏名称、有效的 HTTPS 游戏链接和胜负条件。');
    if (rooms.size >= 100) return fail(429, '本地房间数量已达上限。');
    const roomId = id(), first = makeSeat();
    rooms.set(roomId, { gameUrl, title, victoryCondition, seats: [first.seat, null] });
    return { status: 201, body: { roomId, seat: 0, token: first.token } };
  }
  function join(roomId) {
    const room = rooms.get(roomId);
    if (!room) return fail(404, '房间不存在。');
    if (room.seats[1]) return fail(409, '房间已满。');
    const second = makeSeat(); room.seats[1] = second.seat;
    return { status: 201, body: { roomId, seat: 1, token: second.token } };
  }
  function view(roomId, token) {
    const found = find(roomId, token);
    if (!found) return fail(401, '无法验证席位。');
    const { room, seat } = found;
    const players = room.seats.map((s, index) => ({
      joined: !!s, ruleReady: !!s?.rule, playerReady: !!s?.playerReady,
      // Only the server-side trusted adapter may provide this signal.
      agentReady: !!s && agentReady({ roomId, seat: index }) === true,
      conditionConfirmed: !!s?.conditionConfirmed,
    }));
    const allReady = players.every(p => p.joined && p.ruleReady && p.playerReady && p.agentReady && p.conditionConfirmed);
    return { status: 200, body: { roomId, title: room.title, gameUrl: room.gameUrl, victoryCondition: room.victoryCondition, seat, players, phase: allReady ? 'ready-to-connect' : 'waiting', capabilities: { linkedGame: false, autoJudge: false } } };
  }
  function rule(roomId, token, input = {}) {
    const found = find(roomId, token);
    if (!found) return fail(401, '无法验证席位。');
    const value = text(input.rule, 200);
    if (!value) return fail(400, '请填写 1–200 字的本方隐藏规则。');
    found.room.seats[found.seat].rule = value;
    // A rule revision changes the game setup; both players must ready again.
    for (const s of found.room.seats) if (s) s.playerReady = false;
    return { status: 200, body: { status: 'ready' } };
  }
  function ready(roomId, token, input = {}) {
    const found = find(roomId, token);
    if (!found) return fail(401, '无法验证席位。');
    if (Object.keys(input).some(k => !['playerReady', 'conditionConfirmed'].includes(k)) ||
        ['playerReady', 'conditionConfirmed'].some(k => k in input && typeof input[k] !== 'boolean')) return fail(400, '无效的准备状态。');
    const player = found.room.seats[found.seat];
    const confirmed = input.conditionConfirmed ?? player.conditionConfirmed;
    const isReady = input.playerReady ?? player.playerReady;
    if (isReady && (!player.rule || !confirmed)) return fail(409, '请先提交本方规则并确认共同胜负条件。');
    player.conditionConfirmed = confirmed;
    player.playerReady = confirmed ? isReady : false;
    return { status: 200, body: { ok: true } };
  }
  return { create, join, view, rule, ready };
}

export function createLinkRoomServer(options = {}) {
  const service = createLinkRoomService(options);
  const send = (res, result) => {
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(result.body));
  };
  return createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return send(res, { status: 403, body: { error: 'invalid host or origin' } });
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      try {
        const html = await readFile(new URL('./link-room-preview.html', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'self'", 'x-content-type-options': 'nosniff' });
        return res.end(html);
      } catch { return send(res, { status: 503, body: { error: '预览页面尚未就绪。' } }); }
    }
    const match = /^\/link-rooms(?:\/([A-Za-z0-9_-]{32})(?:\/(join|state|rule|ready))?)?$/.exec(url.pathname);
    if (!match) return send(res, { status: 404, body: { error: 'not found' } });
    let input = {};
    if (req.method === 'POST') {
      let size = 0, raw = '';
      for await (const chunk of req) { size += chunk.length; if (size > 8192) return send(res, { status: 413, body: { error: '请求过大。' } }); raw += chunk; }
      try { input = JSON.parse(raw || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error(); } catch { return send(res, { status: 400, body: { error: '请求格式无效。' } }); }
    }
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
    if (req.method === 'POST' && !match[1]) return send(res, service.create(input));
    if (req.method === 'POST' && match[2] === 'join') return send(res, service.join(match[1]));
    if (req.method === 'GET' && match[2] === 'state') return send(res, service.view(match[1], token));
    if (req.method === 'POST' && match[2] === 'rule') return send(res, service.rule(match[1], token, input));
    if (req.method === 'POST' && match[2] === 'ready') return send(res, service.ready(match[1], token, input));
    return send(res, { status: 404, body: { error: 'not found' } });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.NEKOFANS_LINK_ROOM_PORT || 3110);
  createLinkRoomServer().listen(port, '127.0.0.1', () => console.log(`Local room preview: http://127.0.0.1:${port}/`));
}
