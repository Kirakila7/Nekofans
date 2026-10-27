'use strict';

// Existing N.E.K.O. production base (utils/social_base.py) and /feed entry
// used by static/app/app-ui/surface-floating-controls.js.
const DEFAULT_COMMUNITY_URL = 'https://community.project-neko.cn/feed';
const OFFICIAL_AUTH_ORIGIN = 'https://auth.project-neko.cn';
const COMMUNITY_PARTITION = 'persist:neko-community';

function parseWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function resolveCommunityUrl(value = process.env.NEKO_WORKBENCH_COMMUNITY_URL) {
  const raw = value == null || value === '' ? DEFAULT_COMMUNITY_URL : value;
  const invalid = () => new Error('社区地址必须是不含账号凭据的 HTTPS 地址');
  const url = parseWebUrl(raw);
  if (!url || url.protocol !== 'https:') throw invalid();
  const credentialKey = /^(?:token|access[-_]?token|api[-_]?key|authorization|password|passwd|secret|credentials?|signature)$/i;
  for (const fields of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
    for (const key of fields.keys()) if (credentialKey.test(key)) throw invalid();
  }
  return url.href;
}

function classifyCommunityNavigation(value, communityUrl = DEFAULT_COMMUNITY_URL) {
  const target = parseWebUrl(value);
  if (!target) return { kind: 'blocked' };
  const origin = new URL(resolveCommunityUrl(communityUrl)).origin;
  return { kind: target.protocol === 'https:' && [origin, OFFICIAL_AUTH_ORIGIN].includes(target.origin) ? 'internal' : 'external', url: target.href };
}

function communityWebPreferences() {
  return { partition: COMMUNITY_PARTITION, nodeIntegration: false,
    contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
    allowRunningInsecureContent: false };
}

// Only OAuth may create an isolated popup. The feed itself is a child view.
function communityWindowOptions({ show = false, parent } = {}) {
  return { width: 1100, height: 800, minWidth: 760, minHeight: 560, frame: true,
    title: 'N.E.K.O. 社区登录', backgroundColor: '#F6F8FB', show,
    ...(parent ? { parent } : {}), webPreferences: communityWebPreferences() };
}

function installCommunityNavigation(target, { communityUrl, parent, openExternal,
  onExternalError = () => {}, onInternalPopup, onPopup = () => {}, canOpenPopup = () => true }) {
  const contents = target.webContents;
  const external = url => Promise.resolve().then(() => openExternal(url)).catch(onExternalError);
  const navigate = (event, value) => {
    const destination = classifyCommunityNavigation(value, communityUrl);
    if (destination.kind === 'internal') return;
    event.preventDefault();
    if (destination.kind === 'external') void external(destination.url);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.setWindowOpenHandler(({ url }) => {
    if (!canOpenPopup()) return { action: 'deny' };
    const destination = classifyCommunityNavigation(url, communityUrl);
    if (destination.kind === 'internal') {
      if (new URL(destination.url).origin === OFFICIAL_AUTH_ORIGIN) {
        return { action: 'allow', overrideBrowserWindowOptions: communityWindowOptions({ show: true, parent }) };
      }
      // target=_blank community links remain in the embedded page.
      if (onInternalPopup) void onInternalPopup(destination.url);
    } else if (destination.kind === 'external') void external(destination.url);
    return { action: 'deny' };
  });
  const childCreated = child => {
    if (!canOpenPopup()) { child.destroy(); return; }
    onPopup(child);
    installCommunityNavigation(child, { communityUrl, parent, openExternal, onExternalError,
      canOpenPopup, onPopup, onInternalPopup: url => Promise.resolve(child.loadURL(url)).catch(onExternalError) });
  };
  contents.on('did-create-window', childCreated);
  return () => {
    contents.removeListener('will-navigate', navigate);
    contents.removeListener('will-redirect', navigate);
    contents.removeListener('did-create-window', childCreated);
    if (!contents.isDestroyed()) contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  };
}

function validateCommunityRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['action', 'bounds'].includes(key))
      || !['open', 'layout', 'hide', 'reload'].includes(value.action)) throw new Error('未知社区操作');
  if (value.action === 'open' || value.action === 'layout' || value.bounds !== undefined) {
    const bounds = value.bounds;
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)
        || Object.keys(bounds).length !== 4 || !['x', 'y', 'width', 'height'].every(key =>
          Object.hasOwn(bounds, key) && Number.isFinite(bounds[key]) && Math.abs(bounds[key]) <= 1000000)
        || bounds.width <= 0 || bounds.height <= 0) throw new Error('社区布局无效');
  }
  return { action: value.action, ...(value.bounds ? { bounds: { ...value.bounds } } : {}) };
}

