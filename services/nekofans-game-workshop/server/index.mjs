import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { GamePlatform, safeEqual, reject } from './platform.mjs';
import { createCommunitySeats, seatTarget } from './community-seats.mjs';
import { agentInput, listTeammates, teammateRules } from './agent-choice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export async function productionConfig(env, expectedHostname) {
  const httpsOrigin = (value, label) => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${label} 必须为 HTTPS 源地址`); }
    if (url.protocol !== 'https:' || url.href !== `${url.origin}/`) throw new Error(`${label} 必须为 HTTPS 源地址`);
    return url;
  };
  const publicOrigin = httpsOrigin(env.PUBLIC_ORIGIN, 'PUBLIC_ORIGIN');
  const issuer = httpsOrigin(env.NEKO_GAME_COMMUNITY_ORIGIN, 'NEKO_GAME_COMMUNITY_ORIGIN');
  if (expectedHostname && publicOrigin.origin !== `https://${expectedHostname.toLowerCase()}`) throw new Error('PUBLIC_ORIGIN 与安装域名不一致');
  if (env.PUBLISH_KEY || env.ENABLE_DEMO === '1') throw new Error('正式环境必须关闭演示与管理员发布凭证');
  if (env.HOST !== '127.0.0.1' || env.PORT !== '3088') throw new Error('正式环境须监听本地 127.0.0.1:3088');
  if (!path.isAbsolute(env.DATA_DIR || '') || !path.isAbsolute(env.NEKO_GAME_COMMUNITY_PUBLIC_KEY || '')) throw new Error('正式环境须配置存档路径与社区公钥的绝对路径');
  if (expectedHostname && env.DATA_DIR !== '/var/lib/nekofans-games') throw new Error('systemd 安装须使用 /var/lib/nekofans-games 存档目录');
  const community = { issuer: issuer.origin, publicKey: await readFile(env.NEKO_GAME_COMMUNITY_PUBLIC_KEY) };
  createCommunitySeats({ ...community, gameOrigin: publicOrigin.origin });
  return { community, publicOrigin: publicOrigin.origin, directory: env.DATA_DIR, publishKey: null, demo: false, trustLocalProxy: true };
}

