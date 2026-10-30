'use strict';

// In-memory world logic; the workbench's separate storage adapter persists it.
// This module does not access Minecraft, accounts, the old home, or the network.
const MATERIALS = Object.freeze([
  'grass', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'oak_log',
  'glass', 'bricks', 'cherry_planks', 'cherry_log', 'white_wool',
  'red_wool', 'poppy', 'dandelion', 'bookshelf', 'glowstone',
]);
const allowedMaterials = new Set(MATERIALS);
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function coordinates(command) {
  const {x, y, z} = command;
  if (![x, y, z].every(Number.isSafeInteger) || x < -64 || x > 64 || z < -64 || z > 64 || y < -1 || y > 63) {
    throw new Error('方块位置无效');
  }
  return {x, y, z};
}

function createYuiHomeSession({empty = false} = {}) {
  const blocks = new Map();
  if (!empty) {
    const put = (x, y, z, material) => blocks.set(`${x},${y},${z}`, {x, y, z, material});
    // A small starter house, intentionally open at the top for a clear view.
    for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) put(x, 0, z, 'oak_planks');
    for (let y = 1; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        put(x, y, -2, y === 2 && Math.abs(x) === 1 ? 'glass' : 'oak_planks');
        if (x !== 0 || y === 3) put(x, y, 2, 'oak_planks'); // Two-block door opening.
      }
      for (let z = -1; z <= 1; z++) for (const x of [-3, 3]) {
        put(x, y, z, y === 2 && z === 0 ? 'glass' : 'oak_planks');
      }
    }
  }
  const listeners = new Set();
  let revision = 0;
  let camera = {azimuth: 40, elevation: 28, zoom: 1};
  let perspective = 'orbit';
  let avatar = {mode: 'world', control: 'auto', position: {x: 6, y: 0.5, z: 4}, form: 'human'};
  let avatarRevision = 0;

  function state() {
    return clone({
      ok: true, name: 'Yui 的家', storage: 'session', synced: false, revision,
      blocks: [...blocks.values()], building: false, paused: false, done: 0,
      total: 0, style: 'oak', camera, perspective, region: 'home', regionRevision: 0,
      avatar, avatarRevision, lastError: null, toolsConnected: false,
      materials: MATERIALS, sync: null, memory: null, farm: null, cobuild: null,
      window: null, speech: {connected: false, lastError: null, reply: null},
    });
  }

  function publish() {
    revision++;
    for (const listener of listeners) {
      // A broken consumer must not prevent another consumer from updating.
      try { listener(state()); } catch { /* The caller owns its listener. */ }
    }
    return state();
  }

  function command(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('家园操作无效');
    switch (input.action) {
      case 'status': return state();
      case 'place': {
        const pos = coordinates(input);
        if (!allowedMaterials.has(input.material)) throw new Error('方块材料无效');
        const key = `${pos.x},${pos.y},${pos.z}`;
        if (!blocks.has(key) && blocks.size >= 10000) throw new Error('已达到一万个方块');
        blocks.set(key, {...pos, material: input.material});
        return publish();
      }
      case 'remove': {
        const pos = coordinates(input);
        if (!blocks.delete(`${pos.x},${pos.y},${pos.z}`)) return state();
        return publish();
      }
      case 'clear':
        if (!blocks.size) return state();
        blocks.clear();
        return publish();
      case 'camera': {
        const next = {...camera};
        for (const key of ['azimuth', 'elevation', 'zoom']) {
          if (input[key] !== undefined) {
            if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error('视角值无效');
            next[key] = input[key];
          }
        }
        camera = {azimuth: next.azimuth, elevation: clamp(next.elevation, 8, 80), zoom: clamp(next.zoom, 0.4, 2.5)};
        perspective = 'orbit';
        return publish();
      }
      case 'perspective':
        if (!['orbit', 'yui'].includes(input.mode)) throw new Error('视角无效');
        perspective = input.mode;
        return publish();
      case 'avatar':
      case 'avatar_checkpoint': {
        const value = input.position;
        const p = value?.position;
        if (!value || value.mode !== 'world' || !p || ![p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n)) || Math.abs(p.x) > 64 || Math.abs(p.z) > 64 || p.y < -1 || p.y > 64) throw new Error('角色位置无效');
        avatar = {mode: 'world', control: value.control === 'manual' ? 'manual' : 'auto', position: {x: p.x, y: p.y, z: p.z}, form: value.form === 'cat' ? 'cat' : 'human'};
        avatarRevision++;
        return publish();
      }
      case 'avatar_reset':
        avatar = {mode: 'world', control: 'auto', position: {x: 6, y: 0.5, z: 4}, form: 'human'};
        avatarRevision++;
        return publish();
      default:
        throw new Error('此操作尚未在工作台会话中开放');
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('监听器无效');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  return {state, command, subscribe};
}

module.exports = {createYuiHomeSession};
