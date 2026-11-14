(() => {
  const channel = location.hash.slice(1);
  let options, current, context, lastAgentView, lastVersion = -1;
  const clone = value => JSON.parse(JSON.stringify(value));
  function emit(type, data = {}) { parent.postMessage({ nekofans: 1, channel, type, ...data }, '*'); }
  function submit(action, endTurn, agentRequestId) {
    emit('action', { action: clone(action), endTurn, ...(agentRequestId ? { agentRequestId } : {}) });
  }
  function agentView() {
    if (!options.agent || !context) return null;
    const { observe, legalActions } = options.agent;
    const actions = context.isMyTurn ? legalActions(clone(current), clone(context)) : [];
    if (!Array.isArray(actions) || actions.length > 128) throw new Error('Agent 动作列表无效');
    const choices = actions.map((choice, id) => {
      const action = choice?.action;
      if (!action || typeof action !== 'object' || Array.isArray(action) || new TextEncoder().encode(JSON.stringify(action)).length > 4096) throw new Error('Agent 动作无效');
      return { id, label: String(choice.label || action.type || '').slice(0, 100), action: clone(action), endTurn: choice.endTurn !== false };
    });
    const observation = clone(observe(clone(current), clone(context)));
    if (new TextEncoder().encode(JSON.stringify(observation)).length > 8192) throw new Error('Agent 状态过大');
    return { version: context.version, player: context.player, observation, choices };
  }
  function handleAgent(message) {
    const { requestId } = message;
    if (typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId)) return;
    const reply = data => emit('agent-result', { requestId, ...data });
    try {
      if (!options.agent) return reply({ status: 'unsupported' });
      if (!context) return reply({ status: 'not-ready' });
      if (message.type === 'agent-view') {
        const view = agentView();
        lastAgentView = { id: requestId, view };
        return reply({ status: 'ready', ...view });
      }
      if (!lastAgentView || message.viewId !== lastAgentView.id || message.version !== context.version || lastAgentView.view.version !== context.version) return reply({ status: 'stale' });
      if (!context.isMyTurn) return reply({ status: 'not-ready' });
      const choice = Number.isInteger(message.choiceId) ? lastAgentView.view.choices[message.choiceId] : undefined;
      if (!choice || !agentView().choices.some(current => JSON.stringify(current.action) === JSON.stringify(choice.action) && current.endTurn === choice.endTurn)) return reply({ status: 'invalid-choice' });
      lastAgentView = undefined;
      submit(choice.action, choice.endTurn, requestId);
      reply({ status: 'submitted' });
    } catch { reply({ status: 'invalid-project' }); }
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.nekofans !== 1 || event.data.channel !== channel || !options) return;
    const message = event.data;
    if (message.type === 'error') { options.onError?.(message.error); return; }
    if (message.type === 'agent-view' || message.type === 'agent-action') return handleAgent(message);
    if (message.type !== 'snapshot') return;
    const room = message.state;
    try {
      if (lastVersion !== room.version) {
        current = clone(options.initialState);
        for (const entry of room.events) {
          const next = options.reducer(clone(current), clone(entry.action), { player: entry.player, seq: entry.seq, seed: room.seed });
          if (next === undefined || next?.then) throw new Error('reducer 必须同步返回 JSON 状态');
          current = clone(next);
        }
        lastVersion = room.version;
      }
      const next = { player: message.player, players: room.players, online: room.online, turn: room.turn, version: room.version, seed: room.seed, mode: room.game.mode, connected: message.connected, ready: room.players.length === 2 && message.connected, isMyTurn: room.players.length === 2 && message.connected && (room.game.mode === 'shared' || room.turn === message.player), agentActive: message.agentActive === true };
      if (lastAgentView && (next.version !== context.version || next.player !== context.player || next.connected !== context.connected ||
          next.isMyTurn !== context.isMyTurn || JSON.stringify(next.online) !== JSON.stringify(context.online))) lastAgentView = undefined;
      context = next;
      options.onChange(clone(current), clone(context));
    } catch (error) { emit('game-error', { error: error.message }); options.onError?.(error.message); }
  });
  window.NekofansGame = Object.freeze({
    connect(config) {
      if (options) throw new Error('只能连接一次');
      if (typeof config.reducer !== 'function' || typeof config.onChange !== 'function') throw new Error('请提供 reducer 和 onChange');
      if (config.agent && (typeof config.agent.observe !== 'function' || typeof config.agent.legalActions !== 'function')) throw new Error('请提供 Agent 状态与动作函数');
      options = config; current = clone(config.initialState); emit('ready', config.agent ? { agent: true } : {});
      return Object.freeze({
        submit(action, settings = {}) {
          if (context?.agentActive) return;
          if (!context?.isMyTurn) { config.onError?.('请等待另一位玩家或等待你的回合'); return; }
          submit(action, settings.endTurn !== false);
        },
        getState() { return clone(current); },
        getContext() { return context ? clone(context) : null; }
      });
    }
  });
})();