export function createApp({ directory = process.env.DATA_DIR || path.join(root, 'data'), publicOrigin = process.env.PUBLIC_ORIGIN, publishKey = process.env.PUBLISH_KEY, demo = process.env.ENABLE_DEMO === '1', community, chooseAgentAction, listAgentModels, trustLocalProxy = false } = {}) {
  if (publicOrigin) publicOrigin = new URL(publicOrigin).origin;
  const platform = new GamePlatform(directory), sockets = new Set(), buckets = new Map();
  const communitySeats = community && createCommunitySeats({ ...community, gameOrigin: publicOrigin });
  const agentEnabled = Boolean(communitySeats && typeof chooseAgentAction === 'function');
  const agentRequests = new Map();
  const publishers = new Map();
  const publisherTtl = 8 * 60 * 60 * 1000;
  const sessionCookie = 'neko_workshop_publisher';
  const sessionDigest = token => createHash('sha256').update(token).digest('hex');
  function publisherSessionKey(req) {
    const token = req.headers.cookie?.split(';').map(value => value.trim())
      .find(value => value.startsWith(sessionCookie + '='))?.slice(sessionCookie.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token || '') ? sessionDigest(token) : null;
  }
  function publisher(req) {
    const session = publishers.get(publisherSessionKey(req));
    return session?.expires > Date.now() ? session.account : null;
  }
  function publisherCookie(token, maxAge) {
    return `${sessionCookie}=${token}; Max-Age=${maxAge}; Path=/api; HttpOnly; SameSite=Lax${publicOrigin.startsWith('https:') ? '; Secure' : ''}`;
  }
  function endPublisher(req) {
    publishers.delete(publisherSessionKey(req));
  }
  function startPublisher(req, account) {
    endPublisher(req);
    const now = Date.now();
    for (const [key, session] of publishers) if (session.expires <= now) publishers.delete(key);
    if (publishers.size >= 2048) reject(503, '授权繁忙，请稍后再试');
    const token = randomBytes(32).toString('base64url');
    publishers.set(sessionDigest(token), { account: { id: account.id, name: account.name }, expires: now + publisherTtl });
    return publisherCookie(token, publisherTtl / 1000);
  }
  const origin = req => publicOrigin || `http://${req.headers.host}`;
  const allowed = req => !req.headers.origin || req.headers.origin === origin(req);
  function clientAddress(req) {
    const peer = req.socket.remoteAddress;
    const forwarded = req.headers['x-nekofans-client-ip'];
    return trustLocalProxy && loopbackAddresses.has(peer) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
  }
  const rate = (key, max = 120) => {
    const now = Date.now(); let bucket = buckets.get(key);
    if (!bucket || now - bucket.time > 60000) bucket = { time: now, n: 0 };
    bucket.n++; buckets.set(key, bucket);
    if (buckets.size > 10000) for (const [ip, b] of buckets) if (now - b.time > 60000) buckets.delete(ip);
    return bucket.n <= max;
  };
  function onlinePlayers(id) {
    return [0, 1].map(player => [...sockets].some(ws => ws.room === id && ws.player === player && ws.readyState === WebSocket.OPEN));
  }
  function broadcast(id) {
    const state = platform.snapshot(id);
    state.online = onlinePlayers(id);
    const encoded = JSON.stringify(state);
    for (const ws of sockets) if (ws.room === id && ws.readyState === WebSocket.OPEN) ws.send(encoded);
  }
  function joinAccountRoom(id, account) {
    const seat = platform.join(id, undefined, account);
    for (const ws of sockets) {
      if (ws.room === id && ws.player === seat.player) ws.close(4001, 'Seat restored on another device');
    }
    broadcast(id);
    return seat;
  }
  function agentSeat(req, roomId) {
    if (!agentEnabled) reject(404, '这个工坊尚未连接游戏 Agent');
    const token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization || '')?.[1];
    const player = platform.auth(roomId, token);
    const accountId = platform.room(roomId).seats[player].accountId;
    if (!accountId) reject(403, '请用账号入座后再接手');
    return { token, player, accountId };
  }
  async function choose(req, res, roomId, input) {
    if (req.headers.origin !== publicOrigin) reject(403, '不允许的来源');
    const { token, player, accountId } = agentSeat(req, roomId);
    const view = agentInput(input);
    const model = input.model ?? 'default';
    if (typeof model !== 'string' || !/^[\w./:-]{1,128}$/.test(model)) reject(400, '模型无效');
    const rules = teammateRules(input.teammate);
    const control = [...sockets].find(ws => ws.room === roomId && ws.player === player && ws.seatToken === token && ws.readyState === WebSocket.OPEN);
    const current = () => {
      const room = platform.snapshot(roomId);
      return control?.readyState === WebSocket.OPEN && room.players.length === 2 && room.phase === 'playing' && !room.result && room.version === view.version &&
        onlinePlayers(roomId).every(Boolean) && (room.game.mode === 'shared' || room.turn === player) && platform.auth(roomId, token) === player;
    };
    if (!current()) reject(409, '对局已更新');
    if (agentRequests.has(accountId)) reject(429, '大肥鱼正在操作');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 25000);
    agentRequests.set(accountId, controller);
    res.once('close', abort);
    control.once('close', abort);
    try {
      const choiceId = await chooseAgentAction({ ...view, model, rules, accountId, player, signal: controller.signal });
      if (controller.signal.aborted) reject(503, '大肥鱼没有及时回应');
      if (!current()) reject(409, '对局已更新');
      if (!view.choices.some(choice => choice.id === choiceId)) reject(422, '大肥鱼未选出合法动作');
      return json(res, 200, { choiceId });
    } finally {
      clearTimeout(timeout);
      res.off('close', abort);
      control.off('close', abort);
      agentRequests.delete(accountId);
    }
  }
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' about:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (url.pathname === '/api/config') return json(res, 200, { publishEnabled: Boolean(publishKey || communitySeats), adminPublish: Boolean(publishKey), demo, communitySeats: Boolean(communitySeats),
        ...(agentEnabled ? { gameAgent: true } : {}),
        ...(communitySeats && community.label ? { accountSeatLabel: community.label } : {}) });
      const playMatch = url.pathname.match(/^\/play\/([a-f0-9]{24})$/);
      if (req.method === 'GET' && playMatch) {
        const game = platform.game(playMatch[1]);
        const sdk = await readFile(path.join(root, 'public', 'game-sdk.js'), 'utf8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts");
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>' + sdk + '</script>' + game.html);
      }
      if (url.pathname.startsWith('/api/')) {
        if (!allowed(req)) reject(403, '不允许的来源');
        if (!rate('http:' + clientAddress(req))) reject(429, '操作太快，请稍后再试');
        let match;
        if (req.method === 'GET' && (match = url.pathname.match(/^\/api\/rooms\/([\w-]{12})\/agent-options$/))) {
          const { accountId } = agentSeat(req, match[1]);
          const catalog = await listAgentModels?.({ accountId }) || { models: [{ id: 'default', label: '默认模型' }] };
          return json(res, 200, { ...catalog, teammates: listTeammates() });
        }
        if (req.method === 'GET' && url.pathname === '/api/publisher') {
          const account = publisher(req);
          return json(res, 200, account ? { signedIn: true, name: account.name, projects: platform.projects(account.id) } : { signedIn: false });
        }
        if (req.method === 'GET' && url.pathname === '/api/games') return json(res, 200, { projects: platform.projects() });
        if (req.method === 'GET' && (match = url.pathname.match(/^\/api\/games\/([a-f0-9]{24})$/))) return json(res, 200, platform.gameInfo(match[1]));
        if (req.method === 'GET' && (match = url.pathname.match(/^\/api\/rooms\/([\w-]{12})$/))) return json(res, 200, { community: Boolean(platform.room(match[1]).community) });
        if (req.method === 'POST') {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 600 * 1024) reject(413, '上传文件过大'); chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf8');
          let input; try { input = JSON.parse(raw || '{}'); } catch { reject(400, 'JSON 格式有误'); }
          if ((match = url.pathname.match(/^\/api\/rooms\/([\w-]{12})\/agent-choice$/))) return await choose(req, res, match[1], input);
          if (url.pathname === '/api/games/studio') {
            const account = publisher(req);
            if (!account) reject(401, '请先登录 N.E.K.O. 账号');
            if (req.headers.origin !== publicOrigin) reject(403, '不允许的来源');
            return json(res, 201, platform.publishStudio(input, account));
          }
          if (url.pathname === '/api/games') {
            const account = publisher(req);
            if (account) {
              if (req.headers.origin !== publicOrigin) reject(403, '不允许的来源');
              if (typeof input?.html !== 'string' || !/\bNekofansGame\s*\.\s*connect\s*\(/u.test(input.html)) reject(422, '请上传已接入 Nekofans 联机接口的 HTML');
              return json(res, 201, platform.publish(input, account));
            }
            if (!publishKey && !communitySeats) reject(503, '服主尚未启用作品发布');
            if (!publishKey || !safeEqual(req.headers.authorization, 'Bearer ' + publishKey)) reject(401, '请先登录 N.E.K.O. 账号');
            return json(res, 201, platform.publish(input));
          }
          if (url.pathname === '/api/demo') {
            if (!demo) reject(404, '示例未开启');
            const html = await readFile(path.join(root, 'examples', 'two-player.html'), 'utf8');
            return json(res, 200, platform.publish({ title: '一起落一颗星 · 双人井字棋', mode: 'turns', html }));
          }
          if (url.pathname === '/api/publisher/logout') {
            if (!communitySeats || req.headers.origin !== publicOrigin) reject(403, '不允许的来源');
            endPublisher(req);
            res.setHeader('Set-Cookie', publisherCookie('', 0));
            return json(res, 200, { signedIn: false });
          }
          if (url.pathname === '/api/publisher/seat') {
            if (!communitySeats || req.headers.origin !== publicOrigin) reject(403, '不允许的来源');
            const account = publisher(req);
            if (!account) reject(401, '请先连接 N.E.K.O. 账号');
            const { operation, target } = input ?? {};
            if (operation !== 'create' && operation !== 'join' || !seatTarget(operation, target)) reject(400, '游戏或房间无效');
            if (operation === 'create') return json(res, 201, platform.create(target, undefined, account));
            return json(res, 200, joinAccountRoom(target, account));
          }
          if (url.pathname === '/api/community/seat/start' || url.pathname === '/api/community/seat') {
            if (!communitySeats) reject(503, '社区账号入座暂不可用');
            if (req.headers.origin !== publicOrigin) reject(403, '不允许的来源');
            const { operation, target } = input ?? {};
            if (!seatTarget(operation, target)) reject(400, '游戏或房间无效');
            if (operation === 'create') platform.game(target);
            else if (operation === 'join' && !platform.room(target).community) reject(409, '这个房间使用访客入座');
            if (url.pathname.endsWith('/start')) {
              const flow = communitySeats.start(operation, target);
              if (!flow) reject(503, '社区授权繁忙，请稍后再试');
              res.setHeader('Set-Cookie', flow.cookie);
              return json(res, 200, { url: flow.url });
            }
            const account = communitySeats.claim(input.ticket, req.headers.cookie, operation, target);
            if (!account) reject(401, '社区授权已失效，请重新入座');
            res.setHeader('Set-Cookie', account.cookie);
            if (operation === 'publish') {
              res.setHeader('Set-Cookie', [account.cookie, startPublisher(req, account)]);
              return json(res, 200, { signedIn: true, name: account.name, projects: platform.projects(account.id) });
            }
            if (operation === 'create') return json(res, 201, platform.create(target, undefined, account));
            return json(res, 200, joinAccountRoom(target, account));
          }
          if (url.pathname === '/api/rooms') return json(res, 201, platform.create(input.gameId, input.name));
          if ((match = url.pathname.match(/^\/api\/rooms\/([\w-]{12})\/join$/))) { const seat = platform.join(match[1], input.name); broadcast(match[1]); return json(res, 200, seat); }
        }
        return json(res, 404, { error: '接口不存在' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) reject(405, 'Method not allowed');
      const requested = decodeURIComponent(url.pathname), publicDir = path.join(root, 'public');
      const file = path.resolve(publicDir, '.' + (requested === '/' ? '/index.html' : requested));
      if (!file.startsWith(publicDir + path.sep) || !(await stat(file)).isFile()) reject(404, 'Not found');
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) { json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : '请求失败，请重试' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/api\/rooms\/([\w-]{12})\/socket$/);
    if (!match || !allowed(req) || !rate('ws:' + clientAddress(req), 30)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.alive = true; ws.on('pong', () => { ws.alive = true; });
      const timer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
      ws.on('message', raw => {
        try {
          const data = JSON.parse(raw.toString());
          if (!ws.room) {
            if (data.type !== 'auth') reject(401, '请先验证席位');
            ws.player = platform.auth(match[1], data.token); ws.room = match[1]; ws.seatToken = data.token; clearTimeout(timer);
            // One live controller per seat; refreshing replaces the previous tab.
            for (const previous of sockets) if (previous.room === ws.room && previous.player === ws.player) previous.close(4001, 'Seat opened in another tab');
            sockets.add(ws); broadcast(ws.room);
          } else {
            if (platform.auth(ws.room, ws.seatToken) !== ws.player) reject(401, '席位已在其他设备恢复');
            if (!rate('seat:' + ws.room + ':' + ws.player, 180)) reject(429, '操作太快');
            if (data.type === 'action') platform.action(ws.room, ws.player, data);
            else if (data.type === 'project' || data.type === 'start') platform.configureRoom(ws.room, ws.player, data, onlinePlayers(ws.room));
            else reject(400, '未知操作');
            broadcast(ws.room);
          }
        } catch (error) { ws.send(JSON.stringify({ type: 'error', status: error.status || 400, error: error.status ? error.message : '操作格式有误' })); if (!ws.room) ws.close(1008, 'Authentication failed'); else broadcast(ws.room); }
      });
      ws.on('error', () => {});
      ws.on('close', () => { clearTimeout(timer); sockets.delete(ws); if (ws.room) broadcast(ws.room); });
    });
  });
  const heartbeat = setInterval(() => { for (const ws of sockets) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 15000); heartbeat.unref();
  return { server, platform, close: async () => { clearInterval(heartbeat); for (const ws of sockets) ws.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--check-production-config') {
    if (process.env.NEKO_WORKSHOP_PRODUCTION !== '1') throw new Error('请设置 NEKO_WORKSHOP_PRODUCTION=1');
    await productionConfig(process.env, process.argv[3]);
    console.log('正式配置已通过本机检查');
  } else {
    const keyPath = process.env.NEKO_GAME_COMMUNITY_PUBLIC_KEY;
    const options = process.env.NEKO_WORKSHOP_PRODUCTION === '1' ? await productionConfig(process.env) : {
      community: keyPath ? { issuer: process.env.NEKO_GAME_COMMUNITY_ORIGIN || 'https://community.project-neko.cn', publicKey: await readFile(keyPath) } : undefined,
    };
    const app = createApp(options), port = Number(process.env.PORT || 3088), host = process.env.HOST || '127.0.0.1';
    app.server.listen(port, host, () => console.log(`Nekofans 游戏工坊: http://${host}:${port}`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close().then(() => process.exit(0)));
  }
}
