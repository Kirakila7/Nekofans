'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT = Object.freeze({ enabled: false, side: 'workspace', left: 'coding', right: null, ratio: 0.5 });
const SLOTS = ['side', 'left', 'right'];
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['enabled', ...SLOTS, 'ratio'].includes(k))) throw Error('界面布局设置无效');
  if (typeof value.enabled !== 'boolean' || !['workspace', 'community', 'bilibili'].includes(value.side) || !['coding', 'community', 'bilibili', null].includes(value.left) || !['coding', 'community', 'bilibili', null].includes(value.right) || !Number.isFinite(value.ratio) || value.ratio < 0.25 || value.ratio > 0.75) throw Error('界面布局设置无效');
  const sites = SLOTS.map(k => value[k]).filter(x => x === 'community' || x === 'bilibili');
  if (new Set(sites).size !== sites.length || value.left === 'coding' && value.right === 'coding') throw Error('每个内容只能放在一个区域');
  return { enabled: value.enabled, side: value.side, left: value.left, right: value.right, ratio: value.ratio };
}
function createPaneLayout(file) {
  let value = { ...DEFAULT };
  try { if (fs.statSync(file).size < 16384) value = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* Existing layouts start with a normal coding surface. */ }
  return {
    get() { return { ...value }; },
    set(next) {
      const checked = validate(next);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify(checked, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); value = checked; }
      finally { fs.rmSync(temporary, { force: true }); }
      return { ...value };
    },
  };
}
module.exports = { createPaneLayout, validate, DEFAULT };
