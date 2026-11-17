'use strict';

/*
 * 本地房间持久化：每次状态变更写一个 JSON 文件到 data/rooms/<roomId>.json。
 * 只写本原型自己的 data 目录；不读取、不修改其他项目或用户配置。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOM_ID_PATTERN = /^[a-z0-9-]{3,32}$/;

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.roomsDir = path.join(dataDir, 'rooms');
    fs.mkdirSync(this.roomsDir, { recursive: true, mode: 0o700 });
  }

  roomFile(roomId) {
    if (!ROOM_ID_PATTERN.test(roomId)) throw new Error('非法房间号');
    return path.join(this.roomsDir, roomId + '.json');
  }

  loadAll() {
    const rooms = [];
    let names = [];
    try {
      names = fs.readdirSync(this.roomsDir);
    } catch {
      return rooms;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.roomsDir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw.id === 'string' && ROOM_ID_PATTERN.test(raw.id)) rooms.push(raw);
      } catch (error) {
        console.warn('[store] 跳过无法解析的房间文件：' + name + '（' + error.message + '）');
      }
    }
    return rooms;
  }

  save(room) {
    const file = this.roomFile(room.id);
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(room.toJSON(), null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

module.exports = { Store, ROOM_ID_PATTERN };
