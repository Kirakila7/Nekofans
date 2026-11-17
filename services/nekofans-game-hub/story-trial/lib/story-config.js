'use strict';

/*
 * 剧情场景配置（仅服务端读取；不得通过静态资源暴露）。
 * 默认场景：A=白方「开源」，B=黑方「抹除笔记」；白王真名梁文峰、误称梁武帝。
 * 规则文本仍由双方在运行时私密提交；服务端只按场景映射能力。
 */

const fs = require('node:fs');
const path = require('node:path');
const Chess = require('./chess.js');
const { ABILITIES } = require('./story-rules.js');

const DEFAULT_FILE = path.join(__dirname, '..', 'config', 'story-scenario.json');
const ID_RE = /^[a-z0-9-]{1,32}$/;
const NAME_MAX = 40;

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, NAME_MAX);
}

function validateNameSeed(seed, index, id) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    throw new Error(`scenario ${id}: names[${index}] 必须是对象`);
  }
  if (seed.color !== 'w' && seed.color !== 'b') throw new Error(`scenario ${id}: names[${index}].color 非法`);
  if (typeof seed.type !== 'string' || !/^[pnbrqk]$/i.test(seed.type)) {
    throw new Error(`scenario ${id}: names[${index}].type 非法`);
  }
  if (typeof seed.square !== 'string' || Chess.squareIndex(seed.square) < 0) {
    throw new Error(`scenario ${id}: names[${index}].square 非法`);
  }
  const trueName = cleanName(seed.trueName);
  if (!trueName) throw new Error(`scenario ${id}: names[${index}].trueName 为空`);
  return {
    color: seed.color,
    type: seed.type.toLowerCase(),
    square: seed.square,
    trueName,
    alias: cleanName(seed.alias) || null,
  };
}

function validateScenario(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`scenario ${id}: 必须是对象`);
  if (raw.id !== undefined && raw.id !== id) throw new Error(`scenario ${id}: id 不匹配`);
  const abilities = raw.abilities || {};
  for (const seat of ['white', 'black']) {
    if (!ABILITIES.includes(abilities[seat])) {
      throw new Error(`scenario ${id}: abilities.${seat} 必须是 ${ABILITIES.join(' / ')}`);
    }
  }
  if (abilities.white === abilities.black) throw new Error(`scenario ${id}: 两方能力不能相同`);
  const names = (Array.isArray(raw.names) ? raw.names : []).map((seed, index) => validateNameSeed(seed, index, id));
  const poolTypes = (Array.isArray(raw.poolTypes) ? raw.poolTypes : ['p', 'n', 'b', 'r', 'q'])
    .map((type) => String(type).toLowerCase())
    .filter((type) => ['p', 'n', 'b', 'r', 'q'].includes(type));
  if (!poolTypes.length) throw new Error(`scenario ${id}: poolTypes 不能为空`);
  return {
    id,
    abilities: { white: abilities.white, black: abilities.black },
    names,
    poolTypes: Array.from(new Set(poolTypes)),
    kingErasureWins: raw.kingErasureWins !== false,
  };
}

function loadStoryScenarios(filePath = DEFAULT_FILE) {
  const scenarios = new Map();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn('[story-config] 无法读取剧情场景配置（剧情模式不可用）：' + error.message);
    return scenarios;
  }
  const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, value]) => ({ id, ...value }));
  for (const entry of entries) {
    try {
      const id = String(entry && entry.id ? entry.id : '').trim();
      if (!ID_RE.test(id)) throw new Error('id 非法');
      scenarios.set(id, validateScenario(entry, id));
    } catch (error) {
      console.warn('[story-config] 跳过无效剧情场景：' + error.message);
    }
  }
  return scenarios;
}

function getStoryScenario(scenarios, id) {
  if (!id || !scenarios) return null;
  return scenarios.get(String(id)) || null;
}

module.exports = {
  DEFAULT_FILE,
  loadStoryScenarios,
  getStoryScenario,
  validateScenario,
};
