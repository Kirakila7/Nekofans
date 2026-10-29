'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT = Object.freeze({ enabled: false, side: 'workspace', left: 'coding', right: null, ratio: 0.5 });
const SLOTS = ['side', 'left', 'right'];
const FLEX_KEYS = ['enabled', 'rootAxis', 'rootRatio', 'stackAxis', 'stackRatio', 'slots'];
const FLEX_CONTENT = ['social', 'bilibili', 'coding'];
function validateFlex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== FLEX_KEYS.length || FLEX_KEYS.some(key => !Object.hasOwn(value, key))
      || typeof value.enabled !== 'boolean' || !['x', 'y'].includes(value.rootAxis) || !['x', 'y'].includes(value.stackAxis)
      || ![value.rootRatio, value.stackRatio].every(ratio => Number.isFinite(ratio) && ratio >= 0.15 && ratio <= 0.85)
      || !Array.isArray(value.slots) || value.slots.length !== FLEX_CONTENT.length
      || value.slots.some(item => !FLEX_CONTENT.includes(item)) || new Set(value.slots).size !== FLEX_CONTENT.length) {
    throw Error('自由布局设置无效');
  }
  return { enabled: value.enabled, rootAxis: value.rootAxis, rootRatio: value.rootRatio,
    stackAxis: value.stackAxis, stackRatio: value.stackRatio, slots: [...value.slots] };
}
function copy(value) { return { ...value, ...(value.flex ? { flex: { ...value.flex, slots: [...value.flex.slots] } } : {}) }; }
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['enabled', ...SLOTS, 'ratio', 'flex'].includes(k))) throw Error('界面布局设置无效');
  if (typeof value.enabled !== 'boolean' || !['workspace', 'community', 'bilibili'].includes(value.side) || !['coding', 'community', 'bilibili', null].includes(value.left) || !['coding', 'community', 'bilibili', null].includes(value.right) || !Number.isFinite(value.ratio) || value.ratio < 0.25 || value.ratio > 0.75) throw Error('界面布局设置无效');
  const sites = SLOTS.map(k => value[k]).filter(x => x === 'community' || x === 'bilibili');
  if (new Set(sites).size !== sites.length || value.left === 'coding' && value.right === 'coding') throw Error('每个内容只能放在一个区域');
  return { enabled: value.enabled, side: value.side, left: value.left, right: value.right, ratio: value.ratio,
    ...(Object.hasOwn(value, 'flex') ? { flex: validateFlex(value.flex) } : {}) };
}
function createPaneLayout(file) {
  let value = { ...DEFAULT };
  try { if (fs.statSync(file).size < 16384) value = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* Existing layouts start with a normal coding surface. */ }
  return {
    get() { return copy(value); },
    set(next) {
      // Older clients only know the original fields. Preserve the flexible
      // layout if one was already saved, while keeping legacy-only files in
      // their existing format. Disable flex explicitly with flex.enabled.
      const candidate = value.flex && next && typeof next === 'object' && !Array.isArray(next) && !Object.hasOwn(next, 'flex') ? { ...next, flex: value.flex } : next;
      const checked = validate(candidate);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify(checked, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); value = checked; }
      finally { fs.rmSync(temporary, { force: true }); }
      return copy(value);
    },
  };
}
module.exports = { createPaneLayout, validate, DEFAULT };
