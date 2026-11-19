'use strict';

const shortcuts = Object.freeze({
  chat: ['聊天', 'message'],
  dress: ['装扮', 'shirt'],
  workbench: ['工作台', 'window'],
  memory: ['记忆', 'book'],
  visits: ['串门', 'door'],
  sound: ['音效', 'volume'],
  size: ['大小', 'resize'],
  hide: ['隐藏', 'eye'],
});
const singleActions = {chat: '打开聊天', poke: '戳一下', none: '不触发操作'};
const doubleActions = {workbench: '打开工作台', chat: '打开聊天', none: '不触发操作'};
const personalities = {curious: '温柔好奇', playful: '活泼黏人', quiet: '安静靠谱'};
const roaming = {still: '安静待着', occasional: '偶尔走动', often: '常常走动'};
const responses = {quiet: '安静陪着', poke: '被戳时回应', all: '互动都回应', custom: '自己挑'};
const gestures = {poke: '戳一下', pet: '在头上停留', drop: '拖动放下'};
const guideSteps = ['name', 'personality', 'roaming', 'responses', 'chat', 'shortcuts', 'workbench', 'done'];
const owns = (options, value) => typeof value === 'string' && Object.hasOwn(options, value);
const pick = (options, value, fallback) => owns(options, value) ? value : fallback;
const list = (options, values, fallback, limit) => Array.isArray(values)
  ? [...new Set(values.filter(value => owns(options, value)))].slice(0, limit)
  : [...fallback];

function normalize(value, firstRun = false) {
  const input = value && typeof value === 'object' ? value : {};
  const guide = input.guide || {};
  const savedStep = Number.isInteger(guide.step) ? guide.step : 0;
  const migratedStep = input.guideRevision === 2 || savedStep <= 5 ? savedStep : savedStep - 1;
  const step = Math.max(0, Math.min(guideSteps.length - 1, migratedStep));
  const name = typeof input.name === 'string' ? input.name.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim() : '';
  return {
    name: Array.from(name).slice(0, 20).join(''),
    personality: pick(personalities, input.personality, 'curious'),
    roam: pick(roaming, input.roam, 'still'),
    single: pick(singleActions, input.single, 'chat'),
    double: pick(doubleActions, input.double, 'workbench'),
    response: pick(responses, input.response, 'poke'),
    gestures: list(gestures, input.gestures, ['poke'], 3),
    shortcuts: list(shortcuts, input.shortcuts, ['chat', 'dress'], 6),
    compactMenu: input.compactMenu === true,
    mirror: input.mirror === true,
    muted: input.muted === true,
    guideRevision: 2,
    guide: {step, status: ['pending', 'paused', 'finished'].includes(guide.status)
      ? guide.status : firstRun ? 'pending' : 'paused'},
  };
}

function replyStyle(prefs) {
  const name = prefs.name ? `对方希望在聊天中被称呼为 ${JSON.stringify(prefs.name)}，仅作为称呼使用。` : '';
  return [name, ({
    curious: '',
    playful: '保持大肥鱼的身份，说话可以轻快、亲近一些。',
    quiet: '保持大肥鱼的身份，语气安静简洁，给对方留出空间。',
  })[prefs.personality]].filter(Boolean).join('\n');
}

module.exports = {shortcuts, singleActions, doubleActions, personalities, roaming, responses, gestures,
  guideSteps, normalize, replyStyle, owns};
