'use strict';

/*
 * 受控模型适配器（P4）。
 *
 * 这里只定义“如何询问一个可信的本机/工作台适配器”，不包含任何真实账号、
 * API key、付费模型调用或工具访问。默认 unavailable；只有显式注入
 * synthetic/http(accountConnected) 适配器时才会产生决策调用。
 *
 * 安全边界：
 * - purpose 固定：game-player 只能读取 A 方 seat-safe 上下文；
 *   game-goddess 是独立用途，不复用 game-player 会话；
 * - 不把令牌、对手规则、真名/私密身份、女神字段交给适配器；
 * - 模型输出永远回服务端二次校验后才应用；
 * - 失败/超时/中断不自动走子、不自动重试；
 * - HTTP 适配器只允许 127.0.0.1/localhost/[::1]，不连接外网。
 */

const PURPOSE_PLAYER = 'game-player';
const PURPOSE_GODDESS = 'game-goddess';
const PURPOSES = Object.freeze([PURPOSE_PLAYER, PURPOSE_GODDESS]);

class AdapterError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status || 500;
  }
}

const UNAVAILABLE_PLAYER = Object.freeze({
  available: false,
  configured: false,
  mode: 'unavailable',
  purpose: PURPOSE_PLAYER,
  label: '未接入真实模型',
  note: '预留适配器：当前没有模型调用；可由人工以 A 席位代填或提交猜测。',
});

const HUMAN_OPPONENT = Object.freeze({
  available: false,
  configured: false,
  mode: 'unavailable',
  purpose: PURPOSE_PLAYER,
  label: '对方由人操作',
  note: 'B 座没有 AI 队友入口。',
});

