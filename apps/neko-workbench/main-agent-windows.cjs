'use strict';

const preferences = require('./main-agent-preferences.cjs');

function createMainAgentWindows({
  BrowserWindow, screen, options, loadLocalFile, getPet, getState, appearance,
  update, save, publish, actions, isQuitting, reduceMotion,
}) {
  let settingsWindow;
  let guideWindow;
  let roamOrigin;
  let hidden = false;

  const prefs = () => getState().preferences.mainAgent;
  const main = () => getState().actors.find(actor => actor.id === 'main');
  const labelFor = id => preferences.shortcuts[id][0];

  function snapshot() {
    const state = getState();
    const actor = main();
    const custom = appearance.validCustom(actor.customAppearance) ? actor.customAppearance : null;
    return {
      prefs: prefs(),
      models: appearance.choices.map(({id, label}) => ({
        id, label, source: id === appearance.ORIGINAL ? 'assets/idle.webm'
          : appearance.sourceFor(id, actor, {reduced: true}),
      })),
      appearanceId: actor.appearanceId || '',
      activeModel: appearance.selected(state, actor),
      custom: custom ? {label: custom.name, source: custom.stillDataUrl || custom.dataUrl} : null,
      scale: appearance.scaleFor(state, actor),
      followsDefaultSize: !Number.isFinite(actor.appearanceScale),
      chatConfigured: state.mainChat?.backend === 'chat-api' && state.mainChat.hasKey === true
        && !!state.mainChat.settings?.baseUrl && !!state.mainChat.settings?.model,
      chatBackend: state.mainChat?.backend ?? null,
    };
  }

  function notify() {
    const value = snapshot();
    for (const window of [settingsWindow, guideWindow]) {
      if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
        window.webContents.send('main-agent:state', value);
      }
    }
    return value;
  }

  function edit(key, value) {
    if (!['name', 'personality', 'roam', 'single', 'double', 'response', 'gestures',
      'shortcuts', 'compactMenu', 'mirror', 'muted'].includes(key)) throw Error('未知设置项');
    const state = getState();
    const previous = prefs();
    state.preferences.mainAgent = preferences.normalize({...previous, [key]: value});
    if (key === 'roam') planRoam();
    try { update(); }
    catch (error) {
      state.preferences.mainAgent = previous;
      if (key === 'roam') planRoam();
      throw error;
    }
  }

  function positionGuide() {
    const pet = getPet();
    if (!pet || pet.isDestroyed() || !guideWindow || guideWindow.isDestroyed()) return;
    const bounds = pet.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(368, area.width);
    const height = Math.min(310, area.height);
    const x = Math.min(area.x + area.width - width, Math.max(area.x, bounds.x + Math.round((bounds.width - width) / 2)));
    const above = bounds.y + Math.round(Math.min(67, bounds.height / 4)) - height;
    const left = bounds.x - width - 5;
    const right = bounds.x + bounds.width + 5;
    const side = above < area.y && (left >= area.x || right + width <= area.x);
    guideWindow.setBounds({
      x: side ? (left >= area.x ? left : right) : x,
      y: side ? Math.min(area.y + area.height - height, Math.max(area.y, bounds.y)) : Math.max(area.y, above),
      width, height,
    });
  }

  function saveGuide(status, step = prefs().guide.step) {
    const previous = prefs().guide;
    prefs().guide = {status, step};
    try { save(); }
    catch (error) {
      prefs().guide = previous;
      throw error;
    }
    publish();
  }

  function openGuide({restart = false} = {}) {
    const pet = getPet();
    if (!pet || pet.isDestroyed()) return;
    showPet();
    if (restart || prefs().guide.status === 'finished') saveGuide('pending', 0);
    else saveGuide('pending');
    if (guideWindow && !guideWindow.isDestroyed()) {
      positionGuide();
      guideWindow.showInactive();
      notify();
      return;
    }
    const window = new BrowserWindow({
      ...options(), width: 368, height: 310, title: '大肥鱼的新手引导',
      transparent: true, frame: false, resizable: false, hasShadow: false,
      skipTaskbar: true, fullscreenable: false, alwaysOnTop: true,
    });
    guideWindow = window;
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
    positionGuide();
    pet.on('move', positionGuide);
    pet.on('resize', positionGuide);
    window.once('closed', () => {
      guideWindow = null;
      pet.removeListener('move', positionGuide);
      pet.removeListener('resize', positionGuide);
      if (!isQuitting() && prefs().guide.status === 'pending') {
        try { saveGuide('paused'); }
        catch (error) { actions.onError(error); }
      }
    });
    window.webContents.once('did-finish-load', () => window.webContents.send('main-agent:state', snapshot()));
    void loadLocalFile(window, {view: 'main-agent-guide'}).then(() => {
      if (!window.isDestroyed() && pet.isVisible()) window.showInactive();
    }).catch(error => {
      if (!window.isDestroyed()) window.destroy();
      actions.onError(error);
    });
  }

  function openSettings(tab = 'persona') {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      settingsWindow.webContents.send('main-agent:tab', tab);
      return;
    }
    const window = new BrowserWindow({
      ...options(), width: 960, height: 680, minWidth: 510, minHeight: 480,
      title: '主 Agent 设置', backgroundColor: '#eaf1f6',
    });
    settingsWindow = window;
    window.once('closed', () => { settingsWindow = null; });
    window.webContents.once('did-finish-load', () => window.webContents.send('main-agent:state', snapshot()));
    void loadLocalFile(window, {view: 'main-agent-settings', tab}).then(() => {
      if (!window.isDestroyed()) window.show();
    }).catch(error => {
      if (!window.isDestroyed()) window.destroy();
      actions.onError(error);
    });
  }

  async function openWorkbench() {
    const practice = guideWindow && !guideWindow.isDestroyed()
      && preferences.guideSteps[prefs().guide.step] === 'workbench';
    await actions.workbench();
    if (practice && guideWindow && !guideWindow.isDestroyed()
        && preferences.guideSteps[prefs().guide.step] === 'workbench') {
      saveGuide('pending', prefs().guide.step + 1);
      notify();
    }
  }

  const runShortcut = {
    chat: actions.chat,
    dress: () => openSettings('appearance'),
    workbench: openWorkbench,
    memory: actions.memory,
    visits: actions.visits,
    sound: () => edit('muted', !prefs().muted),
    size: () => openSettings('appearance'),
    hide: () => {
      hidden = true;
      guideWindow?.close();
      getPet()?.hide();
    },
  };

  function showPet() {
    hidden = false;
    const pet = getPet();
    if (pet && !pet.isDestroyed() && !pet.webContents.isLoading()) pet.showInactive();
  }

  function compactItems() {
    return prefs().shortcuts.map(id => ({
      label: id === 'sound' ? (prefs().muted ? '开启音效' : '静音') : labelFor(id),
      click: () => Promise.resolve().then(runShortcut[id]).catch(actions.onError),
    }));
  }

  async function call(sender, method, payload = {}) {
    if (!sender || !payload || typeof payload !== 'object') throw Error('无效的桌宠请求');
    const fromSettings = sender === settingsWindow;
    const fromGuide = sender === guideWindow;
    const fromPet = sender === getPet();
    if (fromPet && method === 'shortcut' && prefs().shortcuts.includes(payload.id)) {
      await runShortcut[payload.id]();
      return true;
    }
    if (!fromSettings && !fromGuide) throw Error('请从主 Agent 的设置或引导操作');
    if (method === 'read') return snapshot();
    if (method === 'edit') {
      const guideFields = {name: ['name'], personality: ['personality'], roaming: ['roam'],
        responses: ['response', 'gestures'], shortcuts: ['shortcuts']};
      if (fromGuide && !guideFields[preferences.guideSteps[prefs().guide.step]]?.includes(payload.key)) throw Error('这一步不能修改此设置');
      edit(payload.key, payload.value);
    } else if (method === 'appearance' && fromSettings) {
      if (!appearance.setActor(main(), payload.id || null)) throw Error('该形象不可用');
      update();
    } else if (method === 'size' && fromSettings) {
      if (!appearance.setScale(main(), payload.scale)) throw Error('形象大小不在允许范围内');
      update();
    } else if (method === 'import' && fromSettings) {
      await actions.import(main(), sender);
    } else if (method === 'chat-settings') {
      actions.chatSettings();
    } else if (method === 'guide-open' && fromSettings) {
      sender.hide();
      openGuide({restart: payload.restart === true});
    } else if (method === 'workbench' && fromGuide) {
      await openWorkbench();
    } else if (method === 'guide-next' && fromGuide) {
      const {step} = prefs().guide;
      if (payload.step !== step) return snapshot();
      if (preferences.guideSteps[step] === 'done') {
        saveGuide('finished');
        sender.close();
      } else saveGuide('pending', step + 1);
    } else if (method === 'guide-back' && fromGuide) {
      saveGuide('pending', Math.max(0, prefs().guide.step - 1));
    } else if (method === 'close') {
      sender.close();
    } else throw Error('未知桌宠操作');
    return notify();
  }

  let roamTimer;
  function planRoam() {
    clearTimeout(roamTimer);
    const delay = {occasional: 90000, often: 30000}[prefs().roam];
    if (!delay || isQuitting()) return;
    roamTimer = setTimeout(() => {
      roamTimer = undefined;
      const pet = getPet();
      if (pet && !pet.isDestroyed() && pet.isVisible() && !guideWindow && !reduceMotion() && actions.canRoam()) {
        const bounds = pet.getBounds();
        const cursor = screen.getCursorScreenPoint();
        const near = cursor.x >= bounds.x - 35 && cursor.x <= bounds.x + bounds.width + 35
          && cursor.y >= bounds.y - 35 && cursor.y <= bounds.y + bounds.height + 35;
        if (!near) {
          const area = screen.getDisplayMatching(bounds).workArea;
          if (!roamOrigin || roamOrigin.y !== bounds.y || Math.abs(bounds.x - roamOrigin.lastX) > 2) {
            roamOrigin = {x: bounds.x, y: bounds.y, lastX: bounds.x};
          }
          const step = bounds.x >= roamOrigin.x ? -24 : 24;
          const x = Math.max(area.x, Math.min(area.x + area.width - bounds.width, bounds.x + step));
          pet.setPosition(x, bounds.y);
          roamOrigin.lastX = x;
        }
      }
      planRoam();
    }, delay);
  }

  return {
    call, openGuide, openSettings, compactItems, openWorkbench, planRoam, showPet,
    isHidden: () => hidden,
    dispose: () => clearTimeout(roamTimer),
  };
}

module.exports = {createMainAgentWindows};
