'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const AVATARS = new Set(['yui', 'devcat', 'bigfish', 'claude', 'gemini', 'custom']);
const DEFAULT_SEATS = [
  { id: 'seat-1', name: 'DSH', avatarId: 'bigfish', provider: 'dsh', projectRoot: null, customDataUrl: null },
  { id: 'seat-2', name: 'Codex', avatarId: 'devcat', provider: 'codex', projectRoot: null, customDataUrl: null },
  { id: 'seat-3', name: '工作助手', avatarId: 'claude', provider: null, projectRoot: null, customDataUrl: null },
];
function safeName(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 24 || /[\p{Cc}\p{Cf}]/u.test(value)) throw Error('名称请填写 1–24 个字');
  return value.trim();
}
function createWorkspaceLayout(file) {
  let value = { officeMode: 'dsh', codexEnabled:false, activeSeatId: null, companionCollapsed: false, companionHistoryOpen: false, seats: structuredClone(DEFAULT_SEATS) };
  try {
    if (fs.statSync(file).size < 5 * 1024 * 1024) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (['dsh', 'codex'].includes(saved.officeMode)) value.officeMode = saved.officeMode;
      value.codexEnabled = saved.codexEnabled === true;
      if (typeof saved.companionCollapsed === 'boolean') value.companionCollapsed = saved.companionCollapsed;
      if (typeof saved.companionHistoryOpen === 'boolean') value.companionHistoryOpen = saved.companionHistoryOpen;
      for (const seat of value.seats) {
        const item = saved.seats?.find(s => s.id === seat.id); if (!item) continue;
        try { seat.name = safeName(item.name); } catch {}
        if (['dsh', 'codex', null].includes(item.provider)) seat.provider = item.provider;
        if (AVATARS.has(item.avatarId) && item.avatarId !== 'custom') seat.avatarId = item.avatarId;
        if (typeof item.customDataUrl === 'string' && item.customDataUrl.length < 1500000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(item.customDataUrl)) { seat.customDataUrl = item.customDataUrl; if (item.avatarId === 'custom') seat.avatarId = 'custom'; }
        if (typeof item.projectRoot === 'string' && path.isAbsolute(item.projectRoot) && !item.projectRoot.includes('\0')) seat.projectRoot = item.projectRoot;
      }
      if (value.seats.some(s => s.id === saved.activeSeatId)) value.activeSeatId = saved.activeSeatId;
    }
  } catch {}
  const get = () => structuredClone(value);
  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); value = next; }
    finally { fs.rmSync(temp, { force: true }); }
    return get();
  }
  return {
    get,
    update(patch) {
      if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['officeMode', 'codexEnabled', 'activeSeatId', 'companionCollapsed', 'companionHistoryOpen'].includes(k))) throw Error('工作台选项无效');
      const next = get();
      if ('codexEnabled' in patch) { if (typeof patch.codexEnabled !== 'boolean') throw Error('Codex 启用选项无效'); next.codexEnabled = patch.codexEnabled; }
      if ('officeMode' in patch) { if (!['dsh', 'codex'].includes(patch.officeMode)) throw Error('请选择 DSH 或 Codex'); next.officeMode = patch.officeMode; }
      if ('activeSeatId' in patch) { if (patch.activeSeatId !== null && !next.seats.some(s => s.id === patch.activeSeatId)) throw Error('工作入口不存在'); next.activeSeatId = patch.activeSeatId; }
      if ('companionCollapsed' in patch) { if (typeof patch.companionCollapsed !== 'boolean') throw Error('聊天显示选项无效'); next.companionCollapsed = patch.companionCollapsed; }
      if ('companionHistoryOpen' in patch) { if (typeof patch.companionHistoryOpen !== 'boolean') throw Error('聊天记录显示选项无效'); next.companionHistoryOpen = patch.companionHistoryOpen; }
      return save(next);
    },
    updateSeat(id, patch) {
      const next = get(), seat = next.seats.find(s => s.id === id); if (!seat) throw Error('工作入口不存在');
      if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['name', 'avatarId', 'provider', 'projectRoot'].includes(k))) throw Error('工作入口配置无效');
      if ('name' in patch) seat.name = safeName(patch.name);
      if ('provider' in patch) { if (!['dsh', 'codex', null].includes(patch.provider)) throw Error('请选择已接入的执行平台'); seat.provider = patch.provider; }
      if ('avatarId' in patch) { if (!AVATARS.has(patch.avatarId) || patch.avatarId === 'custom' && !seat.customDataUrl) throw Error('头像无效'); seat.avatarId = patch.avatarId; }
      if ('projectRoot' in patch) { if (patch.projectRoot !== null && (typeof patch.projectRoot !== 'string' || !path.isAbsolute(patch.projectRoot) || patch.projectRoot.includes('\0'))) throw Error('项目目录无效'); seat.projectRoot = patch.projectRoot; }
      return save(next);
    },
    uploadSeat(id, image) {
      const next = get(), seat = next.seats.find(s => s.id === id); if (!seat) throw Error('工作入口不存在');
      if (typeof image !== 'string' || image.length > 1500000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image)) throw Error('头像无效');
      seat.customDataUrl = image; seat.avatarId = 'custom'; return save(next);
    },
  };
}
function projectGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const cwd = row.cwd || '';
    const key = cwd ? projectPathKey(cwd) : 'unassigned:' + row.provider;
    if (!groups.has(key)) groups.set(key, { id: key, provider: row.provider, providers:[], cwd, name: cwd ? path.basename(cwd) || cwd : '未指定项目', sessions: [] });
    if (!groups.get(key).providers.includes(row.provider)) groups.get(key).providers.push(row.provider);
    groups.get(key).sessions.push(row);
  }
  return [...groups.values()].sort((a, b) => Math.max(...b.sessions.map(s => s.updatedAt || 0)) - Math.max(...a.sessions.map(s => s.updatedAt || 0)));
}
function projectPathKey(cwd) {
  // Windows paths can arrive from another platform's catalog. Normalize drive,
  // slash and case only for Windows roots; POSIX roots remain case-sensitive.
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd)) return path.win32.normalize(cwd).replace(/[\\/]+$/,'').toLowerCase();
  return path.posix.normalize(cwd).replace(/\/$/,'') || '/';
}
module.exports = { createWorkspaceLayout, projectGroups, projectPathKey, DEFAULT_SEATS };
