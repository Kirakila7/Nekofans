'use strict';

// These textures are read only from the user's installed Minecraft client.
// The renderer may select neither the source path nor the archive members.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const {constants:fsConstants} = require('node:fs');
const {execFile} = require('node:child_process');

const TEXTURES = Object.freeze({
  grass: ['grass_block_top', 'grass_block_side'],
  dirt: ['dirt', 'dirt'], stone: ['stone', 'stone'], cobblestone: ['cobblestone', 'cobblestone'],
  oak_planks: ['oak_planks', 'oak_planks'], oak_log: ['oak_log_top', 'oak_log'],
  glass: ['glass', 'glass'], bricks: ['bricks', 'bricks'],
  cherry_planks: ['cherry_planks', 'cherry_planks'], cherry_log: ['cherry_log_top', 'cherry_log'],
  white_wool: ['white_wool', 'white_wool'], red_wool: ['red_wool', 'red_wool'],
  poppy: ['poppy', 'poppy'], dandelion: ['dandelion', 'dandelion'],
  bookshelf: ['oak_planks', 'bookshelf'], glowstone: ['glowstone', 'glowstone'],
});
const MAX_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validPng(data) {
  if (!Buffer.isBuffer(data) || data.length < 57 || data.length > MAX_BYTES || !data.subarray(0,8).equals(PNG_SIGNATURE)) return false;
  let offset = 8, first = true, seenData = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > MAX_BYTES || offset + 12 + length > data.length) return false;
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) return false;
    if (first) {
      if (type !== 'IHDR' || length !== 13 || body.readUInt32BE(0) < 1 || body.readUInt32BE(0) > 256 || body.readUInt32BE(4) < 1 || body.readUInt32BE(4) > 256) return false;
      first = false;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') seenData = true;
    offset += length + 12;
    if (type === 'IEND') return length === 0 && seenData && offset === data.length;
  }
  return false;
}
function extractPng(archive, member) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/unzip', ['-p', archive, member], {encoding:'buffer', timeout:4000, maxBuffer:MAX_BYTES, windowsHide:true}, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
function probeOriginal(files) {
  return new Promise(resolve => {
    // stat reads metadata only; opening an iCloud dataless file could wait indefinitely.
    execFile('/usr/bin/stat', ['-f', '%Sf', ...files], {encoding:'utf8', timeout:2000, maxBuffer:8192}, (error, stdout) => {
      const flags = stdout.trim().split(/\r?\n/);
      resolve(!error && flags.length === files.length && flags.every(flag => !/(?:^|,)dataless(?:,|$)/.test(flag)));
    });
  });
}
async function readOriginalPng(file) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error('invalid texture');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const {bytesRead} = await handle.read(data, offset, data.length-offset, offset);
      if (!bytesRead) throw new Error('incomplete texture');
      offset += bytesRead;
    }
    return data;
  } finally { await handle.close(); }
}
function createYuiHomeTextures({jarPath = path.join(os.homedir(), 'Library/Application Support/minecraft/versions/1.21.6/1.21.6.jar'), originalDirectory = path.join(os.homedir(), 'Documents/ChatGPT/猫娘计划/neko-voice-pr1/plugin/plugins/yui_home/mac_runtime/public/textures'), extract = extractPng, probeOriginal:probe = probeOriginal} = {}) {
  if (typeof jarPath !== 'string' || !path.isAbsolute(jarPath) || typeof originalDirectory !== 'string' || !path.isAbsolute(originalDirectory) || typeof extract !== 'function' || typeof probe !== 'function') throw new TypeError('纹理来源无效');
  let cached;
  async function collect() {
    const files = [...new Set(Object.values(TEXTURES).flat())];
    const found = Object.create(null);
    const originals = files.map(name => path.join(originalDirectory, `${name}.png`));
    // All originals must be available: avoid mixing unverified sources.
    try {
      const details = await Promise.all(originals.map(file => fs.lstat(file)));
      if (details.every(st => st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= MAX_BYTES) && await probe(originals)) {
        const reads = Promise.all(originals.map(readOriginalPng));
        const bytes = await Promise.race([reads, new Promise((_,reject) => { const timer=setTimeout(() => reject(new Error('timeout')),2000); timer.unref(); })]);
        if (bytes.every(validPng)) {
          for (let i=0;i<files.length;i++) found[files[i]] = `data:image/png;base64,${bytes[i].toString('base64')}`;
          const materials={};
          for (const [material,[top,side]] of Object.entries(TEXTURES)) materials[material]={top:found[top],side:found[side]};
          return {status:'available',source:'yui-original',materials};
        }
      }
    } catch { /* Missing, offline or unreadable original: try local Minecraft. */ }
    let index = 0;
    async function worker() {
      while (index < files.length) {
        const name = files[index++];
        try {
          const bytes = await extract(jarPath, `assets/minecraft/textures/block/${name}.png`);
          if (validPng(bytes)) found[name] = `data:image/png;base64,${bytes.toString('base64')}`;
        } catch { /* Unavailable source or asset: preserve procedural fallback. */ }
      }
    }
    await Promise.all(Array.from({length:Math.min(files.length,4)}, worker));
    const materials = {};
    for (const [material, [top, side]] of Object.entries(TEXTURES)) {
      if (found[top] && found[side]) materials[material] = {top:found[top],side:found[side]};
    }
    const count = Object.keys(materials).length;
    return {status:count === 0 ? 'unavailable' : count === Object.keys(TEXTURES).length ? 'available' : 'partial', source:count ? 'minecraft-local' : 'unavailable', materials};
  }
  return {
    load() { if (!cached) cached = collect(); return cached; },
    clearCache() { cached = null; },
  };
}
module.exports = {createYuiHomeTextures, validPng};
