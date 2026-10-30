'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ScreenVision, requireTarget } = require('./screen-vision.cjs');
const { ScreenObservation } = require('./screen-observation-runtime.cjs');
const { trustedLocalCaller } = require('./main-chat-runtime.cjs');

function createScreenShare({ WebContentsView, desktopCapturer, systemPreferences, dataDir, repositoryRoot, safeStorage,
  getChat, getHost, isChatBusy, onReply, onRecord, onOpen = async () => {} } = {}) {
  let view, host, attached = false, visible = false, selected = null, pendingGrant = false, known = new Map(), boundHost, loadPromise, paneEpoch = 0;
  const url = pathToFileURL(path.join(__dirname, 'screen-share.html')).href;
  const vision = new ScreenVision({ dataDir, repositoryRoot, safeStorage, getChat });
  const runtime = new ScreenObservation({ observe: input => vision.observe(input), isChatBusy, onReply, onRecord,
    onState: () => publish() });
  function snapshot() { return { ...runtime.read(), vision: vision.read(), permission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown' }; }
  function publish() { if (view && !view.webContents.isDestroyed()) view.webContents.send('screen-share:state', snapshot()); }
  function authorize(event) { if (!view || !visible || !trustedLocalCaller(event, { webContents: view.webContents, isDestroyed: () => view.webContents.isDestroyed() }, url)) throw new Error('请从屏幕陪伴面板操作'); }
  function pause(reason = '') { pendingGrant = false; runtime.pause(reason); }
  function hide() {
    paneEpoch++; visible = false; pause();
    if (attached && host && !host.isDestroyed()) host.contentView.removeChildView(view);
    attached = false;
  }
  async function place() {
    const current = host;
    if (!visible || !current || current.isDestroyed() || !view || view.webContents.isDestroyed()) return;
    let bounds;
    try { bounds = await current.webContents.executeJavaScript(`(()=>{const sidebar=document.querySelector('[data-slot="sidebar"]');const strip=document.querySelector('.neko-strip');const r=sidebar?.getBoundingClientRect();return {left:r?.right??260,bottom:strip?.getBoundingClientRect().top??innerHeight,width:innerWidth,height:innerHeight};})()`); } catch { return; }
    if (host !== current || !visible || current.isDestroyed()) return;
    const scale = current.webContents.getZoomFactor(), [w, h] = current.getContentSize();
    const x = Math.max(0, Math.min(w - 280, Math.round(bounds.left * scale)));
    view.setBounds({ x, y: 0, width: Math.max(280, w - x), height: Math.max(200, Math.min(h, Math.round(bounds.bottom * scale))) });
  }
  function bind(next) {
    if (boundHost === next) return;
    if (boundHost) for (const [emitter, name, listener] of boundHost.screenListeners || []) emitter.removeListener(name, listener);
    boundHost = next; const listeners = [];
    const listen = (emitter, name, fn) => { emitter.on(name, fn); listeners.push([emitter, name, fn]); };
    next.screenListeners = listeners;
    listen(next, 'resize', () => void place()); listen(next, 'hide', hide); listen(next, 'close', hide);
    listen(next.webContents, 'zoom-changed', () => void place());
    listen(next.webContents, 'did-start-navigation', (_event, _url, sameDocument, mainFrame) => { if (mainFrame && !sameDocument) hide(); });
    listen(next.webContents, 'render-process-gone', hide);
    listen(next, 'closed', () => { hide(); host = null; });
  }
  function create() {
    view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'screen-share-preload.cjs'),
      partition: 'neko-screen-share', sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false } });
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('render-process-gone', () => { runtime.stop(); visible = false; attached = false; });
    // Electron 43 reports display requests as media with an empty mediaTypes list.
    // Camera/microphone requests have explicit mediaTypes and remain denied.
    const allowedCapture = (caller, permission, details) => (permission === 'display-capture'
      || (permission === 'media' && pendingGrant && Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 0)) && caller === contents
      && visible && runtime.phase === 'sharing' && !!selected && contents.getURL() === url
      && details?.isMainFrame !== false && (!details?.requestingUrl || details.requestingUrl === url);
    contents.session.setPermissionCheckHandler((caller, permission, _origin, details) => allowedCapture(caller, permission, details));
    contents.session.setPermissionRequestHandler((caller, permission, callback, details) => callback(allowedCapture(caller, permission, details)));
    contents.session.setDisplayMediaRequestHandler(async (request, callback) => {
      const generation = runtime.generation, sourceId = selected?.id;
      if (!visible || !pendingGrant || runtime.phase !== 'sharing' || !sourceId || request.audioRequested
        || !request.videoRequested || request.frame !== contents.mainFrame || request.frame?.url !== url) { callback({}); return; }
      pendingGrant = false;
      try {
        const sources = await desktopCapturer.getSources({ types: [sourceId.startsWith('window:') ? 'window' : 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        const source = sources.find(item => item.id === sourceId);
        if (!source || !visible || generation !== runtime.generation) { callback({}); if (visible && generation === runtime.generation) pause('共享来源已离开，请重新选择'); return; }
        callback({ video: source }); // No microphone or loopback audio grant.
      } catch { callback({}); if (visible && generation === runtime.generation) pause('屏幕采集未获许可，请检查系统屏幕录制权限'); }
    });
    loadPromise = contents.loadURL(url);
  }
  async function open() {
    const next = getHost(); if (!next || next.isDestroyed()) throw new Error('请先打开工作台');
    const epoch = ++paneEpoch; await onOpen(); if (epoch !== paneEpoch) return;
    if (!view || view.webContents.isDestroyed()) create();
    host = next; bind(next); visible = true;
    await loadPromise;
    if (!visible || host !== next || next.isDestroyed() || epoch !== paneEpoch) return;
    await place(); if (!visible || epoch !== paneEpoch || next.isDestroyed()) return;
    if (!attached) { host.contentView.addChildView(view); attached = true; }
    publish(); view.webContents.focus();
  }
  async function action(event, method, value) {
    authorize(event);
    switch (method) {
      case 'state': return snapshot();
      case 'sources': {
        // Enumeration gets names/IDs only; no screenshots of unselected windows.
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        known = new Map(sources.map(item => [item.id, { id: item.id, name: String(item.name).slice(0, 200) }]));
        return [...known.values()];
      }
      case 'settings': pause(); await vision.save(value); runtime.capability = 'unverified'; publish(); return snapshot();
      case 'start': {
        const current = vision.read();
        if (!current.ready) throw new Error('请先配置聊天 API 或单独的视觉 API');
        const source = known.get(value?.sourceId); if (!source) throw new Error('请刷新并选择共享来源');
        const target = requireTarget(current.effective, value?.target);
        let consent = null;
        if (value?.contextConsent) {
          requireTarget(current.effective, value.contextConsent);
          consent = { ...target };
        }
        selected = source; const result = runtime.start(source, target, consent, value?.memoryConsent === true); pendingGrant = true; return { ...result, vision: current };
      }
      case 'pause': pause(); return snapshot();
      case 'stop': pendingGrant = false; selected = null; runtime.stop(); return snapshot();
      case 'frame': return runtime.frame(value);
      case 'ask': return runtime.ask(value?.text);
      case 'capture-error': pause('无法共享这个来源，请检查权限或重新选择窗口'); return snapshot();
      case 'hide': hide(); return { ok: true };
      default: throw new Error('未知屏幕陪伴操作');
    }
  }
  function interrupt() { if (runtime.phase === 'sharing') pause('正在处理你的聊天，点击继续可恢复屏幕陪伴'); }
  function dispose() {
    hide(); runtime.stop();
    if (boundHost) for (const [emitter, name, listener] of boundHost.screenListeners || []) emitter.removeListener(name, listener);
    boundHost = null;
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    view = null;
  }
  return { open, hide, pause, interrupt, dispose, action, read: snapshot, get isOpen() { return visible; } };
}
module.exports = { createScreenShare };
