'use strict';

// In-memory world logic; the workbench's separate storage adapter persists it.
// This module does not access Minecraft, accounts, the old home, or the network.
const MATERIALS = Object.freeze([
  'grass', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'oak_log',
  'glass', 'bricks', 'cherry_planks', 'cherry_log', 'white_wool',
  'red_wool', 'poppy', 'dandelion', 'bookshelf', 'glowstone',
]);
const allowedMaterials = new Set(MATERIALS);
const {validateHomeItems}=require('./our-home-scene.cjs');
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
    // The shared home starts with a floor only. Furniture comes from co-building.
    for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) put(x, 0, z, 'oak_planks');
  }
  const listeners = new Set();
  let revision = 0;
  let camera = {azimuth: 40, elevation: 28, zoom: 1};
  let perspective = 'orbit';
  let avatar = {mode:'world',control:'auto',position:{x:0,y:0,z:2.5},form:'human',atHome:false,yaw:0,pitch:-10};
  let items=[];
  let avatarRevision = 0;

  function state() {
    return clone({
      ok: true, name: '我的小窝', storage: 'session', synced: false, revision,items,
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
      case 'furnish': items=validateHomeItems(input.items);return publish();
      case 'return-home': avatar={...avatar,atHome:true,position:{x:0,y:0,z:2.5},yaw:0,pitch:-10};avatarRevision++;return publish();
      case 'avatar_look': {
        if(![input.yaw,input.pitch].every(Number.isFinite))throw Error('角色朝向无效');avatar={...avatar,yaw:((input.yaw%360)+360)%360,pitch:clamp(input.pitch,-55,45)};avatarRevision++;return publish();
      }
      case 'avatar_walk': {
        if(![input.dx,input.dz].every(n=>Number.isFinite(n)&&Math.abs(n)<=1))throw Error('角色移动无效');const p=avatar.position,x=clamp(p.x+input.dx,-4.1,4.1),z=clamp(p.z+input.dz,-3.1,3.1);
        const collision=items.some(o=>{if(o.kind==='rug'||o.y>1.35)return false;const r=o.rotation*Math.PI/180,dx=x-o.x,dz=z-o.z;return Math.abs(dx*Math.cos(r)-dz*Math.sin(r))<o.width/2+.15&&Math.abs(dx*Math.sin(r)+dz*Math.cos(r))<o.depth/2+.15;});if(!collision)avatar={...avatar,atHome:true,position:{x,y:0,z}};avatarRevision++;return publish();
      }
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
        if (!['orbit', 'yui','agent'].includes(input.mode)) throw new Error('视角无效');
        perspective = input.mode;
        return publish();
      case 'avatar':
      case 'avatar_checkpoint': {
        const value = input.position;
        const p = value?.position;
        if (!value || value.mode !== 'world' || !p || ![p.x, p.y, p.z].every(n => typeof n === 'number' && Number.isFinite(n)) || Math.abs(p.x) > 64 || Math.abs(p.z) > 64 || p.y < -1 || p.y > 64) throw new Error('角色位置无效');
        avatar = {...avatar,mode: 'world', control: value.control === 'manual' ? 'manual' : 'auto', position: {x: p.x, y: p.y, z: p.z}, form: value.form === 'cat' ? 'cat' : 'human',atHome:value.atHome===true,yaw:Number.isFinite(value.yaw)?value.yaw:avatar.yaw,pitch:Number.isFinite(value.pitch)?clamp(value.pitch,-55,45):avatar.pitch};
        avatarRevision++;
        return publish();
      }
      case 'avatar_reset':
        avatar = {mode:'world',control:'auto',position:{x:0,y:0,z:2.5},form:'human',atHome:true,yaw:0,pitch:-10};
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
