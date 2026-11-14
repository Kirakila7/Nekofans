export function createRoomAgent({ button, settings, options, model, teammate, refresh, modelStatus, post, readRoom, submit, onControl, notify }) {
  let enabled = false;
  let supported = false;
  let session;
  let request;
  let running = false;
  let timer;
  let lastAction = 0;
  let idle = false;
  let catalogRequest;
  let catalogSeat;
  let lastCatalog;
  let selectedModel;

  function setOptionsOpen(open) {
    options.hidden = !open;
    settings.setAttribute('aria-expanded', String(open));
  }

  function render() {
    const room = readRoom();
    button.hidden = !enabled || !supported || !room?.account || room.phase !== 'playing';
    button.disabled = !session && !room?.connected;
    settings.hidden = button.hidden;
    settings.disabled = !room?.connected || Boolean(session);
    model.disabled = teammate.disabled = Boolean(session);
    button.textContent = session ? '接回操作' : `${teammate.selectedOptions[0]?.textContent || '大肥鱼'}接手`;
    button.setAttribute('aria-pressed', String(Boolean(session)));
  }

  async function loadOptions(force = false) {
    const room = readRoom();
    if (!room?.connected) return null;
    if (catalogRequest) return catalogRequest;
    if (!force && catalogSeat === room.token) return lastCatalog;
    refresh.disabled = true;
    modelStatus.textContent = '正在检测模型…';
    const token = room.token;
    catalogRequest = (async () => {
      try {
        const response = await fetch(`/api/rooms/${room.id}/agent-options`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw Error('无法读取队友设置');
        const catalog = await response.json();
        if (readRoom()?.token !== token || !readRoom()?.connected) return null;
        const previous = selectedModel;
        const previousTeammate = teammate.value;
        model.replaceChildren(...catalog.models.map(item => new Option(item.label, item.id)));
        teammate.replaceChildren(...catalog.teammates.map(item => new Option(item.label, item.id)));
        const keepsModel = catalog.models.some(item => item.id === previous);
        if (keepsModel) model.value = previous;
        else if (previous) {
          const placeholder = new Option('选择模型', '', true, true);
          placeholder.disabled = true;
          model.prepend(placeholder);
          model.value = '';
        } else {
          if (catalog.preferredModel) model.value = catalog.preferredModel;
          selectedModel = model.value;
        }
        if (catalog.teammates.some(item => item.id === previousTeammate)) teammate.value = previousTeammate;
        modelStatus.textContent = previous && !keepsModel ? '原模型已不可用，请重新选择' : catalog.ollama === 'offline' ? '未检测到本机 Ollama' :
          catalog.ollama === 'online' && !catalog.models.some(item => item.id.startsWith('ollama:')) ? 'Ollama 暂无本地模型' : '';
        catalogSeat = token;
        lastCatalog = catalog;
        render();
        return catalog;
      } catch {
        modelStatus.textContent = '模型列表读取失败';
        return null;
      } finally {
        refresh.disabled = false;
        catalogRequest = undefined;
      }
    })();
    return catalogRequest;
  }

  function stop(message) {
    session?.abort();
    session = undefined;
    clearTimeout(timer);
    timer = undefined;
    idle = false;
    setOptionsOpen(false);
    render();
    onControl();
    if (message) notify(message);
  }

  function wake() {
    render();
    const room = readRoom();
    if (!session || running || timer || idle || !room?.canPlay) return;
    timer = setTimeout(() => {
      timer = undefined;
      void act(session);
    }, Math.max(60, lastAction + 900 - Date.now()));
  }

  async function act(owner) {
    const room = readRoom();
    if (!owner || owner.signal.aborted || !room?.canPlay) return;
    running = true;
    const current = () => !owner.signal.aborted && readRoom()?.canPlay && readRoom()?.version === room.version;
    const askFrame = (type, data, isAction = false) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const abort = () => finish(null, new Error('操作已取消'));
      const timeout = setTimeout(() => finish(null, new Error('游戏未响应')), 2500);
      function finish(value, error) {
        clearTimeout(timeout);
        owner.signal.removeEventListener('abort', abort);
        if (request?.id === id) request = undefined;
        if (error) reject(error);
        else resolve(value);
      }
      request = { id, finish, isAction, version: room.version, sent: false };
      owner.signal.addEventListener('abort', abort, { once: true });
      post(type, { requestId: id, ...data });
    });
    try {
      const view = await askFrame('agent-view');
      if (!current()) return;
      if (view.status !== 'ready' || view.version !== room.version || view.player !== room.player || !Array.isArray(view.choices) || view.choices.length > 128) throw Error('游戏没有提供可用的 Agent 状态');
      if (!view.choices.length) {
        if (view.observation?.finished === true) stop();
        else idle = true;
        return;
      }
      const response = await fetch(`/api/rooms/${room.id}/agent-choice`, {
        method: 'POST', signal: owner.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.token}` },
        body: JSON.stringify({ version: view.version, observation: view.observation, choices: view.choices.map(({ id, label }) => ({ id, label })),
          model: owner.model, teammate: owner.teammate }),
      });
      if (!current()) return;
      if (response.status === 409) { idle = true; return; }
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '大肥鱼暂时无法操作');
      if (!current()) return;
      if (!view.choices.some(choice => choice.id === result.choiceId)) throw Error('大肥鱼未选出合法动作');
      const action = await askFrame('agent-action', { viewId: view.requestId, version: view.version, choiceId: result.choiceId }, true);
      if (action.status === 'stale' || action.status === 'not-ready') return;
      if (action.status !== 'submitted' || !action.sent) throw Error('游戏拒绝了大肥鱼的操作');
    } catch (error) {
      if (!owner.signal.aborted) stop(error.message);
    } finally {
      running = false;
      wake();
    }
  }

  settings.onclick = () => {
    setOptionsOpen(options.hidden);
    if (!options.hidden) void loadOptions(true);
  };
  refresh.onclick = () => void loadOptions(true);
  model.onchange = () => { selectedModel = model.value; };
  teammate.onchange = render;
  button.onclick = async () => {
    if (session) return stop();
    if (button.hidden || button.disabled) return;
    const room = readRoom();
    const catalog = await loadOptions();
    if (!catalog) { notify('无法读取模型，请打开队友设置后刷新'); return; }
    if (session || readRoom()?.token !== room.token || !readRoom()?.connected) return;
    if (!model.value || !teammate.value) { setOptionsOpen(true); return; }
    session = new AbortController();
    session.model = model.value;
    session.teammate = teammate.value;
    setOptionsOpen(false);
    onControl();
    wake();
  };
  return {
    get active() { return Boolean(session); },
    configure(value) { enabled = value; render(); },
    ready(value) { supported = value; wake(); },
    stop, wake,
    updated() { idle = false; wake(); },
    result(message) {
      if (request?.id === message.requestId) request.finish({ ...message, sent: request.sent });
    },
    action(message) {
      const room = readRoom();
      if (!session || !request?.isAction || request.sent || message.agentRequestId !== request.id ||
          !room?.canPlay || request.version !== room.version) return;
      request.sent = submit(message);
      if (request.sent) lastAction = Date.now();
    },
  };
}
