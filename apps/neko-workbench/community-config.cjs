'use strict';

// Existing N.E.K.O. production base (utils/social_base.py) and /feed entry
// used by static/app/app-ui/surface-floating-controls.js.
const DEFAULT_COMMUNITY_URL = 'https://community.project-neko.cn/feed';
const OFFICIAL_AUTH_ORIGIN = 'https://auth.project-neko.cn';
const COMMUNITY_PARTITION = 'persist:neko-community';
const BILIBILI_URL = 'https://m.bilibili.com/';
const BILIBILI_HOME_URL = 'https://www.bilibili.com/';
const BILIBILI_PLAYER_ORIGIN = 'https://player.bilibili.com';
const BILIBILI_PARTITION = 'persist:neko-bilibili';
// The mobile site otherwise redirects desktop user agents to the desktop site.
const BILIBILI_MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
// Retain Chromium's platform and version while removing Electron/app product
// tokens; derive this before replacing the view's UA with the mobile one.
function bilibiliDesktopUserAgent(value) {
  const parts = typeof value === 'string' && value.match(/^(Mozilla\/5\.0\s+\([^)]+\)\s+AppleWebKit\/[^\s]+\s+\(KHTML, like Gecko\)).*?\b(Chrome\/[0-9.]+).*?\b(Safari\/[0-9.]+)/);
  return parts ? `${parts[1]} ${parts[2]} ${parts[3]}` : null;
}
// Main-frame destinations only. Other resources remain subject to Chromium's
// normal origin rules; third-party destinations open outside this view.
const BILIBILI_ORIGINS = new Set([
  'https://m.bilibili.com', 'https://www.bilibili.com',
  'https://passport.bilibili.com', 'https://account.bilibili.com',
  'https://space.bilibili.com', 'https://search.bilibili.com',
  'https://t.bilibili.com', 'https://live.bilibili.com',
]);

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

function classifyBilibiliNavigation(value) {
  const target = parseWebUrl(value);
  if (!target) return { kind: 'blocked' };
  if (target.origin === BILIBILI_PLAYER_ORIGIN) {
    return bilibiliOfficialPlayerIdentity(target) ? { kind: 'internal', url: target.href } : { kind: 'blocked' };
  }
  return { kind: target.protocol === 'https:' && BILIBILI_ORIGINS.has(target.origin) ? 'internal' : 'external', url: target.href };
}

// Bilibili's documented player endpoint, rebuilt exclusively from the
// currently open official video identity. Reject foreign/duplicate parameters.
function bilibiliOfficialPlayerIdentity(url) {
  if (!url || url.origin !== BILIBILI_PLAYER_ORIGIN || url.pathname !== '/player.html' || url.hash) return null;
  if ([...url.searchParams.keys()].some(key => !['bvid', 'p', 'autoplay'].includes(key))) return null;
  const ids = url.searchParams.getAll('bvid'), pages = url.searchParams.getAll('p'), autoplay = url.searchParams.getAll('autoplay');
  if (ids.length !== 1 || !/^BV[0-9A-Za-z]{10}$/.test(ids[0]) || pages.length > 1 || autoplay.length > 1 || (autoplay.length && autoplay[0] !== '0')) return null;
  const page = pages.length ? pages[0] : '1';
  if (!/^[1-9][0-9]{0,3}$/.test(page) || Number(page) > 1000) return null;
  return { bvid: ids[0], page: Number(page) };
}

function bilibiliOfficialPlayerUrl(value) {
  const url = parseWebUrl(value);
  if (!url || !['https://m.bilibili.com', 'https://www.bilibili.com'].includes(url.origin)) return null;
  const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
  if (!match) return null;
  const pages = url.searchParams.getAll('p');
  const page = pages.length ? pages[0] : '1';
  if (pages.length > 1 || !/^[1-9][0-9]{0,3}$/.test(page) || Number(page) > 1000) return null;
  return `${BILIBILI_PLAYER_ORIGIN}/player.html?bvid=${match[1]}&p=${Number(page)}&autoplay=0`;
}

