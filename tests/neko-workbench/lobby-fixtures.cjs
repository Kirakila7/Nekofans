'use strict';
// Synthetic lobby fixtures: fake clock/timers, fake ChatProvider, message builders.
const OWNER = 'u-owner', CAT = 'c-mine', OTHER = 'u-other', OTHER_CAT = 'c-other';

function fakeTimers(start = Date.parse('2026-10-29T12:00:00Z')) {
  let time = start, seq = 0;
  const queue = new Map();
  const timers = {
    setTimeout(fn, ms) { const id = ++seq; queue.set(id, { at: time + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout(id) { queue.delete(id); },
  };
  async function advance(ms) {
    const until = time + ms;
    for (;;) {
      const due = [...queue].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      queue.delete(due[0]); time = due[1].at; due[1].fn();
      await flush();
    }
    time = until; await flush();
  }
  return { timers, now: () => time, advance, pending: () => [...queue.values()].map(t => t.at - time) };
}
async function flush() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }

/** reply: string | (request) => string | Promise<string> | Error. hold:true waits until release(). */
function fakeProvider(reply = '好呀', { hold = false } = {}) {
  const calls = [], gates = [];
  const provider = {
    calls,
    release() { while (gates.length) gates.shift()(); },
    async *stream(request) {
      calls.push(request);
      if (hold) await new Promise(resolve => { gates.push(resolve); request.signal?.addEventListener('abort', resolve, { once: true }); });
      if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const value = typeof reply === 'function' ? await reply(request) : reply;
      if (value instanceof Error) throw value;
      for (const part of String(value).match(/[\s\S]{1,4}/g) || []) yield { type: 'delta', text: part };
      yield { type: 'complete', text: value };
    },
  };
  return provider;
}

let counter = 0;
function message(extra = {}) {
  counter++;
  const author = extra.author || { kind: 'human', user_id: OTHER, display_name: '阿布', avatar: { kind: 'hue', hue: 10, text: '阿' } };
  return { id: extra.id || 'm' + counter, seq: extra.seq ?? counter, channel_id: 'ch-lobby', created_at: extra.created_at,
    deleted: false, text: '合成消息 ' + counter, origin: author.kind === 'cat' ? 'cat' : 'human', label: author.display_name,
    mentions: [], reply_to: null, cat_depth: author.kind === 'cat' ? 1 : 0, ...extra, author };
}
const owner = (extra = {}) => message({ author: { kind: 'human', user_id: OWNER, display_name: '主人小明' }, ...extra });
const myCat = (extra = {}) => message({ author: { kind: 'cat', cat_id: CAT, owner_user_id: OWNER, display_name: '主人小明的大肥鱼', name: '大肥鱼' }, ...extra });
const otherCat = (extra = {}) => message({ author: { kind: 'cat', cat_id: OTHER_CAT, owner_user_id: OTHER, display_name: '阿布的小黑', name: '小黑' }, ...extra });

const persona = () => ({ name: '大肥鱼', prompt: '合成人设：一只温和的猫娘。' });

module.exports = { OWNER, CAT, OTHER, OTHER_CAT, fakeTimers, flush, fakeProvider, message, owner, myCat, otherCat, persona };
