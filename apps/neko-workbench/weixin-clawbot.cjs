'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { toDataURL } = require('./vendor/dsh-bili-whale/deps/qrcode.cjs');

const WEIXIN_ORIGIN = 'https://ilinkai.weixin.qq.com';
const baseInfo = { channel_version: '3.0.0', bot_agent: 'Nekofans' };
const validString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const expired = (result) => result.ret === -14 || result.errcode === -14;

function weixinOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Unexpected Weixin API origin');
  }
  return url.origin;
}

function createWeixinApi(fetchImpl) {
  return async function request(origin, endpoint, { body, token, signal, timeout = 15000 } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '196608' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetchImpl(new URL('/ilink/bot/' + endpoint, weixinOrigin(origin)), {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) throw Error('Weixin API returned HTTP ' + response.status);
    return JSON.parse(await response.text(), (key, value, context) => {
      if (key === 'message_id' && typeof value === 'number') return context.source;
      return value;
    });
  };
}

function createWeixinClawBot({ secretStore, syncStore, onMessage, onChange, fetch = globalThis.fetch, renderQr = toDataURL, pollDelayMs = 1000 }) {
  const request = createWeixinApi(fetch);
  let state = { phase: 'unbound' }, account = null, pairing = null, receiver = null, disposed = false;

  function publish(phase, details = {}) {
    state = { phase, ...details };
    onChange?.();
  }
  const snapshot = () => ({ ...state, bound: !!account });
  const wait = (ms, signal) => delay(ms, undefined, { signal, ref: false }).catch(() => {});
  const current = (run) => !disposed && receiver === run && !run.signal.aborted;

  function endPairing(login) {
    if (pairing !== login) return;
    clearTimeout(login.timer);
    login.controller.abort();
    pairing = null;
  }

  async function initialize() {
    try {
      const raw = await secretStore.get();
      if (!raw || disposed || account || pairing) return;
      const saved = JSON.parse(raw);
      if (!validString(saved.token, 4096) || !validString(saved.owner, 512) || !validString(saved.bot, 512)) throw Error('Invalid saved binding');
      account = { ...saved, origin: weixinOrigin(saved.origin) };
      startReceiver();
    } catch {
      if (!disposed && !account && !pairing) publish('error', { reason: '微信连接凭证无法读取，请重新绑定。' });
    }
  }

  async function begin() {
    if (disposed || pairing || account) return snapshot();
    if (!secretStore.available()) throw Error('系统加密存储不可用，无法绑定微信。');
    const login = { controller: new AbortController(), origin: WEIXIN_ORIGIN, until: Date.now() + 300000 };
    pairing = login;
    login.timer = setTimeout(() => {
      if (pairing !== login) return;
      endPairing(login);
      publish('error', { reason: '微信绑定已超时，请重新生成二维码。' });
    }, 300000);
    login.timer.unref?.();
    publish('starting');
    try {
      const code = await request(login.origin, 'get_bot_qrcode?bot_type=3', {
        body: { local_token_list: [] }, signal: login.controller.signal,
      });
      if (pairing !== login) return snapshot();
      if (!validString(code.qrcode, 4096) || !validString(code.qrcode_img_content, 4096)) throw Error('Invalid QR response');
      login.code = code.qrcode;
      login.image = await renderQr(code.qrcode_img_content, { width: 224, margin: 2 });
      if (pairing !== login) return snapshot();
      publish('waiting', { qrImage: login.image });
      void watchPairing(login);
    } catch {
      if (pairing === login) {
        endPairing(login);
        publish('error', { reason: '暂时取不到微信二维码，请检查网络后重试。' });
      }
    }
    return snapshot();
  }

  async function watchPairing(login, verifyCode) {
    const signal = login.controller.signal;
    while (pairing === login && Date.now() < login.until) {
      let result;
      try {
        const query = new URLSearchParams({ qrcode: login.code });
        if (verifyCode) query.set('verify_code', verifyCode);
        result = await request(login.origin, 'get_qrcode_status?' + query, { signal, timeout: 35000 });
      } catch {
        if (signal.aborted) return;
        if (verifyCode && pairing === login) {
          publish('pin', { reason: '验证码暂未确认，请重新输入。' });
          return;
        }
        await wait(pollDelayMs, signal);
        continue;
      }
      if (pairing !== login) return;
      if (['need_verifycode', 'confirmed_but_need_verifycode'].includes(result.status)) {
        publish('pin', { reason: verifyCode ? '验证码未通过，请再试一次。' : '输入手机微信显示的验证码。' });
        return;
      }
      verifyCode = undefined;
      if (result.status === 'confirmed') {
        try {
          const binding = {
            token: result.bot_token, owner: result.ilink_user_id, bot: result.ilink_bot_id,
            origin: result.baseurl ? weixinOrigin(result.baseurl) : login.origin,
          };
          if (!validString(binding.token, 4096) || !validString(binding.owner, 512) || !validString(binding.bot, 512)) throw Error('Incomplete binding');
          await secretStore.set(JSON.stringify(binding));
          if (pairing !== login) return;
          account = binding;
          endPairing(login);
          startReceiver();
        } catch {
          if (pairing !== login) return;
          endPairing(login);
          publish('error', { reason: '微信未返回完整凭证，或凭证无法保存，请重新绑定。' });
        }
        return;
      }
      if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) break;
      if (result.status === 'scaned_but_redirect') {
        try { login.origin = weixinOrigin('https://' + result.redirect_host); }
        catch { break; }
      }
      if (['scaned', 'scaned_but_redirect'].includes(result.status) && state.phase !== 'scanned') publish('scanned');
      await wait(pollDelayMs, signal);
    }
    if (pairing === login) {
      endPairing(login);
      publish('error', { reason: '微信绑定已结束，请重新生成二维码。' });
    }
  }

  function pin(code) {
    if (!pairing || state.phase !== 'pin') throw Error('当前没有等待验证的微信绑定。');
    if (!/^[0-9]{4,12}$/.test(code || '')) throw Error('请输入手机微信显示的数字验证码。');
    publish('scanned');
    void watchPairing(pairing, code);
    return snapshot();
  }

  function stop() {
    if (pairing) endPairing(pairing);
    receiver?.abort();
    receiver = null;
  }

  async function disconnect() {
    stop();
    try {
      await secretStore.clear();
      account = null;
      publish('unbound');
    } catch {
      publish('error', { reason: '微信已停止收消息，但本地凭证未能移除，请重试。' });
    }
    return snapshot();
  }

  function startReceiver() {
    if (!account || receiver || disposed) return;
    const run = new AbortController();
    receiver = run;
    publish('connecting');
    void receive(run, account).catch(() => {
      if (!current(run)) return;
      receiver = null;
      publish('error', { reason: '微信会话状态无法保存，接收已停止。请重试。' });
    });
  }

  async function receive(run, binding) {
    const key = createHash('sha256').update(JSON.stringify([binding.bot, binding.owner])).digest('hex');
    const saved = await syncStore.read();
    let cursor = saved?.key === key && typeof saved.cursor === 'string' ? saved.cursor : '';
    const seen = new Set(saved?.key === key && Array.isArray(saved.seen) ? saved.seen : []);
    const save = () => syncStore.write({ key, cursor, seen: [...seen] });
    while (current(run)) {
      let result;
      try {
        result = await request(binding.origin, 'getupdates', {
          body: { get_updates_buf: cursor, base_info: baseInfo }, token: binding.token, signal: run.signal, timeout: 40000,
        });
        if (!current(run)) return;
        if (expired(result)) {
          receiver = null;
          publish('expired', { reason: '微信连接已过期，请解除连接后重新扫码。' });
          return;
        }
        if (result.ret || result.errcode) throw Error('Weixin receive failed');
      } catch {
        if (!current(run)) return;
        if (state.phase !== 'retrying') publish('retrying', { reason: '微信连接暂时中断，正在重试。' });
        await wait(5000, run.signal);
        continue;
      }
      if (state.phase !== 'connected') publish('connected');
      for (const message of Array.isArray(result.msgs) ? result.msgs : []) {
        if (!current(run)) return;
        if (message?.from_user_id !== binding.owner || message.message_type !== 1 || message.group_id ||
            message.delete_time_ms || !validString(message.context_token, 4096)) continue;
        const id = [message.message_id, message.client_id, message.seq].find(value => validString(value, 512) || Number.isSafeInteger(value));
        if (id === undefined || seen.has(String(id))) continue;
        const items = message.item_list;
        const text = Array.isArray(items) && items.length && items.every(item => item?.type === 1 && typeof item.text_item?.text === 'string')
          ? items.map(item => item.text_item.text).join('\n').trim() : '';
        if (!text || text.length > 8000) continue;
        // Record before invoking the model so a replay cannot generate a duplicate reply.
        seen.add(String(id));
        if (seen.size > 512) seen.delete(seen.values().next().value);
        await save();
        if (!current(run)) return;
        try {
          const reply = await onMessage(text);
          if (!reply || !current(run)) continue;
          const sent = await request(binding.origin, 'sendmessage', {
            body: {
              msg: { from_user_id: '', to_user_id: binding.owner, client_id: randomUUID(),
                message_type: 2, message_state: 2, context_token: message.context_token,
                item_list: [{ type: 1, text_item: { text: reply } }] },
              base_info: baseInfo,
            }, token: binding.token, signal: run.signal,
          });
          if (sent.ret || sent.errcode) throw Error('Weixin send failed');
        } catch {
          if (current(run)) publish('connected', { reason: '有一条微信回复未能送达，可在主会话查看。' });
        }
      }
      if (current(run) && typeof result.get_updates_buf === 'string' && result.get_updates_buf !== cursor) {
        cursor = result.get_updates_buf;
        await save();
      }
      await wait(pollDelayMs, run.signal);
    }
  }

  return { snapshot, initialize, begin, pin, disconnect, resume() { startReceiver(); return snapshot(); },
    cancel() { if (pairing) { stop(); publish('unbound'); } return snapshot(); },
    dispose() { disposed = true; stop(); } };
}

module.exports = { createWeixinClawBot };