// Only share public video identifiers, never authentication, tracking or
// redirect parameters. Preserve a valid multipart selection when present.
function bilibiliVideoShareUrl(value) {
  const url = parseWebUrl(value);
  const official = bilibiliOfficialPlayerIdentity(url);
  if (official) return `https://www.bilibili.com/video/${official.bvid}${official.page > 1 ? `?p=${official.page}` : ''}`;
  if (!url || url.protocol !== 'https:' || !['https://m.bilibili.com', 'https://www.bilibili.com'].includes(url.origin)) return null;
  const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]{1,20})\/?$/.exec(url.pathname);
  if (!match) return null;
  const page = url.searchParams.get('p');
  const part = page && /^[1-9][0-9]{0,3}$/.test(page) ? `?p=${page}` : '';
  return `https://www.bilibili.com/video/${match[1]}${part}`;
}

function communityWebPreferences(partition = COMMUNITY_PARTITION) {
  return { partition, nodeIntegration: false,
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
  classify = url => classifyCommunityNavigation(url, communityUrl), allowAuthPopup = true,
  onExternalError = () => {}, onInternalPopup, onInternalNavigate = () => {}, onPopup = () => {}, canOpenPopup = () => true }) {
  const contents = target.webContents;
  const external = url => Promise.resolve().then(() => openExternal(url)).catch(onExternalError);
  const navigate = (event, value) => {
    const destination = classify(value);
    if (destination.kind === 'internal') { onInternalNavigate(destination.url); return; }
    event.preventDefault();
    if (destination.kind === 'external') void external(destination.url);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.setWindowOpenHandler(({ url }) => {
    if (!canOpenPopup()) return { action: 'deny' };
    const destination = classify(url);
    if (destination.kind === 'internal') {
      if (allowAuthPopup && new URL(destination.url).origin === OFFICIAL_AUTH_ORIGIN) {
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
    installCommunityNavigation(child, { communityUrl, parent, openExternal, onExternalError, classify, allowAuthPopup, onInternalNavigate,
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
      || Object.keys(value).some(key => !['action', 'bounds', 'site', 'slot', 'requestId', 'home'].includes(key))
      || !['open', 'layout', 'hide', 'reload', 'back', 'copy-video-link', 'play-official'].includes(value.action)
      || (value.requestId !== undefined && (!['open', 'hide'].includes(value.action) || !Number.isSafeInteger(value.requestId) || value.requestId < 1))
      || (value.site !== undefined && (value.action !== 'open' || !['community', 'bilibili'].includes(value.site)))
      || (value.slot !== undefined && !['side', 'left', 'right'].includes(value.slot))
      || (value.home !== undefined && (value.home !== true || value.action !== 'open' || value.site !== 'bilibili'))) throw new Error('未知社区操作');
  if (value.action === 'open' || value.action === 'layout' || value.bounds !== undefined) {
    const bounds = value.bounds;
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)
        || Object.keys(bounds).length !== 4 || !['x', 'y', 'width', 'height'].every(key =>
          Object.hasOwn(bounds, key) && Number.isFinite(bounds[key]) && Math.abs(bounds[key]) <= 1000000)
        || bounds.width <= 0 || bounds.height <= 0) throw new Error('社区布局无效');
  }
  return { action: value.action, ...(value.site ? { site: value.site } : {}), ...(value.slot ? { slot: value.slot } : {}), ...(value.home === true ? { home: true } : {}), ...(value.requestId !== undefined ? { requestId: value.requestId } : {}), ...(value.bounds ? { bounds: { ...value.bounds } } : {}) };
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
function createCommunityController({ WebContentsView, openExternal, copyText, env = process.env, site = 'community',
  onState = () => {}, onHide = () => {}, onExternalError } = {}) {
  if (!['community', 'bilibili'].includes(site)) throw new Error('未知内容入口');
  const isBilibili = site === 'bilibili';
  const LOAD_ERROR = isBilibili ? 'B 站页面未能打开，请检查网络后重试' : '社区页面未能打开，请检查网络后重试';
  const classify = (url, communityUrl) => isBilibili ? classifyBilibiliNavigation(url) : classifyCommunityNavigation(url, communityUrl);
  let current = null, binding = null;
  function canGoBack(record) {
    if (record.backPending) return false;
    const history = record.webContents.navigationHistory;
    try { return !!(history ? history.canGoBack() : record.webContents.canGoBack?.()); } catch { return false; }
  }
  function canShare(record) {
    return !!(isBilibili && record.wanted && record.attached && record.loaded && !record.loading &&
      !record.webContents.isDestroyed() && bilibiliVideoShareUrl(record.webContents.getURL()));
  }
  function canPlayOfficial(record) {
    return !!(isBilibili && record.wanted && record.attached && record.loaded && !record.loading &&
      !record.webContents.isDestroyed() && bilibiliOfficialPlayerUrl(record.webContents.getURL()));
  }
  function isOfficialPlayer(record) {
    return !!(isBilibili && !record.webContents.isDestroyed() &&
      bilibiliOfficialPlayerIdentity(parseWebUrl(record.webContents.getURL())));
  }
  function state(record, status, error) {
    if (current === record && (record.wanted || status === 'hidden')) onState(record.host, { status, ...(record.requestId !== undefined ? { requestId: record.requestId } : {}), ...(isBilibili ? { canGoBack: canGoBack(record), canShare: canShare(record), canPlayOfficial: canPlayOfficial(record), isOfficialPlayer: isOfficialPlayer(record) } : {}), ...(error ? { error } : {}) });
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
    if (record?.wanted) onHide();
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
    record.failed = true; record.loaded = false; record.backPending = false; detach(record);
    state(record, 'error', LOAD_ERROR);
  }
  function create(host, bounds, requestId) {
    const communityUrl = isBilibili ? BILIBILI_URL : resolveCommunityUrl(env.NEKO_WORKBENCH_COMMUNITY_URL);
    const view = new WebContentsView({ webPreferences: communityWebPreferences(isBilibili ? BILIBILI_PARTITION : COMMUNITY_PARTITION) });
    const record = { host, view, webContents: view.webContents, communityUrl, bounds, requestId,
      epoch: 0, loadId: 0, loading: null, loaded: false, failed: false, wanted: true,
      attached: false, popups: new Set(), responseCode: 0 };
    current = record;
    const contents = record.webContents;
    record.desktopUserAgent = isBilibili ? bilibiliDesktopUserAgent(contents.getUserAgent?.()) : null;
    function setBilibiliAgent(url) {
      if (!isBilibili) return;
      const player = bilibiliOfficialPlayerIdentity(parseWebUrl(url));
      const homepage = url === BILIBILI_HOME_URL;
      contents.setUserAgent((player || homepage) && record.desktopUserAgent ? record.desktopUserAgent : BILIBILI_MOBILE_USER_AGENT);
    }
    record.setBilibiliAgent = setBilibiliAgent;
    if (isBilibili) contents.setUserAgent(BILIBILI_MOBILE_USER_AGENT);
    record.cleanupNavigation = installCommunityNavigation(view, { communityUrl, parent: host, openExternal, onExternalError,
      classify: url => classify(url, communityUrl), allowAuthPopup: !isBilibili,
      onInternalNavigate: setBilibiliAgent,
      canOpenPopup: () => current === record && record.wanted && !host.isDestroyed(),
      onPopup: child => { record.popups.add(child); child.once('closed', () => record.popups.delete(child)); },
      onInternalPopup: async url => {
        try {
          await load(record, url);
          if (current === record && record.wanted) { place(record); state(record, 'ready'); }
        } catch { /* load reports safe errors */ }
      } });
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace || current !== record) return;
      record.failed = false; record.loaded = false; record.responseCode = 0;
      if (isBilibili && record.wanted && !record.loading) state(record, 'loading');
    });
    contents.on('did-navigate', (_event, _url, responseCode) => {
      if (current !== record) return;
      record.responseCode = responseCode;
      if (responseCode >= 400) fail(record);
    });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isBilibili && isMainFrame && current === record && record.wanted) {
        if (record.backPending) { record.backPending = false; record.loaded = true; place(record); }
        state(record, 'ready');
      }
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (current === record && isMainFrame && code !== -3) fail(record);
    });
    contents.on('did-finish-load', () => {
      if (current !== record || record.failed || record.responseCode >= 400) return;
      record.loaded = true; record.backPending = false;
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
      record.setBilibiliAgent(url);
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
        if (request.requestId !== undefined && request.requestId !== record.requestId) return { ok: true, stale: true };
        const wasWanted = record.wanted;
        // Destroy pending navigations so a new open never joins an old load or
        // receives its eventual ERR_ABORTED. Cookies stay in the partition.
        if (record.loading) { if (wasWanted) state(record, 'hidden'); dispose(); }
        else {
          if (wasWanted) onHide();
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
    if (request.action === 'back') {
      const record = current;
      if (!record || !record.wanted || record.webContents.isDestroyed()) throw new Error('请先打开内容');
      if (canGoBack(record)) {
        // Returning from the official player restores the mobile video page.
        if (isBilibili && bilibiliOfficialPlayerIdentity(parseWebUrl(record.webContents.getURL()))) record.setBilibiliAgent(BILIBILI_URL);
        const history = record.webContents.navigationHistory;
        // goBack only starts navigation: do not publish the previous page as
        // ready or let a second click race the pending history traversal.
        record.backPending = true; record.loaded = false;
        state(record, 'loading');
        try { if (history) history.goBack(); else record.webContents.goBack(); }
        catch (error) { record.backPending = false; record.loaded = true; state(record, 'ready'); throw error; }
        return { ok: true };
      }
      return { ok: true };
    }
    if (request.action === 'copy-video-link') {
      const record = current;
      if (!record || !canShare(record) || typeof copyText !== 'function') throw new Error('请先打开 B 站视频');
      const url = bilibiliVideoShareUrl(record.webContents.getURL());
      try { await copyText(url); } catch { throw new Error('复制链接失败，请重试'); }
      return { ok: true };
    }
    if (request.action === 'play-official') {
      const record = current;
      if (!record || !canPlayOfficial(record)) throw new Error('请先打开支持的 B 站视频');
      const url = bilibiliOfficialPlayerUrl(record.webContents.getURL());
      const epoch = record.epoch;
      await load(record, url);
      if (current !== record || !record.wanted || epoch !== record.epoch) throw new Error(CANCEL_ERROR);
      place(record); state(record, 'ready');
      return { ok: true };
    }
    if (request.action === 'open') {
      const projected = communityBounds(host, request.bounds);
      if (!projected.width || !projected.height) throw new Error('社区布局无效');
    }
    let record = current;
    if (!record) {
      if (request.action !== 'open') throw new Error('请先打开社区');
      record = create(host, request.bounds, request.requestId);
    }
    if (request.action === 'open') {
      record.requestId = request.requestId;
      // In split layout an open may finish long after the user resumed typing
      // in DSH. Keep focus on the user's current surface; pointer/keyboard
      // interaction can still focus the child view in the usual way. Store
      // this on the view so a coalesced older legacy open cannot steal focus.
      record.managedBySlot = !!request.slot;
    }
    if (request.bounds) record.bounds = request.bounds;
    record.wanted = true;
    const epoch = record.epoch;
    if (request.action === 'open' && request.home === true && isBilibili) {
      detach(record);
      await load(record, BILIBILI_HOME_URL);
    } else if (request.action === 'reload') {
      detach(record);
      const url = record.webContents.getURL();
      await load(record, classify(url, record.communityUrl).kind === 'internal' ? url : record.communityUrl);
    } else if (record.loading) await record.loading;
    else if (!record.loaded) await load(record, record.communityUrl);
    if (current !== record || !record.wanted || epoch !== record.epoch) throw new Error(CANCEL_ERROR);
    if (place(record) && !record.managedBySlot && host.isFocused()) record.webContents.focus();
    state(record, 'ready');
    return { ok: true };
  }
  async function handoff(host, value) {
    const record = current, url = parseWebUrl(value);
    // Proof-bearing navigation is only ever generated by the trusted main process.
    if (isBilibili || !record || record.host !== host || !record.wanted || record.loading || host.isDestroyed()) throw new Error(CANCEL_ERROR);
    if (!url || url.origin !== new URL(DEFAULT_COMMUNITY_URL).origin || url.pathname !== '/feed'
        || new URL(record.communityUrl).origin !== url.origin) throw new Error('桌面身份交接地址无效');
    const epoch = record.epoch;
    await load(record, url.href);
    if (current !== record || !record.wanted || epoch !== record.epoch) throw new Error(CANCEL_ERROR);
    place(record); state(record, 'ready');
  }
  return Object.freeze({ action, handoff, bindHost, dispose: () => unbind(true),
    get isOpen() { return !!current?.wanted; }, get view() { return current?.view || null; } });
}

// Each provider owns a single persistent view. Slot routing allows the two
// different providers to coexist while moving a view never reloads it.
// Calls without a slot keep the original single-active-view behaviour.
function createSocialController(options = {}) {
  const publish = options.onState || (() => {});
  const slots = new Map(), slotVersion = new Map(), siteVersion = new Map();
  const bump = slot => { const v = (slotVersion.get(slot) || 0) + 1; slotVersion.set(slot, v); return v; };
  const bumpSite = site => { const v = (siteVersion.get(site) || 0) + 1; siteVersion.set(site, v); return v; };
  const slotOf = site => [...slots].find(([, entry]) => entry.site === site)?.[0];
  const controllers = Object.fromEntries(['community', 'bilibili'].map(site => [site,
    createCommunityController({ ...options, site, onHide: site === 'community' ? options.onHide : undefined, onState: (host, value) => {
      const slot = slotOf(site);
      publish(host, { ...value, site, ...(slot ? { slot } : {}) });
    } })]));
  let active = 'community', generation = 0, activeRequestId, legacyVisible = false;
  async function clearSlots(host, exceptSite, version) {
    for (const [slot, entry] of [...slots]) {
      // Another slot operation supersedes this single-pane transition. Do
      // not hide a view which may already have moved to the new layout.
      if (generation !== version) return false;
      if (slots.get(slot) !== entry) continue;
      bump(slot);
      if (entry.site !== exceptSite) await controllers[entry.site].action(host, { action: 'hide' });
      if (generation !== version) return false;
      if (slots.get(slot) === entry) slots.delete(slot);
    }
    return generation === version;
  }
  async function slotAction(host, request) {
    const slot = request.slot;
    if (request.action === 'open') {
      // A new explicit slot assignment supersedes an older legacy transition.
      // Other slot actions do not invalidate it, so delayed resize/hide events
      // from the previous layout cannot cancel the user's new navigation.
      ++generation;
      const next = request.site || 'community';
      const version = bump(slot);
      const siteTicket = bumpSite(next);
      // Invalidate an old single-pane open before transitioning into slots.
      if (legacyVisible) {
        legacyVisible = false;
        if (active !== next) await controllers[active].action(host, { action: 'hide' });
        if (slotVersion.get(slot) !== version || siteVersion.get(next) !== siteTicket) throw new Error(CANCEL_ERROR);
      }
      const occupied = slots.get(slot);
      if (occupied && occupied.site !== next) {
        await controllers[occupied.site].action(host, { action: 'hide' });
        if (slotVersion.get(slot) !== version || siteVersion.get(next) !== siteTicket) throw new Error(CANCEL_ERROR);
        if (slots.get(slot) === occupied) slots.delete(slot);
      }
      // One WebContentsView cannot be in two places: moving reuses it and
      // invalidates the old slot rather than creating another web session.
      const oldSlot = slotOf(next);
      if (oldSlot && oldSlot !== slot) { bump(oldSlot); slots.delete(oldSlot); }
      const entry = { site: next, requestId: request.requestId };
      slots.set(slot, entry); active = next;
      const result = await controllers[next].action(host, { action: 'open', site: next, slot, bounds: request.bounds,
        ...(request.home === true ? { home: true } : {}), ...(request.requestId !== undefined ? { requestId: request.requestId } : {}) });
      if (slotVersion.get(slot) !== version || siteVersion.get(next) !== siteTicket || slots.get(slot) !== entry) throw new Error(CANCEL_ERROR);
      return result;
    }
    const entry = slots.get(slot);
    if (!entry) return request.action === 'hide' || request.action === 'layout' ? { ok: true } : Promise.reject(new Error('请先打开内容'));
    if (request.action === 'hide' && request.requestId !== undefined && request.requestId !== entry.requestId) return { ok: true, stale: true };
    active = entry.site;
    const { slot: _slot, ...single } = request;
    if (request.action === 'hide') {
      bump(slot); bumpSite(entry.site);
      const result = controllers[entry.site].action(host, single);
      if (slots.get(slot) === entry) slots.delete(slot);
      return result;
    }
    return controllers[entry.site].action(host, single);
  }
  async function action(host, value) {
    const request = validateCommunityRequest(value);
    if (request.slot) return slotAction(host, request);
    if (request.action === 'hide' && request.requestId !== undefined &&
        (!legacyVisible || request.requestId !== activeRequestId)) return { ok: true, stale: true };
    let version;
    if (slots.size) {
      // A delayed legacy hide must not erase freshly assigned slots.
      if (request.action === 'hide' && request.requestId !== undefined) return { ok: true, stale: true };
      // Delayed actions from the old single-pane toolbar cannot operate on
      // whichever multi-pane view happened to become active most recently.
      if (request.action !== 'open' && request.action !== 'hide') return { ok: true, stale: true };
    }
    if (request.action === 'open' || request.action === 'hide') {
      version = ++generation;
      if (slots.size && !await clearSlots(host, request.action === 'open' ? (request.site || 'community') : undefined, version)) {
        if (request.action === 'open') throw new Error(CANCEL_ERROR);
        return { ok: true, stale: true };
      }
    }
    if (request.action === 'open') {
      const next = request.site || 'community';
      const previous = active;
      active = next;
      activeRequestId = request.requestId;
      legacyVisible = true;
      if (previous !== next) await controllers[previous].action(host, { action: 'hide' });
      if (version !== generation) throw new Error(CANCEL_ERROR);
      return controllers[next].action(host, { action: 'open', site: next, bounds: request.bounds, ...(request.home === true ? { home: true } : {}), ...(request.requestId !== undefined ? { requestId: request.requestId } : {}) });
    }
    if (request.action === 'hide') {
      if (request.requestId !== undefined && request.requestId !== activeRequestId) return { ok: true, stale: true };
      legacyVisible = false;
    }
    return controllers[active].action(host, request);
  }
  return Object.freeze({ action,
    async handoff(host, url) {
      if (!controllers.community.isOpen) throw new Error(CANCEL_ERROR);
      // A Bilibili operation in another slot must not invalidate the community
      // handoff; only a change to the community view itself can do so.
      const ticket = siteVersion.get('community') || 0;
      await controllers.community.handoff(host, url);
      if ((siteVersion.get('community') || 0) !== ticket || !controllers.community.isOpen) throw new Error(CANCEL_ERROR);
    },
    bindHost(host) { Object.values(controllers).forEach(controller => controller.bindHost(host)); },
    dispose() { ++generation; for (const slot of slots.keys()) bump(slot); slots.clear(); legacyVisible = false; Object.values(controllers).forEach(controller => controller.dispose()); },
    get isOpen() { return controllers.community.isOpen; },
    get view() { return controllers[active].view; } });
}

module.exports = { DEFAULT_COMMUNITY_URL, OFFICIAL_AUTH_ORIGIN, COMMUNITY_PARTITION, BILIBILI_URL, BILIBILI_HOME_URL, BILIBILI_PARTITION, BILIBILI_MOBILE_USER_AGENT, BILIBILI_PLAYER_ORIGIN,
  resolveCommunityUrl, classifyCommunityNavigation, communityWebPreferences, communityWindowOptions,
  classifyBilibiliNavigation, bilibiliVideoShareUrl, bilibiliOfficialPlayerUrl, installCommunityNavigation, validateCommunityRequest, communityBounds,
  createCommunityController, createSocialController };
