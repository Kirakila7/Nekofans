'use strict';

const CHANNELS = ['fish', 'qqbot'];
const DEFAULT_SELECTION = { fish: true, qqbot: false };

function selectionFrom(value, previous = DEFAULT_SELECTION) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(CHANNELS.map(name => [name,
    typeof source[name] === 'boolean' ? source[name] : previous[name],
  ]));
}

/**
 * Coordinate the user's selected channels without coupling their prerequisites.
 *
 * Actions must implement immediate cancellation when called with "pause", even
 * while their own "start" promise is pending. Generation checks here protect
 * presentation; the channel's cancellation protects its actual runtime.
 *
 * getSelection is synchronous; saveSelection may return a promise. Selection is
 * persisted separately from runtime state and never implies automatic startup.
 * Channel status objects retain their contract: QQ enabled/loaded is not proof
 * of binding, gateway connection, or successful message delivery.
 */
function createCoordinator({ fishAction, qqbotAction, getSelection = () => DEFAULT_SELECTION,
  saveSelection = () => {}, notify = () => {} }) {
  const actions = { fish: fishAction, qqbot: qqbotAction };
  for (const name of CHANNELS) {
    if (typeof actions[name] !== 'function') throw new TypeError(`Missing ${name} action`);
  }
  let generation = 0;
  let pendingStart = null;
  let pendingPause = null;
  let selectionTail = Promise.resolve();
  const channelVersions = { fish: 0, qqbot: 0 };
  const channelIntents = { fish: 0, qqbot: 0 };
  const channelStarts = { fish: null, qqbot: null };
  const channelStops = { fish: null, qqbot: null };
  let state = {
    fish: { enabled: false, phase: 'paused', reason: '已暂停' },
    qqbot: { enabled: false, phase: 'paused', reason: 'QQ 机器人未启动。' },
    selection: selectionFrom(getSelection()),
    unified: false,
    overall: 'idle',
  };

  function snapshot() {
    return { ...state, fish: { ...state.fish }, qqbot: { ...state.qqbot }, selection: { ...state.selection } };
  }

  function publish(patch) {
    state = { ...state, ...patch };
    // A disconnected renderer must not prevent cancellation or leave a busy flag.
    try { void Promise.resolve(notify(snapshot())).catch(() => {}); } catch {}
    return snapshot();
  }

  function updateChannel(name, value) {
    if (!CHANNELS.includes(name)) throw new Error('Unknown coordinator channel');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid channel status');
    channelVersions[name]++;
    return publish({ [name]: { ...value } });
  }

  function unavailable(name) {
    return { enabled: false, phase: 'error', reason: name === 'fish'
      ? '养鱼状态未能更新，请检查工作台连接后重试。'
      : 'QQ 状态未能更新，请检查工作台连接后重试。' };
  }

  function call(name, action) {
    // Invoke synchronously so pause reaches the channel before any awaited work.
    try {
      return Promise.resolve(actions[name](action)).then(value =>
        value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : unavailable(name),
      () => unavailable(name));
    } catch { return Promise.resolve(unavailable(name)); }
  }

  function stopChannel(name) {
    if (channelStops[name]) return channelStops[name];
    const work = call(name, 'pause');
    channelStops[name] = work;
    void work.then(() => { if (channelStops[name] === work) channelStops[name] = null; });
    return work;
  }

  function startChannel(name) {
    const intent = channelIntents[name];
    if (channelStarts[name]?.intent === intent) return channelStarts[name].promise;
    const operation = { intent, promise: call(name, 'start') };
    channelStarts[name] = operation;
    void operation.promise.then(() => { if (channelStarts[name] === operation) channelStarts[name] = null; });
    return operation.promise;
  }

  function start() {
    if (pendingStart?.revision === generation
      && CHANNELS.every(name => pendingStart.selected[name] === state.selection[name]
        && (!state.selection[name] || pendingStart.intents[name] === channelIntents[name]))) return pendingStart.promise;
    const revision = ++generation;
    const selected = { ...state.selection };
    const intents = { ...channelIntents };
    publish({ unified: true, overall: 'starting' });
    const operation = { revision, selected, intents, promise: null };
    pendingStart = operation;
    operation.promise = Promise.resolve().then(async () => {
      await Promise.all(CHANNELS.filter(name => selected[name]).map(async name => {
        // A new start waits for an older pause, while pause never waits for start.
        if (channelStops[name]) await channelStops[name];
        if (revision !== generation || intents[name] !== channelIntents[name] || !state.selection[name]) return;
        const version = channelVersions[name];
        const value = await startChannel(name);
        if (revision === generation && intents[name] === channelIntents[name]
          && state.selection[name] && version === channelVersions[name]) updateChannel(name, value);
      }));
      if (revision === generation) publish({ unified: false, overall: 'idle' });
      return snapshot();
    }).finally(() => { if (pendingStart === operation) pendingStart = null; });
    return operation.promise;
  }

  function pause() {
    if (pendingPause?.revision === generation) return pendingPause.promise;
    const revision = ++generation;
    for (const name of CHANNELS) channelIntents[name]++;
    publish({ unified: true, overall: 'pausing' });
    const operation = { revision, promise: null };
    pendingPause = operation;
    const stops = CHANNELS.map(async name => {
      const version = channelVersions[name];
      const value = await stopChannel(name);
      if (revision === generation && version === channelVersions[name]) updateChannel(name, value);
    });
    operation.promise = Promise.all(stops).then(() => {
      if (revision === generation) {
        publish({ unified: false, overall: 'idle' });
      }
      return snapshot();
    }).finally(() => { if (pendingPause === operation) pendingPause = null; });
    return operation.promise;
  }

  async function status() {
    const revision = generation;
    const versions = { ...channelVersions };
    const intents = { ...channelIntents };
    const values = await Promise.all(CHANNELS.map(name => call(name, 'status')));
    const result = snapshot();
    CHANNELS.forEach((name, index) => {
      if (revision === generation && versions[name] === channelVersions[name]
        && intents[name] === channelIntents[name]) result[name] = values[index];
    });
    // Reading never broadcasts or writes cached state; a slow poll cannot roll
    // back a newer channel notification or the result of start/pause.
    return result;
  }

  function setSelection(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || CHANNELS.some(name => name in value && typeof value[name] !== 'boolean')) {
      return Promise.reject(new TypeError('Invalid channel selection'));
    }
    const requested = { ...value };
    const work = selectionTail.then(async () => {
      const next = selectionFrom(requested, state.selection);
      const deselected = CHANNELS.filter(name => state.selection[name] && !next[name]);
      if (CHANNELS.every(name => state.selection[name] === next[name])) return snapshot();
      await saveSelection({ ...next });
      // Saving must succeed before changing the user's active selection.
      for (const name of deselected) channelIntents[name]++;
      publish({ selection: next });
      await Promise.all(deselected.map(async name => {
        const intent = channelIntents[name];
        const version = channelVersions[name];
        const result = await stopChannel(name);
        if (intent === channelIntents[name] && !state.selection[name]
          && version === channelVersions[name]) updateChannel(name, result);
      }));
      return snapshot();
    });
    selectionTail = work.catch(() => {});
    return work;
  }

  return { start, pause, status, snapshot, setSelection, updateChannel };
}

module.exports = { createCoordinator };
