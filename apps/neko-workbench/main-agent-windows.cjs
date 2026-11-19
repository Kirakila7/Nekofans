'use strict';

const preferences = require('./main-agent-preferences.cjs');

function createMainAgentWindows({
  BrowserWindow, screen, options, loadLocalFile, getPet, getState, appearance,
  update, save, publish, actions, isQuitting, reduceMotion,
}) {
  let settingsWindow;
  let guideWindow;
  let menuWindow;
  let roamOrigin;
  let hidden = false;

  const prefs = () => getState().preferences.mainAgent;
  const main = () => getState().actors.find(actor => actor.id === 'main');
  const labelFor = id => preferences.shortcuts[id][0];

  function menuModel() {
    const {shortcuts, compactMenu, muted, guide} = prefs();
    const ids = compactMenu ? shortcuts : [...new Set([...shortcuts, 'chat', 'workbench', 'dress'])];
    return {items: ids.map(id => ({
      id, label: id === 'sound' ? (muted ? '开启音效' : '静音') : labelFor(id),
    })), canContinue: guide.status !== 'finished'};
  }

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
      menu: menuModel(),
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
      planRoam();
    });
    window.webContents.once('did-finish-load', () => window.webContents.send('main-agent:state', snapshot()));
    void loadLocalFile(window, {view: 'main-agent-guide'}).then(() => {
      if (!window.isDestroyed() && pet.isVisible()) window.showInactive();
    }).catch(error => {
      if (!window.isDestroyed()) window.destroy();
      actions.onError(error);
    });
  }

  function openMenu({keyboard = false} = {}) {
    const pet = getPet();
    if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
    if (menuWindow && !menuWindow.isDestroyed()) {
      if (!menuWindow.webContents.isLoading()) menuWindow.focus();
      return;
    }
    const bounds = pet.getBounds();
    const point = keyboard ? {x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2)}
      : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(point).workArea;
    const width = Math.min(300, area.width);
    const height = Math.min(116 + Math.ceil(menuModel().items.length / 3) * 64, area.height);
    const below = point.y + 8;
    const x = Math.max(area.x, Math.min(point.x - 12, area.x + area.width - width));
    const bottom = area.y + area.height - height;
    const y = Math.max(area.y, Math.min(bottom, below <= bottom ? below : point.y - height - 8));
    const window = new BrowserWindow({
      ...options(), x, y, width, height, title: '大肥鱼的快捷菜单',
      transparent: true, frame: false, resizable: false, hasShadow: false,
      skipTaskbar: true, fullscreenable: false, alwaysOnTop: true,
    });
    menuWindow = window;
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
    const dismiss = () => { if (!window.isDestroyed()) window.close(); };
    window.once('blur', dismiss);
    pet.once('hide', dismiss);
    pet.once('closed', dismiss);
    window.once('closed', () => {
      menuWindow = undefined;
      pet.removeListener('hide', dismiss);
      pet.removeListener('closed', dismiss);
    });
    void loadLocalFile(window, {view: 'main-agent-menu', keyboard: keyboard ? '1' : '0'}).then(() => {
      if (!window.isDestroyed()) window.show();
    }).catch(() => {
      dismiss();
      if (!pet.isDestroyed() && pet.isVisible()) actions.nativeMenu(pet);
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
    if (sender === menuWindow) {
      const menu = menuModel();
      if (method === 'read') return menu;
      if (method === 'close') { sender.close(); return true; }
      if (method !== 'menu-action') throw Error('未知右键菜单操作');
      const id = payload.id;
      if (!menu.items.some(item => item.id === id) && !['settings','more'].includes(id)
          && !(id === 'guide' && menu.canContinue)) throw Error('未知右键菜单操作');
      sender.close();
      if (id === 'settings') openSettings();
      else if (id === 'more') actions.nativeMenu(getPet());
      else if (id === 'guide') openGuide();
      else await Promise.resolve().then(runShortcut[id]).catch(actions.onError);
      return true;
    }
    if (fromPet && method === 'shortcut' && prefs().shortcuts.includes(payload.id)) {
      await runShortcut[payload.id]();
      return true;
    }
    if (!fromSettings && !fromGuide) throw Error('请从主 Agent 的设置或引导操作');
    if (method === 'read') return snapshot();
    if (method === 'edit') {
      const guideFields = {name: ['name'], personality: ['personality'], roaming: ['roam'],
        responses: ['single', 'response', 'gestures'], shortcuts: ['shortcuts']};
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
    } else if (method === 'walk-preview' && fromGuide && preferences.guideSteps[prefs().guide.step] === 'roaming') {
      if (prefs().roam === 'still' || !roamOnce({preview:true})) throw Error('现在不方便走动，等我一小会儿。');
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
  function roamOnce({preview = false} = {}) {
    const pet = getPet();
    if (!pet || pet.isDestroyed() || !pet.isVisible() || (!preview && guideWindow) || menuWindow
        || reduceMotion() || !actions.canRoam()) return false;
    const bounds = pet.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const near = cursor.x >= bounds.x - 35 && cursor.x <= bounds.x + bounds.width + 35
      && cursor.y >= bounds.y - 35 && cursor.y <= bounds.y + bounds.height + 35;
    if (near && !preview) return false;
    const area = screen.getDisplayMatching(bounds).workArea;
    if (!roamOrigin || roamOrigin.y !== bounds.y || Math.abs(bounds.x - roamOrigin.lastX) > 2) {
      roamOrigin = {x: bounds.x, y: bounds.y, lastX: bounds.x};
    }
    const step = bounds.x >= roamOrigin.x ? -24 : 24;
    const maxX = Math.max(area.x, area.x + area.width - bounds.width);
    const clamp = x => Math.max(area.x, Math.min(maxX, x));
    let x = clamp(bounds.x + step);
    if (x === bounds.x) x = clamp(bounds.x - step);
    if (x === bounds.x) return false;
    pet.setPosition(x, bounds.y);
    roamOrigin.lastX = x;
    return true;
  }

  function planRoam() {
    clearTimeout(roamTimer);
    const delay = {occasional: 90000, often: 30000}[prefs().roam];
    if (!delay || isQuitting()) return;
    roamTimer = setTimeout(() => {
      roamTimer = undefined;
      roamOnce();
      planRoam();
    }, delay);
  }

  return {
    call, openGuide, openSettings, openMenu, compactItems, openWorkbench, planRoam, showPet,
    isHidden: () => hidden,
    dispose: () => {
      clearTimeout(roamTimer);
      menuWindow?.close();
    },
  };
}

module.exports = {createMainAgentWindows};