const UNAVAILABLE_GODDESS = Object.freeze({
  available: false,
  configured: false,
  mode: 'unavailable',
  purpose: PURPOSE_GODDESS,
  label: '女神决策适配器未接入',
  note: '独立用途；不会复用 A 方 game-player 会话，也不会把双方私密信息交给 A 适配器。',
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function isLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function labelFor(purpose, extra) {
  if (purpose === PURPOSE_GODDESS) {
    return extra ? '女神决策适配器 · ' + extra : '女神决策适配器';
  }
  return extra || '大肥鱼决策适配器';
}

function createAdapter(options = {}) {
  const purpose = options.purpose || PURPOSE_PLAYER;
  if (!PURPOSES.includes(purpose)) throw new Error('unsupported adapter purpose');
  const mode = options.mode || 'unavailable';
  const timeoutMs = clampInt(options.timeoutMs, 100, 60000, 8000);
  const maxCalls = clampInt(options.maxCalls, 0, 1000, 20);
  const maxConcurrent = clampInt(options.maxConcurrent, 1, 10, 1);
  const endpoint = options.endpoint || null;
  const accountConnected = Boolean(options.accountConnected);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const syntheticDecision = options.decision;
  const syntheticDelayMs = clampInt(options.delayMs, 0, 60000, 0);

  let active = 0;
  let calls = 0;
  let lastError = null;

  function status() {
    const base = {
      purpose,
      mode,
      available: false,
      configured: mode !== 'unavailable',
      calls,
      maxCalls,
      maxConcurrent,
      lastError,
    };
    if (purpose === PURPOSE_GODDESS && mode === 'unavailable' && !endpoint) {
      return { ...base, ...UNAVAILABLE_GODDESS };
    }
    if (mode === 'unavailable') {
      return { ...base, ...UNAVAILABLE_PLAYER, purpose };
    }
    if (mode === 'synthetic') {
      return {
        ...base,
        available: true,
        label: labelFor(purpose, '合成适配器 · 未接真实模型'),
        note: '仅用于本地测试/演示的合成适配器；不访问账号、模型或付费服务。',
      };
    }
    if (mode === 'http') {
      if (!endpoint || !isLoopbackEndpoint(endpoint)) {
        return {
          ...base,
          available: false,
          configured: false,
          label: labelFor(purpose, '本地模型桥 · 配置无效'),
          note: 'HTTP 适配器只允许本机 127.0.0.1/localhost/[::1]。',
        };
      }
      if (!accountConnected) {
        return {
          ...base,
          available: false,
          label: labelFor(purpose, '本地模型桥 · 未接入真实账号'),
          note: '已配置本机端点但未验证真实账号；不会发请求，也不会调用付费模型。',
        };
      }
      return {
        ...base,
        available: true,
        label: labelFor(purpose, '本地模型桥'),
        note: '仅连接配置的本机 bridge；调用次数和并发受服务端限制。',
      };
    }
    return { ...base, available: false, label: labelFor(purpose, '未知适配器'), note: '不支持的适配器模式。' };
  }

  function assertCallable() {
    const current = status();
    if (!current.available) throw new AdapterError('adapter_unavailable', 503, current.label);
    if (active >= maxConcurrent) throw new AdapterError('adapter_busy', 409, '适配器正在处理另一个请求');
    if (calls >= maxCalls) throw new AdapterError('call_limit', 429, '适配器调用次数已达上限');
  }

  async function runSynthetic(context, signal, requestId) {
    if (syntheticDelayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, syntheticDelayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new AdapterError('adapter_aborted', 408, '适配器调用被中断'));
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    if (signal && signal.aborted) throw new AdapterError('adapter_aborted', 408, '适配器调用被中断');
    if (typeof syntheticDecision === 'function') {
      return syntheticDecision({ context, signal, requestId });
    }
    if (syntheticDecision && typeof syntheticDecision === 'object') return syntheticDecision;
    // 合成适配器的最小确定性策略：仅从服务端给出的动作列表选择，便于本地联调。
    const actions = context && context.actions ? context.actions : {};
    const first = (Array.isArray(actions.normal) && actions.normal[0])
      || (Array.isArray(actions.special) && actions.special[0])
      || null;
    if (first) return { kind: first.kind, actionId: first.id };
    if (actions.guess && actions.guess.allowed) return { kind: 'guess', text: '合成适配器提出一次猜测' };
    throw new AdapterError('adapter_bad_response', 502, '合成适配器没有可用动作');
  }

  async function runHttp(context, signal, requestId) {
    if (!fetchImpl) throw new AdapterError('adapter_error', 503, '本机没有可用的 fetch');
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(options.bearerToken ? { Authorization: 'Bearer ' + options.bearerToken } : {}),
        },
        body: JSON.stringify({
          protocol: 'nekofans.model-adapter.v1',
          purpose,
          requestId,
          context,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new AdapterError('adapter_too_large', 502, '适配器响应过大');
      if (!response.ok) throw new AdapterError('adapter_http_error', 502, '适配器 HTTP ' + response.status);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AdapterError('adapter_bad_json', 502, '适配器返回非 JSON');
      }
      return body && body.decision !== undefined ? body.decision : body;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (signal && signal.aborted) throw new AdapterError('adapter_aborted', 408, '适配器调用被中断');
      if (timedOut || controller.signal.aborted) throw new AdapterError('adapter_timeout', 504, '适配器超时');
      throw new AdapterError('adapter_error', 502, '适配器连接失败');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function decide(context, callOptions = {}) {
    assertCallable();
    const signal = callOptions.signal || null;
    const requestId = callOptions.requestId || null;
    active += 1;
    calls += 1;
    try {
      if (signal && signal.aborted) throw new AdapterError('adapter_aborted', 408, '适配器调用被中断');
      if (mode === 'synthetic') return await runSynthetic(context, signal, requestId);
      if (mode === 'http') return await runHttp(context, signal, requestId);
      throw new AdapterError('adapter_unavailable', 503, '适配器未配置');
    } catch (error) {
      if (signal && signal.aborted && !(error instanceof AdapterError)) {
        lastError = '适配器调用被中断';
        throw new AdapterError('adapter_aborted', 408, '适配器调用被中断');
      }
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      active -= 1;
    }
  }

  return { purpose, mode, status, decide };
}

function createTeammateAdapter(options = {}) {
  return createAdapter({ ...options, purpose: PURPOSE_PLAYER });
}

function createGoddessAdapter(options = {}) {
  return createAdapter({ ...options, purpose: PURPOSE_GODDESS });
}

// Room fallback（没有注入宿适配器时）：A 未接入、B 由人操作。
function getTeammateStatus(seat) {
  if (seat === 'black') return { ...HUMAN_OPPONENT };
  return { ...UNAVAILABLE_PLAYER };
}

function getGoddessStatus() {
  return { ...UNAVAILABLE_GODDESS };
}

module.exports = {
  PURPOSE_PLAYER,
  PURPOSE_GODDESS,
  PURPOSES,
  AdapterError,
  createAdapter,
  createTeammateAdapter,
  createGoddessAdapter,
  getTeammateStatus,
  getGoddessStatus,
  isLoopbackEndpoint,
};