function communityBounds(host, bounds) {
  const [width, height] = host.getContentSize();
  const scale = host.webContents.getZoomFactor();
  if (![width, height, scale].every(Number.isFinite) || scale <= 0) throw new Error('工作台布局尚未就绪');
  const x = Math.max(0, Math.min(width, Math.round(bounds.x * scale)));
  const y = Math.max(0, Math.min(height, Math.round(bounds.y * scale)));
  const right = Math.max(x, Math.min(width, Math.round((bounds.x + bounds.width) * scale)));
  const bottom = Math.max(y, Math.min(height, Math.round((bounds.y + bounds.height) * scale)));
  return { x, y, width: right - x, height: bottom - y };
}

const LOAD_ERROR = '社区页面未能打开，请检查网络后重试';
const CANCEL_ERROR = '社区已隐藏或工作台页面已离开';
function createCommunityController({ WebContentsView, openExternal, env = process.env,
  onState = () => {}, onExternalError } = {}) {
  let current = null, binding = null;
  function state(record, status, error) {
    if (current === record && (record.wanted || status === 'hidden')) onState(record.host, { status, ...(error ? { error } : {}) });
  }
  function detach(record) {
    if (!record.attached) return;
    record.attached = false;
    if (!record.host.isDestroyed()) record.host.contentView.removeChildView(record.view);
  }
  function place(record) {
    if (current !== record || !record.wanted || !record.loaded || record.webContents.isDestroyed()) return false;
    const bounds = communityBounds(record.host, record.bounds);
    if (!bounds.width || !bounds.height) { detach(record); return false; }
    record.view.setBounds(bounds);
    if (!record.attached) { record.host.contentView.addChildView(record.view); record.attached = true; }
    return true;
  }
  function dispose(notifyHidden = false) {
    const record = current;
    if (record && notifyHidden && !record.host.isDestroyed() && !record.host.webContents.isDestroyed()) {
      try { state(record, 'hidden'); } catch { /* A closing renderer cannot receive state. */ }
    }
    current = null;
    if (record) {
      record.cancelLoad?.();
      record.epoch++; record.wanted = false; detach(record);
      record.cleanupNavigation();
      for (const popup of record.popups) if (!popup.isDestroyed()) popup.destroy();
      if (!record.webContents.isDestroyed()) record.webContents.close({ waitForBeforeUnload: false });
    }
  }
  function unbind(notifyHidden = false) {
    if (!binding) return;
    const { host, listeners } = binding;
    for (const [emitter, name, listener] of listeners) emitter.removeListener(name, listener);
    binding = null;
    dispose(notifyHidden);
  }
  function bindHost(host) {
    if (binding?.host === host) return;
    unbind(true);
    const listeners = [];
    const listen = (emitter, name, listener) => { emitter.on(name, listener); listeners.push([emitter, name, listener]); };
    binding = { host, listeners };
    // A hidden-to-tray workbench close also disposes remote content. A new entry
    // will reconstruct it using the same persistent community session.
    listen(host, 'close', () => dispose(true));
    listen(host, 'closed', () => unbind(true));
    listen(host, 'resize', () => { if (current) place(current); });
    listen(host.webContents, 'zoom-changed', () => { if (current) place(current); });
    listen(host.webContents, 'will-navigate', () => dispose(true));
    listen(host.webContents, 'did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) dispose(true);
    });
    listen(host.webContents, 'render-process-gone', () => dispose(true));
    listen(host.webContents, 'destroyed', () => unbind(true));
  }
  function fail(record) {
    record.failed = true; record.loaded = false; detach(record);
    state(record, 'error', LOAD_ERROR);
  }
  function create(host, bounds) {
    const communityUrl = resolveCommunityUrl(env.NEKO_WORKBENCH_COMMUNITY_URL);
    const view = new WebContentsView({ webPreferences: communityWebPreferences() });
    const record = { host, view, webContents: view.webContents, communityUrl, bounds,
      epoch: 0, loadId: 0, loading: null, loaded: false, failed: false, wanted: true,
      attached: false, popups: new Set(), responseCode: 0 };
    current = record;
    const contents = record.webContents;
    record.cleanupNavigation = installCommunityNavigation(view, { communityUrl, parent: host, openExternal, onExternalError,
      canOpenPopup: () => current === record && record.wanted && !host.isDestroyed(),
      onPopup: child => { record.popups.add(child); child.once('closed', () => record.popups.delete(child)); },
      onInternalPopup: async url => { try { await load(record, url); place(record); } catch { /* load reports safe errors */ } } });
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace || current !== record) return;
      record.failed = false; record.loaded = false; record.responseCode = 0;
    });
    contents.on('did-navigate', (_event, _url, responseCode) => {
      if (current !== record) return;
      record.responseCode = responseCode;
      if (responseCode >= 400) fail(record);
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (current === record && isMainFrame && code !== -3) fail(record);
    });
    contents.on('did-finish-load', () => {
      if (current !== record || record.failed || record.responseCode >= 400) return;
      record.loaded = true;
      if (!record.loading) { place(record); if (record.wanted) state(record, 'ready'); }
    });
    contents.on('render-process-gone', () => { if (current === record) fail(record); });
    contents.on('destroyed', () => { if (current === record) { fail(record); dispose(); } });
    return record;
  }
  function load(record, url) {
    // Coalesce refreshes while one navigation is pending. Electron navigation
    // events carry no request generation; avoiding overlapping loadURL calls
    // keeps their HTTP status and completion associated with this operation.
    if (record.loading) return record.loading;
    const id = ++record.loadId;
    record.failed = false; record.loaded = false; record.responseCode = 0;
    state(record, 'loading');
    let cancelLoad;
    const canceled = new Promise(resolve => { cancelLoad = () => resolve(false); });
    record.cancelLoad = cancelLoad;
    const navigation = Promise.resolve().then(async () => {
      if (current !== record || record.webContents.isDestroyed()) return false;
      await record.webContents.loadURL(url);
      return true;
    });
    const loading = Promise.resolve().then(async () => {
      try {
        if (!await Promise.race([navigation, canceled])) throw new Error(CANCEL_ERROR);
        if (current !== record || record.webContents.isDestroyed() || id !== record.loadId) throw new Error(CANCEL_ERROR);
        if (record.failed || record.responseCode >= 400) throw new Error(LOAD_ERROR);
        record.loaded = true;
      } catch (error) {
        if (current !== record || id !== record.loadId) throw new Error(CANCEL_ERROR);
        fail(record); throw new Error(LOAD_ERROR);
      } finally {
        if (record.loading === loading) record.loading = null;
        if (record.cancelLoad === cancelLoad) record.cancelLoad = null;
      }
    });
    record.loading = loading;
    return loading;
  }
  async function action(host, value) {
    const request = validateCommunityRequest(value);
    if (!host || host.isDestroyed() || host.webContents.isDestroyed()) throw new Error('请从工作台操作');
    bindHost(host);
    if (request.action === 'hide') {
      if (current) {
        const record = current;
        const wasWanted = record.wanted;
        // Destroy pending navigations so a new open never joins an old load or
        // receives its eventual ERR_ABORTED. Cookies stay in the partition.
        if (record.loading) { if (wasWanted) state(record, 'hidden'); dispose(); }
        else {
          record.epoch++; record.wanted = false; detach(record);
          if (wasWanted) state(record, 'hidden');
        }
      }
      return { ok: true };
    }
    if (request.action === 'layout') {
      if (current) { current.bounds = request.bounds; place(current); }
      return { ok: true };
    }
    if (request.action === 'open') {
      const projected = communityBounds(host, request.bounds);
      if (!projected.width || !projected.height) throw new Error('社区布局无效');
    }
    let record = current;
    if (!record) {
      if (request.action !== 'open') throw new Error('请先打开社区');
      record = create(host, request.bounds);
    }
    if (request.bounds) record.bounds = request.bounds;
    record.wanted = true;
    const epoch = record.epoch;
    if (request.action === 'reload') {
      detach(record);
      const url = record.webContents.getURL();
      await load(record, classifyCommunityNavigation(url, record.communityUrl).kind === 'internal' ? url : record.communityUrl);
    } else if (record.loading) await record.loading;
    else if (!record.loaded) await load(record, record.communityUrl);
    if (current !== record || !record.wanted || epoch !== record.epoch) throw new Error(CANCEL_ERROR);
    if (place(record) && host.isFocused()) record.webContents.focus();
    state(record, 'ready');
    return { ok: true };
  }
  return Object.freeze({ action, bindHost, dispose: () => unbind(true), get view() { return current?.view || null; } });
}

module.exports = { DEFAULT_COMMUNITY_URL, OFFICIAL_AUTH_ORIGIN, COMMUNITY_PARTITION,
  resolveCommunityUrl, classifyCommunityNavigation, communityWebPreferences, communityWindowOptions,
  installCommunityNavigation, validateCommunityRequest, communityBounds, createCommunityController };
