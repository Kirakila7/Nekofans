import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const random = (bytes = 18) => randomBytes(bytes).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
export const reject = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class GamePlatform {
  constructor(directory) {
    this.directory = directory;
    this.games = new Map(); this.rooms = new Map();
    if (directory) {
      mkdirSync(directory, { recursive: true });
      try {
        const data = JSON.parse(readFileSync(path.join(directory, 'platform.json'), 'utf8'));
        for (const game of data.games) this.games.set(game.id, game);
        for (const room of data.rooms) if (Date.now() - room.updated < 7 * 86400000) this.rooms.set(room.id, room);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  save() {
    if (!this.directory) return;
    const file = path.join(this.directory, 'platform.json');
    const encoded = JSON.stringify({ games: [...this.games.values()], rooms: [...this.rooms.values()] });
    if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) reject(503, '内测存档空间已满，请联系服主整理');
    writeFileSync(file + '.tmp', encoded, { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  publish(input) {
    const title = String(input.title || '').trim();
    if (!title || title.length > 60) reject(400, '请填写 1–60 字的游戏名称');
    if (typeof input.html !== 'string' || !input.html.trim() || Buffer.byteLength(input.html) > 512 * 1024) reject(400, '请上传不超过 512 KB 的单文件 HTML');
    if (!['turns', 'shared'].includes(input.mode)) reject(400, '请选择轮流操作或共同操作');
    const id = hash(input.mode + '\0' + title + '\0' + input.html).slice(0, 24);
    if (!this.games.has(id)) {
      if (this.games.size >= 300) reject(503, '作品数量达到内测上限，请联系服主');
      this.games.set(id, { id, title, mode: input.mode, html: input.html, created: Date.now(), sdk: 1 });
      try { this.save(); } catch (error) { this.games.delete(id); throw error; }
    }
    return this.gameInfo(id);
  }
  game(id) { const game = this.games.get(id); if (!game) reject(404, '作品不存在'); return game; }
  gameInfo(id) { const { html, ...info } = this.game(id); return info; }
  projects() { return [...this.games.keys()].reverse().map(id => this.gameInfo(id)); }
  room(id) { const room = this.rooms.get(id); if (!room) reject(404, '房间不存在或已经过期'); return room; }
  create(gameId, name, account) {
    this.game(gameId);
    for (const [id, room] of this.rooms) if (Date.now() - room.updated > 7 * 86400000) this.rooms.delete(id);
    if (this.rooms.size >= 1000) reject(503, '房间数量达到内测上限');
    const room = { id: random(9), gameId, seed: random(12), seats: [], events: [], updated: Date.now(), community: Boolean(account), phase: 'lobby' };
    this.rooms.set(room.id, room);
    try { return this.join(room.id, name, account); } catch (error) { this.rooms.delete(room.id); throw error; }
  }
  join(id, name, account) {
    const room = this.room(id);
    if (room.community && !account) reject(401, '请使用 N.E.K.O. 社区账号入座');
    if (!room.community && account) reject(409, '这个房间使用访客入座');
    const existing = account ? room.seats.findIndex(seat => seat.accountId === account.id) : -1;
    if (existing < 0 && room.seats.length >= 2) reject(409, '这局已经有两位玩家，请另外开一局');
    const token = random(32), player = existing < 0 ? room.seats.length : existing;
    const previousSeat = room.seats[player];
    const previousUpdated = room.updated;
    const fallbackName = account ? 'N.E.K.O. 玩家' : '旅行者';
    const displayName = account ? account.name : name;
    const seat = { name: String(displayName ?? '').trim().slice(0, 24) || fallbackName, hash: hash(token) };
    if (account) seat.accountId = account.id;
    room.seats[player] = seat;
    room.updated = Date.now();
    try { this.save(); } catch (error) {
      if (previousSeat) room.seats[player] = previousSeat;
      else room.seats.pop();
      room.updated = previousUpdated;
      throw error;
    }
    return { id, gameId: room.gameId, player, token, ...(account ? { community: true } : {}) };
  }
  auth(id, token) {
    if (typeof token !== 'string' || token.length > 100) reject(401, '席位凭证无效');
    const player = this.room(id).seats.findIndex(seat => safeEqual(seat.hash, hash(token)));
    if (player < 0) reject(401, '席位凭证无效');
    return player;
  }
  snapshot(id) {
    const room = this.room(id);
    return { type: 'state', id, gameId: room.gameId, game: this.gameInfo(room.gameId), phase: room.phase ?? 'playing', seed: room.seed, players: room.seats.map(seat => ({ name: seat.name })), events: room.events, version: room.events.length, turn: this.turn(room) };
  }
  configureRoom(id, player, message, online) {
    const room = this.room(id);
    if (player !== 0) reject(403, '只有房主可以更换项目或开始游戏');
    if (room.phase !== 'lobby') reject(409, '游戏已经开始');
    if (message.type === 'project') this.game(message.gameId);
    else if (message.type !== 'start') reject(400, '未知房间操作');
    else if (room.seats.length !== 2 || !online[0] || !online[1]) reject(409, '请等两位玩家都在线后开始');
    const next = { ...room, updated: Date.now() };
    if (message.type === 'project') next.gameId = message.gameId;
    else next.phase = 'playing';
    this.rooms.set(id, next);
    try { this.save(); } catch (error) { this.rooms.set(id, room); throw error; }
  }
  turn(room) { return room.events.length ? room.events.at(-1).nextTurn : 0; }
  action(id, player, input) {
    const room = this.room(id), game = this.game(room.gameId);
    if (room.phase === 'lobby') reject(409, '请等房主开始游戏');
    if (room.events.some(event => event.player === player && event.actionId === input.actionId)) return this.snapshot(id);
    if (typeof input.actionId !== 'string' || !/^[\w-]{8,80}$/.test(input.actionId)) reject(400, '操作编号无效');
    if (room.seats.length !== 2) reject(409, '等待另一位玩家加入');
    if (input.version !== room.events.length) reject(409, '棋局或游戏已更新，请重试');
    if (game.mode === 'turns' && this.turn(room) !== player) reject(409, '等待对方操作');
    if (input.action === null || typeof input.action !== 'object' || Array.isArray(input.action) || Buffer.byteLength(JSON.stringify(input.action)) > 4096) reject(400, '游戏操作格式无效或过大');
    if (room.events.length >= 2000) reject(409, '这局操作次数达到内测上限，请新开一局');
    const nextTurn = game.mode === 'turns' ? (input.endTurn === false ? player : 1 - player) : 0;
    const previousUpdated = room.updated;
    room.events.push({ seq: room.events.length + 1, player, actionId: input.actionId, action: input.action, nextTurn });
    room.updated = Date.now();
    try { this.save(); } catch (error) { room.events.pop(); room.updated = previousUpdated; throw error; }
    return this.snapshot(id);
  }
}
