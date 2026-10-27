'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { validCustom } = require('./workbench-appearance.cjs');

const AVATAR_IDS = new Set(['yui', 'devcat', 'bigfish', 'claude', 'gemini', 'custom']);
const DEFAULT_ROLES = Object.freeze([
  Object.freeze({ id: 'yui', name: 'Yui', avatarId: 'yui', customDataUrl: null, enabled: false }),
  Object.freeze({ id: 'bigfish', name: '大肥鱼', avatarId: 'bigfish', customDataUrl: null, enabled: true }),
  Object.freeze({ id: 'claude', name: 'Claude小姐', avatarId: 'claude', customDataUrl: null, enabled: false }),
]);
const IMAGE_ERROR = '头像必须是有效的 PNG 图片，且不超过 1 MB。';

function normalizeName(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) {
    throw new Error('角色名称不能包含控制字符，请输入 1–24 个字。');
  }
  const name = value.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 24) {
    throw new Error('角色名称请填写 1–24 个字。');
  }
  return name;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Check the PNG container and decoded scanlines as well as the existing size/signature guard.
// The output bound prevents an extremely compressed avatar from exhausting the desktop app.
function validPngDataUrl(value) {
  if (!validCustom(value)) return false;
  const encoded = value.slice('data:image/png;base64,'.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return false;
  let offset = 8;
  let header = null;
  let palette = false;
  let ended = false;
  let imageDataEnded = false;
  const imageData = [];
  try {
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return false;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
      const data = bytes.subarray(offset + 8, end - 4);
      if (!header && type !== 'IHDR') return false;
      if (type === 'IHDR') {
        if (header || offset !== 8 || length !== 13) return false;
        const width = data.readUInt32BE(0), height = data.readUInt32BE(4);
        const depth = data[8], color = data[9];
        const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || data[12] > 1) return false;
        header = { width, height, depth, color, interlace: data[12] };
      } else if (type === 'PLTE') {
        if (palette || imageData.length || !length || length % 3 || length > 768 || [0, 4].includes(header.color)) return false;
        if (header.color === 3 && length / 3 > 2 ** header.depth) return false;
        palette = true;
      } else if (type === 'IDAT') {
        if (imageDataEnded || (header.color === 3 && !palette)) return false;
        imageData.push(data);
      } else if (type === 'IEND') {
        if (length || !imageData.length || end !== bytes.length) return false;
        ended = true;
        break;
      } else {
        if (imageData.length) imageDataEnded = true;
        // Unknown critical chunks cannot be displayed by a standard PNG decoder.
        if (type[0] === type[0].toUpperCase()) return false;
      }
      offset = end;
    }
    if (!ended) return false;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color];
    const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => {
      const width = Math.max(0, Math.ceil((header.width - x) / dx));
      const height = Math.max(0, Math.ceil((header.height - y) / dy));
      return { height: width ? height : 0, stride: 1 + Math.ceil(width * channels * header.depth / 8) };
    });
    const expected = rows.reduce((sum, row) => sum + row.height * row.stride, 0);
    if (!Number.isSafeInteger(expected) || expected > 64 * 1024 * 1024) return false;
    const decoded = zlib.inflateSync(Buffer.concat(imageData), { maxOutputLength: Math.max(1, expected) });
    if (decoded.length !== expected) return false;
    let position = 0;
    for (const row of rows) {
      for (let y = 0; y < row.height; y++) {
        if (decoded[position] > 4) return false;
        position += row.stride;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function createRolesStore(file) {
  let value = { activeId: 'bigfish', roles: DEFAULT_ROLES.map(role => ({ ...role })) };
  try {
    // Three size-limited images plus JSON; do not read an unbounded corrupt configuration.
    if (fs.statSync(file).size <= 5 * 1024 * 1024) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved?.roles)) {
        value.roles = value.roles.map(role => {
          const entry = saved.roles.find(item => item && typeof item === 'object' && item.id === role.id);
          if (!entry) return role;
          try { role.name = normalizeName(entry.name); } catch {}
          if (validPngDataUrl(entry.customDataUrl)) role.customDataUrl = entry.customDataUrl;
          if (AVATAR_IDS.has(entry.avatarId) && (entry.avatarId !== 'custom' || role.customDataUrl)) role.avatarId = entry.avatarId;
          return role;
        });
      }
    }
  } catch {}

  const get = () => ({ activeId: value.activeId, roles: value.roles.map(role => ({ ...role })) });
  function findRole(id) {
    const role = value.roles.find(item => item.id === id);
    if (!role) throw new Error('未知角色，请选择 Yui、大肥鱼或 Claude小姐。');
    return role;
  }
  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(next, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    value = next;
    return get();
  }
  return {
    get,
    update(id, patch) {
      findRole(id);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('角色设置格式无效。');
      if (Object.hasOwn(patch, 'customDataUrl')) throw new Error('自定义头像请通过上传 PNG 图片设置。');
      const next = get();
      const role = next.roles.find(item => item.id === id);
      if (Object.hasOwn(patch, 'name')) role.name = normalizeName(patch.name);
      if (Object.hasOwn(patch, 'avatarId')) {
        if (!AVATAR_IDS.has(patch.avatarId) || (patch.avatarId === 'custom' && !role.customDataUrl)) {
          throw new Error('请选择内置头像或先上传 PNG 图片。');
        }
        role.avatarId = patch.avatarId;
      }
      // Role identity, availability, backend routing and arbitrary fields are code-owned.
      return save(next);
    },
    upload(id, pngDataUrl) {
      findRole(id);
      if (!validPngDataUrl(pngDataUrl)) throw new Error(IMAGE_ERROR);
      const next = get();
      const role = next.roles.find(item => item.id === id);
      role.customDataUrl = pngDataUrl;
      role.avatarId = 'custom';
      return save(next);
    },
    select(id) {
      const role = findRole(id);
      if (!role.enabled) throw new Error(`${role.name} 暂未接入，当前仅大肥鱼可用。`);
      const next = get();
      next.activeId = role.id;
      return save(next);
    },
  };
}

module.exports = { createRolesStore };
