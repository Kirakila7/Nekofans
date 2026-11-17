'use strict';

/*
 * 本地 HTTP 服务：静态页面 + 房间 API + SSE 推送。
 *
 * 安全边界：
 * - 只监听 127.0.0.1（默认），不提供任何公网/隧道入口；
 * - 女神与玩家权限由随机令牌区分，玩家令牌不能调用女神接口；
 * - 状态投影由 lib/room.js 按角色生成，对手规则原文不会进入玩家响应；
 * - 所有写操作都是固定结构化的 JSON 字段，服务端校验后执行，不执行任意代码。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Room, RoomError } = require('./lib/room.js');
const { Store, ROOM_ID_PATTERN } = require('./lib/store.js');
const { loadStoryScenarios, getStoryScenario } = require('./lib/story-config.js');
const {
  createTeammateAdapter,
  createGoddessAdapter,
} = require('./lib/teammate-adapter.js');
const { buildTeammateContext, validateDecision } = require('./lib/teammate-context.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const VERSION = '0.1.0';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function setCommonHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendError(res, error) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  const status = error instanceof HttpError || error instanceof RoomError ? error.status || 400 : 500;
  if (status >= 500) console.error('[server]', error);
  sendJson(res, status, {
    ok: false,
    code: error.code || 'server_error',
    error: status >= 500 ? '服务端内部错误：' + error.message : error.message,
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 不 destroy 连接：排空剩余请求体，让 413 JSON 能正常写回。
        settle(reject, new HttpError(413, 'body_too_large', '请求体超过 64KB 上限'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (!chunks.length) return settle(resolve, {});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        settle(resolve, value);
      } catch {
        settle(reject, new HttpError(400, 'bad_json', '请求体必须是 JSON 对象'));
      }
    });
    req.on('error', (error) => settle(reject, error));
  });
}

function servePublicFile(res, relativePath) {
  const resolved = path.resolve(PUBLIC_DIR, relativePath);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  let data;
  try {
    data = fs.readFileSync(resolved);
  } catch {
    sendText(res, 404, 'not found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  res.end(data);
}

function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const quiet = Boolean(options.quiet);
  const hostToken = options.hostToken;
  let activeHostedRoom = null;
  let modelReady = false;
  function requireHost(req) {
    if (!safeEqual(req.headers.authorization, 'Bearer ' + hostToken)) {
      throw new HttpError(403, 'host_only', '请在 Nekofans 打开剧情棋局');
    }
  }
  function playerAdapterStatus() {
    if (hostToken && !modelReady) return createTeammateAdapter().status();
    return teammateAdapter.status();
  }
  const storyScenarios = options.storyScenarios || loadStoryScenarios(options.storyScenarioFile);
  const store = new Store(dataDir);
  const rooms = new Map();
  const teammateAdapter = options.teammateAdapter || createTeammateAdapter();
  const goddessAdapter = options.goddessAdapter || createGoddessAdapter();
  const configuredTimeout = Number(options.teammateTimeoutMs);
  const teammateTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 100
    ? Math.trunc(configuredTimeout)
    : 8000;
  const configuredCalls = Number(options.maxTeammateCallsPerRoom);
  const maxTeammateCallsPerRoom = Number.isFinite(configuredCalls) && configuredCalls >= 0
    ? Math.trunc(configuredCalls)
    : 20;
  const decisionLocks = new Set();
  const decisionCalls = new Map();
  for (const raw of store.loadAll()) {
    try {
      const room = Room.fromJSON(raw);
      room.teammateStatus = playerAdapterStatus();
      room.goddessStatus = goddessAdapter.status();
      rooms.set(room.id, room);
    } catch (error) {
      console.warn('[server] 跳过无法恢复的房间：' + (raw && raw.id) + '（' + error.message + '）');
    }
  }

  /** roomId -> Map<clientId, { role, seat, res, origin }> */
  const clients = new Map();
  let clientSeq = 0;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendError(res, error));
  });
  server.requestTimeout = 0;

  const heartbeat = setInterval(() => {
    for (const map of clients.values()) {
      for (const client of map.values()) {
        try {
          client.res.write(': ping\n\n');
        } catch {
          /* cleanup happens on close */
        }
      }
    }
  }, 15000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  function getRoom(roomId) {
    if (!ROOM_ID_PATTERN.test(roomId)) return null;
    return rooms.get(roomId) || null;
  }

  function requireRoom(roomId) {
    const room = getRoom(roomId);
    if (!room) throw new HttpError(404, 'room_not_found', '房间不存在或已失效');
    return room;
  }

  function presenceOf(roomId) {
    const presence = { white: false, black: false, goddess: false };
    const map = clients.get(roomId);
    if (!map) return presence;
    for (const client of map.values()) {
      if (client.role === 'goddess') presence.goddess = true;
      else if (client.seat) presence[client.seat] = true;
    }
    return presence;
  }

  function originOf(req) {
    const rawHost = String(req.headers.host || '127.0.0.1');
    const host = rawHost.replace(/[^0-9a-zA-Z.:[\]-]/g, '');
    return 'http://' + (host || '127.0.0.1');
  }

  function resolveAuth(room, token) {
    if (!token) throw new HttpError(401, 'missing_token', '缺少访问令牌');
    if (safeEqual(token, room.data.tokens.white)) return { role: 'player', seat: 'white' };
    if (safeEqual(token, room.data.tokens.black)) return { role: 'player', seat: 'black' };
    if (safeEqual(token, room.data.tokens.goddess)) return { role: 'goddess', seat: null };
    throw new HttpError(401, 'invalid_token', '访问令牌无效');
  }

  function sseFrame(state) {
    return 'event: state\ndata: ' + JSON.stringify(state) + '\n\n';
  }

  function broadcast(roomId) {
    const room = rooms.get(roomId);
    const map = clients.get(roomId);
    if (!room || !map) return;
    const presence = presenceOf(roomId);
    for (const client of map.values()) {
      try {
        client.res.write(sseFrame(room.stateFor(client.role, client.seat, presence, client.origin)));
      } catch {
        /* close handler cleans up */
      }
    }
  }

  function commit(req, res, room, auth, extra) {
    room.touch();
    store.save(room);
    broadcast(room.id);
    sendJson(res, 200, {
      ok: true,
      state: room.stateFor(auth.role, auth.seat, presenceOf(room.id), originOf(req)),
      ...(extra || {}),
    });
  }

  function requireGoddess(auth) {
    if (auth.role !== 'goddess') throw new HttpError(403, 'forbidden', '该操作仅限女神席位');
  }

  function requirePlayer(auth) {
    if (auth.role !== 'player') throw new HttpError(403, 'forbidden', '该操作仅限白方/黑方席位');
  }

  async function handleRequest(req, res) {
    const host = req.headers.host;
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i.test(host || '') ||
        (req.headers.origin !== undefined && req.headers.origin !== originOf(req))) {
      throw new HttpError(403, 'invalid_origin', '剧情棋局仅接受本机同源请求');
    }
    const url = new URL(req.url || '/', 'http://internal');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad_path', '请求路径无法解析');
    }
    const method = req.method || 'GET';

    if (pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, version: VERSION, rooms: rooms.size, uptime: process.uptime() });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不允许');
      servePublicFile(res, 'landing.html');
      return;
    }

    const roomPage = pathname.match(/^\/room\/([^/]+)$/);
    if (roomPage) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不允许');
      servePublicFile(res, 'index.html');
      return;
    }

    if (pathname.startsWith('/api/rooms')) {
      await handleApi(req, res, url, pathname);
      return;
    }

    if (method === 'GET' && !pathname.includes('..')) {
      const clean = pathname.replace(/^\/+/, '');
      if (/^(app|landing)\.js$|^styles\.css$|^favicon\.svg$/.test(clean)) {
        servePublicFile(res, clean);
        return;
      }
    }

    if (method === 'GET') {
      sendText(res, 404, 'not found');
      return;
    }
    throw new HttpError(404, 'not_found', '接口不存在');
  }

  async function handleApi(req, res, url, pathname) {
    const method = req.method || 'GET';
    const parts = pathname.split('/').filter(Boolean); // ['api','rooms',...]
    const token = url.searchParams.get('token');

    // POST /api/rooms
    if (parts.length === 2 && method === 'POST') {
      if (hostToken) {
        requireHost(req);
        if (activeHostedRoom) throw new HttpError(409, 'room_exists', '已有本机剧情棋局');
      }
      const body = await readJsonBody(req);
      let scenario = null;
      if (body.scenario !== undefined && body.scenario !== null && body.scenario !== '') {
        scenario = getStoryScenario(storyScenarios, body.scenario);
        if (!scenario) throw new HttpError(400, 'bad_scenario', '未知的剧情场景');
      }
      const room = Room.create({
        guessLimit: body.guessLimit,
        reviewMode: body.reviewMode,
        scenario,
        teammateStatus: playerAdapterStatus(),
        goddessStatus: goddessAdapter.status(),
      });
      if (hostToken && body.scenario !== 'story-v1') {
        throw new HttpError(400, 'bad_scenario', '此入口仅支持《开源与抹除》');
      }
      if (hostToken && activeHostedRoom) throw new HttpError(409, 'room_exists', '已有本机剧情棋局');
      store.save(room);
      rooms.set(room.id, room);
      if (hostToken) activeHostedRoom = room.id;
      const origin = originOf(req);
      const tokens = room.data.tokens;
      if (!quiet) console.log('[room] 创建房间 ' + room.id + '（会话数据保存在 ' + dataDir + '）');
      sendJson(res, 200, {
        ok: true,
        roomId: room.id,
        phase: room.phase,
        scenario: room.data.scenario ? room.data.scenario.id : null,
        links: {
          white: origin + '/room/' + room.id + '?token=' + tokens.white,
          black: origin + '/room/' + room.id + '?token=' + tokens.black,
          goddess: origin + '/room/' + room.id + '?token=' + tokens.goddess,
        },
      });
      return;
    }

    if (parts.length < 3) throw new HttpError(404, 'not_found', '接口不存在');
    const room = requireRoom(parts[2]);
    if (hostToken && parts.length === 4 && parts[3] === 'enable-model' && method === 'POST') {
      requireHost(req);
      if (room.id !== activeHostedRoom) throw new HttpError(404, 'room_not_found', '房间不存在或已失效');
      modelReady = true;
      room.teammateStatus = playerAdapterStatus();
      broadcast(room.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    const auth = resolveAuth(room, token);
    const origin = originOf(req);
    const action = parts[3] || '';
    const subAction = parts[4] || '';

    if (method === 'GET') {
      if (!action) {
        sendJson(res, 200, { ok: true, state: room.stateFor(auth.role, auth.seat, presenceOf(room.id), origin) });
        return;
      }
      if (action === 'state' && parts.length === 4) {
        sendJson(res, 200, { ok: true, state: room.stateFor(auth.role, auth.seat, presenceOf(room.id), origin) });
        return;
      }
      if (action === 'stream' && parts.length === 4) {
        handleStream(req, res, room, auth);
        return;
      }
      if (action === 'teammate' && subAction === 'view' && parts.length === 5) {
        requirePlayer(auth);
        if (auth.seat !== 'white') throw new HttpError(403, 'forbidden', '队友视图仅限 A 方席位');
        sendJson(res, 200, { ok: true, view: room.teammateView(presenceOf(room.id), origin) });
        return;
      }
      if (action === 'export' && parts.length === 4) {
        requireGoddess(auth);
        const payload = room.exportData();
        const body = JSON.stringify(payload, null, 2);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Content-Disposition':
            'attachment; filename="nekofans-room-' + room.id + '-' + Date.now() + '.json"',
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
      throw new HttpError(404, 'not_found', '接口不存在');
    }

    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不允许');

    // 先做权限判断，再解析请求体：玩家令牌调用女神接口时应直接 403，而不是先暴露 JSON 解析错误。
    const playerRoute =
      (action === 'rule' && parts.length === 4) ||
      (action === 'move' && parts.length === 4) ||
      (action === 'move' && subAction === 'cancel' && parts.length === 5) ||
      (action === 'guess' && parts.length === 4) ||
      (action === 'special' && parts.length === 4) ||
      (action === 'extra' && parts.length === 4) ||
      (action === 'teammate' && subAction === 'guess' && parts.length === 5) ||
      (action === 'teammate' && subAction === 'decide' && parts.length === 5);
    const goddessRoute = action === 'goddess' && parts.length >= 5;
    if (!playerRoute && !goddessRoute) throw new HttpError(404, 'not_found', '接口不存在');
    if (playerRoute) requirePlayer(auth);
    if (goddessRoute) requireGoddess(auth);

    const body = await readJsonBody(req);

    if (action === 'rule' && parts.length === 4) {
      room.submitRule(auth.seat, body.text);
      commit(req, res, room, auth);
      return;
    }
    if (action === 'move' && parts.length === 4) {
      room.submitMove(auth.seat, body);
      commit(req, res, room, auth);
      return;
    }
    if (action === 'move' && subAction === 'cancel' && parts.length === 5) {
      room.cancelPending(auth.seat);
      commit(req, res, room, auth);
      return;
    }
    if (action === 'guess' && parts.length === 4) {
      room.submitGuess(auth.seat, body.text);
      commit(req, res, room, auth);
      return;
    }
    if (action === 'special' && parts.length === 4) {
      room.submitPoolMove(auth.seat, body);
      commit(req, res, room, auth);
      return;
    }
    if (action === 'extra' && parts.length === 4) {
      const result = room.submitErase(auth.seat, body);
      commit(req, res, room, auth, result);
      return;
    }
    if (action === 'teammate' && subAction === 'guess' && parts.length === 5) {
      if (auth.seat !== 'white') throw new HttpError(403, 'forbidden', '队友猜测仅限 A 方席位');
      room.submitGuess('white', body.text);
      commit(req, res, room, auth);
      return;
    }
    if (action === 'teammate' && subAction === 'decide' && parts.length === 5) {
      if (auth.seat !== 'white') throw new HttpError(403, 'forbidden', '受控决策仅限 A 方席位');
      if (hostToken && (!modelReady || room.id !== activeHostedRoom)) {
        throw new HttpError(503, 'adapter_unavailable', '本局尚未接入工作台模型');
      }
      await runTeammateDecision(req, res, room, auth, body);
      return;
    }
    if (action === 'goddess' && parts.length >= 5) {
      const goddessAction = parts[4];
      switch (goddessAction) {
        case 'rule':
          room.goddessRule(body);
          break;
        case 'start':
          room.start();
          break;
        case 'review':
          room.goddessReview(body);
          break;
        case 'force-move':
          room.goddessForceMove(body);
          break;
        case 'edit-board':
          room.editBoard(body);
          break;
        case 'undo':
          room.undo();
          break;
        case 'pause':
          room.setPaused(Boolean(body.paused));
          break;
        case 'end':
          room.goddessEnd(body);
          break;
        case 'judge-guess':
          room.judgeGuess(body);
          break;
        case 'settings':
          room.updateSettings(body);
          break;
        case 'announce':
          room.announce(body.text);
          break;
        case 'reset':
          room.reset();
          break;
        case 'private-field':
          room.goddessSetName(body);
          break;
        default:
          throw new HttpError(404, 'unknown_goddess_action', '未知的女神操作');
      }
      commit(req, res, room, auth);
      return;
    }
    throw new HttpError(404, 'not_found', '接口不存在');
  }

  function adapterHttpError(error) {
    if (error instanceof HttpError) return error;
    if (error && error.code) {
      const status = Number(error.status) || 502;
      return new HttpError(status, error.code, error.message || '适配器失败');
    }
    return new HttpError(502, 'adapter_error', '适配器失败');
  }

  async function runTeammateDecision(req, res, room, auth, body) {
    if (auth.seat !== 'white') throw new HttpError(403, 'forbidden', '受控决策仅限 A 方席位');
    if (body && Object.keys(body).length > 0) {
      throw new HttpError(400, 'bad_decision_request', '决策请求不接受客户端上下文');
    }
    const status = teammateAdapter.status();
    if (!status.available) throw new HttpError(503, 'teammate_unavailable', status.label);
    if (room.data.phase !== 'playing' || room.data.game.result) {
      throw new HttpError(409, 'phase_not_ready', '当前不在可决策的对局阶段');
    }
    if (decisionLocks.has(room.id)) throw new HttpError(409, 'decision_in_progress', '已有决策请求在进行');
    const usedCalls = decisionCalls.get(room.id) || 0;
    if (usedCalls >= maxTeammateCallsPerRoom) {
      throw new HttpError(429, 'teammate_call_limit', '本房间决策调用次数已达上限');
    }
    decisionLocks.add(room.id);
    decisionCalls.set(room.id, usedCalls + 1);
    const controller = new AbortController();
    let finished = false;
    let timer = null;
    const abortFromClient = () => {
      if (!finished) controller.abort();
    };
    req.on('aborted', abortFromClient);
    res.on('close', abortFromClient);
    try {
      const view = room.teammateView(presenceOf(room.id), originOf(req));
      const requestId = crypto.randomUUID();
      const context = buildTeammateContext(view, requestId);
      const versionBefore = room.data.version;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new HttpError(504, 'teammate_timeout', '适配器超时，未执行任何走子'));
        }, teammateTimeoutMs);
      });
      let decision;
      try {
        decision = await Promise.race([
          teammateAdapter.decide(context, { signal: controller.signal, requestId }),
          timeout,
        ]);
      } catch (error) {
        throw adapterHttpError(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (controller.signal.aborted) {
        throw new HttpError(408, 'teammate_aborted', '适配器调用被中断，未执行任何走子');
      }
      if (room.data.version !== versionBefore) {
        throw new HttpError(409, 'stale_state', '对局状态已变化，拒绝过期决策');
      }
      const validated = validateDecision(decision, context);
      if (!validated.ok) {
        throw new HttpError(422, validated.code, validated.message);
      }
      let pending = false;
      try {
        if (validated.action.kind === 'guess') {
          room.submitGuess('white', validated.action.text);
        } else if (validated.action.kind === 'special') {
          room.submitPoolMove('white', {
            type: validated.action.type,
            from: validated.action.from,
            to: validated.action.to,
            promotion: validated.action.promotion || null,
          });
        } else {
          room.submitMove('white', {
            from: validated.action.from,
            to: validated.action.to,
            promotion: validated.action.promotion || null,
          });
          pending = Boolean(room.data.game.pending);
        }
      } catch (error) {
        if (error instanceof RoomError) {
          throw new HttpError(error.status || 400, error.code, error.message);
        }
        throw error;
      }
      finished = true;
      room.teammateStatus = teammateAdapter.status();
      commit(req, res, room, auth, {
        decision: validated.action,
        adapter: teammateAdapter.status(),
        applied: !pending,
        pending,
      });
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      req.removeListener('aborted', abortFromClient);
      res.removeListener('close', abortFromClient);
      decisionLocks.delete(room.id);
    }
  }

  function handleStream(req, res, room, auth) {
    setCommonHeaders(res);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');

    const map = clients.get(room.id) || new Map();
    clients.set(room.id, map);
    const id = ++clientSeq;
    const client = { id, role: auth.role, seat: auth.seat, res, origin: originOf(req) };
    map.set(id, client);
    try {
      res.write(sseFrame(room.stateFor(auth.role, auth.seat, presenceOf(room.id), client.origin)));
    } catch {
      /* ignore */
    }
    broadcast(room.id);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (!map.has(id)) return;
      map.delete(id);
      if (map.size === 0) clients.delete(room.id);
      broadcast(room.id);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve(server.address());
      });
    });
  }

  async function close() {
    clearInterval(heartbeat);
    for (const map of clients.values()) {
      for (const client of map.values()) {
        try {
          client.res.end();
        } catch {
          /* ignore */
        }
      }
    }
    clients.clear();
    for (const room of rooms.values()) {
      try {
        store.save(room);
      } catch (error) {
        console.warn('[server] 关闭时保存房间失败：' + error.message);
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      if (typeof timer.unref === 'function') timer.unref();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    server,
    store,
    listen,
    close,
    rooms,
    getRoom,
    presenceOf,
    broadcast,
    teammateAdapter,
    goddessAdapter,
    getDecisionCalls: (roomId) => decisionCalls.get(roomId) || 0,
  };
}

function startCli() {
  const port = Number(process.env.PORT || process.env.NEKOFANS_PORT || 8787);
  // 固定回环地址：本原型不提供公网绑定入口，也不读取可覆盖监听地址的环境变量。
  const host = '127.0.0.1';
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const hosted = process.env.NEKO_STORY_HOSTED === '1';
  const token = process.env.NEKO_AI_BRIDGE_TOKEN;
  let bridgeEndpoint;
  if (hosted) {
    const bridge = new URL(process.env.NEKO_AI_BRIDGE_URL);
    if (!/^[a-f0-9]{64}$/u.test(token || '') ||
        bridge.protocol !== 'http:' || bridge.hostname !== '127.0.0.1' || !bridge.port ||
        bridge.pathname !== '/v1' || bridge.username || bridge.password || bridge.search || bridge.hash) {
      throw Error('Invalid desktop story bridge');
    }
    bridgeEndpoint = new URL('/v1/decision', bridge).href;
  }
  const teammateMode = hosted ? 'http' : (process.env.NEKOFANS_TEAMMATE_MODE || 'unavailable');
  const teammateAdapter = createTeammateAdapter({
    mode: teammateMode,
    endpoint: bridgeEndpoint || process.env.NEKOFANS_TEAMMATE_URL || null,
    bearerToken: hosted ? token : undefined,
    accountConnected: hosted || process.env.NEKOFANS_TEAMMATE_ACCOUNT === 'verified',
    timeoutMs: hosted ? 60000 : process.env.NEKOFANS_TEAMMATE_TIMEOUT_MS,
    maxCalls: process.env.NEKOFANS_TEAMMATE_MAX_CALLS,
  });
  const goddessAdapter = createGoddessAdapter({
    mode: process.env.NEKOFANS_GODDESS_MODE || 'unavailable',
  });
  const app = createApp({
    dataDir, teammateAdapter, goddessAdapter, hostToken: hosted ? token : undefined,
    teammateTimeoutMs: hosted ? 60000 : undefined,
  });

  app
    .listen(port, host)
    .then((address) => {
      const actualPort = address && typeof address === 'object' ? address.port : port;
      const base = 'http://' + host + ':' + actualPort;
      console.log('');
      console.log('  Nekofans 双子棋局 · 本地原型 v' + VERSION);
      console.log('  ------------------------------------------------------------');
      console.log('  控制台（创建房间） : ' + base + '/');
      console.log('  数据目录           : ' + dataDir);
      console.log('  监听地址           : ' + host + ':' + actualPort + '（仅本机，无公网入口）');
      console.log('');
      console.log('  用法：打开控制台创建房间，会得到「白方 / 黑方 / 女神」三条私密链接。');
      console.log('  请只把白方/黑方链接给对应席位；女神链接不要出现在共享画面里。');
      console.log('  按 Ctrl+C 退出（房间状态会保存在数据目录，可恢复）。');
      console.log('');
    })
    .catch((error) => {
      console.error('启动失败：' + error.message);
      process.exitCode = 1;
    });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } catch (error) {
      console.error('退出时保存失败：' + error.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) startCli();

module.exports = { createApp, startCli, VERSION };
