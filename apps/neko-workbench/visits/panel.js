(function (scope) {
  'use strict';
  const phases = { idle: '等待串门', inviting: '等待好友接受', waiting: '等待好友加入', connecting: '正在连接', connected: '串门中', active: '串门中', chatting: '串门中', reconnecting: '正在重新连接', stopping: '正在结束', ended: '串门已结束', closed: '串门已结束', failed: '连接未完成', error: '连接未完成' };
  const finished = new Set(['ended', 'closed', 'failed', 'error', 'idle']);
  const reasons = { completed: '这次聊天已聊完', stopped: '已结束串门', user_stopped: '已结束串门', peer_left: '好友已离开', declined: '好友暂时不方便', expired: '邀请已过期', disconnected: '连接已断开', round_limit: '这次聊天已聊完' };
  const errors = { config_not_ready: '串门登录服务尚未配置，请先完成服务配置。', chat_model_not_ready: '请先配置聊天 API，再让猫娘串门。', model_not_ready: '请先配置聊天 API，再让猫娘串门。', invalid_service_response: '串门服务返回异常，请稍后重试。', login_required: '请先登录社区，再继续串门。', timeout: '网络连接超时，请检查网络后重试。', service_timeout: '网络连接超时，请检查网络后重试。' };
  Object.assign(errors, {
    oauth_callback_unavailable: '登录回调端口不可用，请检查端口占用或更换已注册的回调地址后重试。',
    browser_open_failed: '未能打开系统浏览器，请检查默认浏览器设置后重试。',
    login_timeout: '登录等待已超时，请重新点击登录社区。',
    login_declined: '本次登录未获授权，请重新登录。',
    secure_storage_unavailable: '系统加密存储不可用，暂时无法安全保存登录信息。',
    token_store_unavailable: '本机登录信息无法读取，请点击登录社区重新授权。',
  });
  const errorText = value => errors[typeof value === 'string' ? value : value?.code] || '串门暂时遇到问题，请刷新或结束后重新邀请。';
  function createPanel({ document: doc, window: win, bridge, root = doc.getElementById('visits-root') }) {
    let state = {}, pending = 0, localError = '', dirty = false, selectedHistory = null, historyResult = null, disposed = false, accountEpoch = 0, stateErrorVersion = 0;
    const nodes = {};
    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }
    function button(text, fn, className = '') {
      const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', fn); return node;
    }
    function section(title) { const node = el('section', 'card'); node.append(el('h2', '', title)); return node; }
    const header = el('header', 'topbar'), title = el('div');
    title.append(el('p', 'eyebrow', 'N.E.K.O. · 好友时光'), el('h1', '', '猫娘串门'));
    const accountBox = el('div', 'account');
    nodes.account = el('span', 'muted');
    nodes.login = button('登录社区', () => request('login'), 'primary');
    nodes.logout = button('退出登录', () => request('logout'));
    accountBox.append(nodes.account, nodes.login, nodes.logout); header.append(title, accountBox);
    nodes.alert = el('div', 'alert'); nodes.alert.setAttribute('role', 'alert'); nodes.alert.hidden = true;
    const layout = el('main', 'layout'), sidebar = el('aside', 'sidebar'); sidebar.setAttribute('aria-label', '串门设置与好友');
    const persona = section('公开猫娘人设');
    persona.append(el('p', 'muted', '好友会看到这些资料。串门独立保存，不读取主人私聊或私人记忆。'));
    const form = el('form', 'persona-form');
    const nameLabel = el('label', '', '猫娘名字（最多 64 字符）'); nodes.name = el('input'); nodes.name.type = 'text'; nodes.name.maxLength = 64; nodes.name.required = true; nameLabel.append(nodes.name);
    const descriptionLabel = el('label', '', '对外介绍'); nodes.description = el('textarea'); nodes.description.rows = 3; nodes.description.maxLength = 1024; descriptionLabel.append(nodes.description, el('span', 'muted', '最多 1024 UTF-8 字节，约 340 个汉字；超出时不会保存。'));
    for (const input of [nodes.name, nodes.description]) input.addEventListener('input', () => { dirty = true; });
    nodes.save = button('保存公开人设', () => {}); nodes.save.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      const name = nodes.name.value.trim(), description = nodes.description.value.trim();
      if (!name) { localError = '先给猫娘取个名字吧。'; render(); return; }
      if (name.length > 64) { localError = '猫娘名字不能超过 64 字符。'; render(); return; }
      if (new TextEncoder().encode(description).length > 1024) { localError = '对外介绍超过 1024 UTF-8 字节，请缩短后保存（约 340 个汉字）。'; render(); return; }
      request('savePersona', { name, description }).then(ok => { if (ok) dirty = false; });
    });
    form.append(nameLabel, descriptionLabel, nodes.save); persona.append(form);
    const friends = section('好友'); nodes.refresh = button('刷新', () => request('refresh'), 'small'); friends.append(nodes.refresh);
    nodes.friends = el('div', 'list'); friends.append(nodes.friends);
    const invitations = section('待处理邀请'); nodes.invitations = el('div', 'list'); invitations.append(nodes.invitations);
    const history = section('最近串门'); nodes.history = el('div', 'list'); history.append(nodes.history);
    sidebar.append(persona, friends, invitations, history);
    const conversation = el('section', 'conversation card'); conversation.setAttribute('aria-label', '双猫文本对话');
    const chatHeader = el('div', 'chat-header'), chatHeading = el('div');
    nodes.chatTitle = el('h2', '', '等一位好友来坐坐'); nodes.phase = el('p', 'status'); nodes.phase.setAttribute('role', 'status'); chatHeading.append(nodes.chatTitle, nodes.phase);
    const controls = el('div', 'controls'); nodes.live = button('返回当前串门', () => { selectedHistory = null; historyResult = null; render(); }); nodes.stop = button('结束串门', () => request('stop'), 'danger'); controls.append(nodes.live, nodes.stop); chatHeader.append(chatHeading, controls);
    nodes.messages = el('div', 'messages'); nodes.messages.setAttribute('role', 'log'); nodes.messages.setAttribute('aria-label', '猫娘对话记录'); nodes.messages.setAttribute('aria-live', 'polite'); nodes.messages.setAttribute('aria-relevant', 'additions'); nodes.messages.tabIndex = 0;
    nodes.footer = el('p', 'chat-footer muted');
    conversation.append(chatHeader, nodes.messages, nodes.footer); layout.append(sidebar, conversation); root.append(header, nodes.alert, layout);
    function displayDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    function list(node, items, make, empty) { node.replaceChildren(); if (!items.length) node.append(el('p', 'empty muted', empty)); else items.forEach(item => node.append(make(item))); }
    function renderMessages(session) {
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      const atBottom = nodes.messages.scrollHeight - nodes.messages.scrollTop - nodes.messages.clientHeight < 80;
      // Keep existing bubbles when streaming state changes without a new message.
      const key = JSON.stringify([selectedHistory, session?.visitId, messages]);
      if (nodes.messages._renderKey === key) return;
      nodes.messages._renderKey = key;
      list(nodes.messages, messages, message => {
        const bubble = el('article', message.role === 'host' ? 'message host' : 'message guest');
        bubble.append(el('p', 'speaker', message.role === 'host' ? '主人家的猫娘' : '来串门的猫娘'), el('p', 'message-text', message.text || '')); return bubble;
      }, selectedHistory ? '这次串门没有留下对话。' : state.session ? '连接就绪后，两只猫娘会开始聊天。' : '选择一位在线好友，发出第一份邀请。');
      if (atBottom) nodes.messages.scrollTop = nodes.messages.scrollHeight;
    }
    function render() {
      if (disposed) return;
      const signedIn = Boolean(state.account?.signedIn), locked = pending > 0 || Boolean(state.busy), active = state.session && !finished.has(state.session.phase);
      nodes.account.textContent = signedIn ? state.account.displayName || '已登录社区' : '登录后与互关好友串门';
      nodes.login.hidden = signedIn; nodes.logout.hidden = !signedIn; nodes.login.disabled = locked; nodes.logout.disabled = Boolean(active);
      nodes.save.disabled = locked || Boolean(active); nodes.name.disabled = Boolean(active); nodes.description.disabled = Boolean(active); nodes.refresh.disabled = locked || !signedIn;
      if (!dirty) { nodes.name.value = state.persona?.name || ''; nodes.description.value = state.persona?.description || ''; }
      nodes.alert.textContent = localError || (state.error ? errorText(state.error) : ''); nodes.alert.hidden = !nodes.alert.textContent;
      list(nodes.friends, Array.isArray(state.friends) ? state.friends : [], friend => {
        const row = el('div', 'person-row'), text = el('div'); text.append(el('strong', '', friend.displayName || '好友'), el('p', 'muted', friend.available ? '社区在线 · 可邀请' : friend.online ? '社区在线 · 暂不可邀请' : '离线'));
        const invite = button('邀请', () => request('invite', { userId: friend.id }), 'small'); invite.disabled = locked || !signedIn || Boolean(active) || !friend.available; invite.setAttribute('aria-label', `邀请 ${friend.displayName || '好友'} 串门`); row.append(text, invite); return row;
      }, signedIn ? '暂无互关好友，可以先去社区认识彼此。' : '登录后显示互关好友。');
      list(nodes.invitations, Array.isArray(state.invitations) ? state.invitations : [], invite => {
        const row = el('div', 'invitation'), expiry = new Date(invite.expiresAt).getTime(), expired = Number.isFinite(expiry) && expiry <= Date.now();
        row.append(el('strong', '', `${invite.displayName || '好友'} 邀请你串门`), el('p', 'muted', expired ? '邀请已过期' : invite.expiresAt ? `有效至 ${displayDate(invite.expiresAt)}` : '等待你的决定'));
        const buttons = el('div', 'controls'), accept = button('接受', () => { selectedHistory = null; historyResult = null; request('accept', { notificationId: invite.notificationId }); }, 'primary small'), decline = button('暂不方便', () => request('decline', { notificationId: invite.notificationId }), 'small');
        accept.disabled = locked || !signedIn || Boolean(active) || expired; decline.disabled = locked || !signedIn || expired; buttons.append(accept, decline); row.append(buttons); return row;
      }, '还没有待处理的邀请。');
      list(nodes.history, Array.isArray(state.history) ? state.history : [], item => {
        const open = button(displayDate(item.startedAt), () => request('history', { visitId: item.visitId }), 'history-link'); open.disabled = locked; open.setAttribute('aria-pressed', String(selectedHistory === item.visitId)); return open;
      }, '聊过的时光会保存在这里。');
      nodes.live.hidden = !selectedHistory; nodes.stop.hidden = !active; nodes.stop.disabled = state.session?.phase === 'stopping';
      const session = selectedHistory ? historyResult : state.session;
      nodes.chatTitle.textContent = selectedHistory ? '串门回忆' : active ? '两只猫娘的聊天时间' : state.session ? '这次串门已结束' : '等一位好友来坐坐';
      nodes.phase.textContent = selectedHistory ? displayDate(session?.startedAt) : (phases[session?.phase] || '等待串门');
      nodes.footer.textContent = !selectedHistory && session?.generating ? '猫娘正在想怎么回答…' : reasons[session?.reason] || '纯文本交流 · 双方各自回复 · 随时可以结束';
      renderMessages(session);
    }
    function accountKey(value) { return value?.account?.signedIn ? `signed-in:${value.account.id ?? value.account.userId ?? ''}` : 'signed-out'; }
    function clearAccountCache() {
      accountEpoch++; pending = 0; selectedHistory = null; historyResult = null; dirty = false; localError = '';
      nodes.name.value = ''; nodes.description.value = ''; nodes.messages._renderKey = null; nodes.messages.replaceChildren();
    }
    function adopt(value) {
      const next = value?.state || value;
      if (next && typeof next === 'object' && ('account' in next || 'session' in next || 'friends' in next)) {
        if (accountKey(next) !== accountKey(state)) clearAccountCache();
        const nextError = typeof next.error === 'string' ? next.error : next.error?.code;
        const previousError = typeof state.error === 'string' ? state.error : state.error?.code;
        if (nextError !== previousError) stateErrorVersion++;
        state = next;
      }
    }
    async function request(action, payload = {}) {
      if (disposed || (pending && action !== 'stop' && action !== 'logout')) return false;
      if (action === 'logout') { clearAccountCache(); state = { account: { signedIn: false }, persona: {}, friends: [], invitations: [], history: [], session: null }; }
      const epoch = accountEpoch, errorVersion = stateErrorVersion;
      pending++; localError = ''; render();
      try {
        const result = await bridge.call(action, payload);
        if (result?.ok === false) throw Object.assign(new Error('Request failed'), { code: result.error?.code || result.error || result.code });
        if (disposed || epoch !== accountEpoch) return false;
        if (action === 'history') { selectedHistory = payload.visitId; historyResult = result?.history || result?.record || result; }
        else { if (action === 'invite') { selectedHistory = null; historyResult = null; } adopt(result); }
        return true;
      } catch (error) {
        if (!disposed && epoch === accountEpoch) {
          const stateCode = typeof state.error === 'string' ? state.error : state.error?.code;
          const currentStateError = stateErrorVersion > errorVersion && errors[stateCode];
          localError = currentStateError || (error?.code && errors[error.code] ? errorText(error) : action === 'login' ? '登录未完成，请重试。' : '操作未完成，请稍后重试或刷新。');
        }
        return false;
      }
      finally { if (epoch === accountEpoch) pending--; render(); }
    }
    const unsubscribe = bridge.subscribe(value => { if (!disposed) { adopt(value); render(); } });
    const dispose = () => { disposed = true; if (typeof unsubscribe === 'function') unsubscribe(); win.removeEventListener('beforeunload', dispose); };
    win.addEventListener('beforeunload', dispose); render(); const ready = request('getState');
    return { ready, dispose, nodes };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createPanel };
  else if (scope.nekoVisits) createPanel({ document: scope.document, window: scope, bridge: scope.nekoVisits });
  else scope.document.getElementById('visits-root').textContent = '串门窗口未能连接，请关闭后重新打开。';
})(typeof window !== 'undefined' ? window : globalThis);
