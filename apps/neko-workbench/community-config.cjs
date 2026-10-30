'use strict';

// Existing N.E.K.O. production base (utils/social_base.py) and /feed entry
// used by static/app/app-ui/surface-floating-controls.js.
const DEFAULT_COMMUNITY_URL = 'https://community.project-neko.cn/feed';
const OFFICIAL_AUTH_ORIGIN = 'https://auth.project-neko.cn';
const COMMUNITY_PARTITION = 'persist:neko-community';
const BILIBILI_URL = 'https://www.bilibili.com/';
const BILIBILI_HOME_URL = BILIBILI_URL;
const BILIBILI_PLAYER_ORIGIN = 'https://player.bilibili.com';
const BILIBILI_PARTITION = 'persist:neko-bilibili';
const YOUTUBE_PARTITION = 'persist:neko-youtube';
const YOUTUBE_SAMPLE_ID = 'M7lc1UVf-VE';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const YOUTUBE_SAMPLE_URL = `${YOUTUBE_ORIGIN}/embed/${YOUTUBE_SAMPLE_ID}`;
const YOUTUBE_SHORTS_URL = `${YOUTUBE_ORIGIN}/shorts`;
const YOUTUBE_MIN_SIZE = 200;
// The daily macOS package uses this registered bundle identifier. Consumers
// building a different app can supply their own identifier to the controller.
const YOUTUBE_APP_ID = 'cn.neko.workbench.trial';
// Fallback only if Electron cannot provide a parsable Chromium desktop UA.
const BILIBILI_DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Retain Chromium's platform and version while removing Electron/app product
// tokens. The same desktop identity is used throughout Bilibili navigation.
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

// Convert only explicitly supported YouTube video links to the official
// embedded player. Never forward tracking, timestamps or arbitrary params.
function youtubeEmbedUrl(value) {
  const url = parseWebUrl(value);
  if (!url || url.protocol !== 'https:' || url.port) return null;
  const lists = url.searchParams.getAll('list');
  if (lists.length > 1 || (lists.length && !/^PL[A-Za-z0-9_-]{10,126}$/.test(lists[0]))) return null;
  let id;
  if (url.origin === 'https://youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (['https://www.youtube.com', 'https://youtube.com', 'https://m.youtube.com'].includes(url.origin)) {
    if (url.pathname === '/watch') {
      const ids = url.searchParams.getAll('v');
      if (ids.length !== 1) return null;
      id = ids[0];
    } else if (url.pathname === '/playlist' || url.pathname === '/embed') {
      return lists.length ? `${YOUTUBE_ORIGIN}/embed?listType=playlist&list=${lists[0]}` : null;
    } else id = /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? `${YOUTUBE_ORIGIN}/embed/${id}${lists.length ? '?list='+lists[0] : ''}` : null;
}

function classifyYoutubeNavigation(value) {
  const target = parseWebUrl(value);
  if (!target) return { kind: 'blocked' };
  if (target.origin === YOUTUBE_ORIGIN && /^\/shorts(?:\/[A-Za-z0-9_-]{11})?\/?$/.test(target.pathname)) return { kind:'internal',url:target.href };
  const embedded = youtubeEmbedUrl(target.href);
  if (embedded) return { kind:'internal',url:embedded };
  return { kind:'external',url:target.href };
}

function youtubeReferrer(appId = YOUTUBE_APP_ID) {
  if (typeof appId !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(appId)) throw new Error('YouTube 应用标识无效');
  return `https://${appId.toLowerCase()}/`;
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
  onExternalError = () => {}, onInternalPopup, onInternalNavigate = () => {}, rewriteInternal = false, blockExternalRedirect = false, onPopup = () => {}, canOpenPopup = () => true }) {
  const contents = target.webContents;
  const external = url => Promise.resolve().then(() => openExternal(url)).catch(onExternalError);
  const navigate = (event, value) => {
    const destination = classify(value);
    if (destination.kind === 'internal') {
      if (rewriteInternal && destination.url !== value) { event.preventDefault(); if (onInternalPopup) void onInternalPopup(destination.url); return; }
      onInternalNavigate(destination.url); return;
    }
    event.preventDefault();
    if (destination.kind === 'external') void external(destination.url);
  };
  const redirect = (event, value) => {
    if (blockExternalRedirect && classify(value).kind !== 'internal') { event.preventDefault(); return; }
    navigate(event, value);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', redirect);
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
    contents.removeListener('will-redirect', redirect);
    contents.removeListener('did-create-window', childCreated);
    if (!contents.isDestroyed()) contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  };
}

function validateCommunityRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['action', 'bounds', 'holes', 'site', 'slot', 'requestId', 'home', 'videoUrl'].includes(key))
      || !['open', 'layout', 'hide', 'reload', 'back', 'copy-video-link', 'play-official', 'open-youtube-video', 'open-youtube-shorts'].includes(value.action)
      || (value.requestId !== undefined && (!['open', 'hide'].includes(value.action) || !Number.isSafeInteger(value.requestId) || value.requestId < 1))
      || (value.site !== undefined && (value.action !== 'open' || !['community', 'bilibili', 'youtube'].includes(value.site)))
      || (value.slot !== undefined && !['side', 'left', 'right'].includes(value.slot))
      || (value.home !== undefined && (value.home !== true || value.action !== 'open' || value.site !== 'bilibili'))
      || (value.videoUrl !== undefined && (value.action !== 'open-youtube-video' || !youtubeEmbedUrl(value.videoUrl)))
      || (value.action === 'open-youtube-video' && value.videoUrl === undefined)) throw new Error('未知社区操作');
  if (value.action === 'open' || value.action === 'layout' || value.bounds !== undefined) {
    const bounds = value.bounds;
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)
        || Object.keys(bounds).length !== 4 || !['x', 'y', 'width', 'height'].every(key =>
          Object.hasOwn(bounds, key) && Number.isFinite(bounds[key]) && Math.abs(bounds[key]) <= 1000000)
        || bounds.width <= 0 || bounds.height <= 0) throw new Error('社区布局无效');
  }
  if(value.holes!==undefined && (!['open','layout'].includes(value.action) || !Array.isArray(value.holes) || value.holes.length>3 || value.holes.some(r=>!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==4||!['x','y','width','height'].every(k=>Object.hasOwn(r,k)&&Number.isFinite(r[k])&&Math.abs(r[k])<=1000000)||r.width<=0||r.height<=0)))throw new Error('社区布局无效');
  return { action: value.action, ...(value.site ? { site: value.site } : {}), ...(value.slot ? { slot: value.slot } : {}), ...(value.videoUrl ? { videoUrl: value.videoUrl } : {}), ...(value.home === true ? { home: true } : {}), ...(value.requestId !== undefined ? { requestId: value.requestId } : {}), ...(value.bounds ? { bounds: { ...value.bounds } } : {}), ...(value.holes ? {holes:value.holes.map(r=>({...r}))} : {}) };
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
function createCommunityController({ WebContentsView, BaseWindow, openExternal, copyText, env = process.env, site = 'community', youtubeAppId = YOUTUBE_APP_ID,
  onState = () => {}, onHide = () => {}, onExternalError } = {}) {
  if (!['community', 'bilibili', 'youtube'].includes(site)) throw new Error('未知内容入口');
  const isBilibili = site === 'bilibili';
  const isYoutube = site === 'youtube';
  const youtubeIdentity = isYoutube ? youtubeReferrer(youtubeAppId) : null;
  const LOAD_ERROR = isYoutube ? 'YouTube 播放器未能打开，请检查网络后重试' : isBilibili ? 'B 站页面未能打开，请检查网络后重试' : '社区页面未能打开，请检查网络后重试';
  const classify = (url, communityUrl) => isYoutube ? classifyYoutubeNavigation(url) : isBilibili ? classifyBilibiliNavigation(url) : classifyCommunityNavigation(url, communityUrl);
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
    if (current === record && (record.wanted || status === 'hidden')) onState(record.host, { status, ...(record.requestId !== undefined ? { requestId: record.requestId } : {}), ...(isBilibili || isYoutube ? { canGoBack: canGoBack(record) } : {}), ...(isBilibili ? { canShare: canShare(record), canPlayOfficial: canPlayOfficial(record), isOfficialPlayer: isOfficialPlayer(record) } : {}), ...(isYoutube ? { tooSmall: !!record.tooSmall } : {}), ...(error ? { error } : {}) });
  }
  // A detached video view can continue producing audio. Mute only while it is
  // hidden and restore the exact previous WebContents mute state on reattach;
  // this does not change the site's own volume or mute controls.
  function muteWhileHidden(record) {
    const contents = record.webContents;
    if (!(isBilibili || isYoutube) || record.temporaryAudioMute || contents.isDestroyed() ||
        typeof contents.isAudioMuted !== 'function' || typeof contents.setAudioMuted !== 'function') return;
    record.previousAudioMute = contents.isAudioMuted();
    contents.setAudioMuted(true);
    record.temporaryAudioMute = true;
  }
  function restoreAudio(record) {
    const contents = record.webContents;
    if (!record.temporaryAudioMute || contents.isDestroyed()) return;
    contents.setAudioMuted(record.previousAudioMute);
    record.temporaryAudioMute = false;
    delete record.previousAudioMute;
  }
  function detach(record) {
    if (!record.attached) return;
    record.attached = false;
    if(record.nativeOverlay){record.nativeOverlay.destroy();record.nativeOverlay=null;}
    else if (!record.host.isDestroyed()) record.host.contentView.removeChildView(record.view);
  }
  function place(record) {
    if (current !== record || !record.wanted || !record.loaded || record.webContents.isDestroyed()) return false;
    let bounds = communityBounds(record.host, record.bounds);
    if (isYoutube) {
      const scale = record.host.webContents.getZoomFactor();
      record.tooSmall = bounds.width / scale < YOUTUBE_MIN_SIZE || bounds.height / scale < YOUTUBE_MIN_SIZE;
      if (record.tooSmall) { muteWhileHidden(record); detach(record); return false; }
    }
    if (!bounds.width || !bounds.height) { detach(record); return false; }
    const holes=(record.holes||[]).map(h=>communityBounds(record.host,h)).filter(h=>h.width>0&&h.height>0&&h.x<bounds.x+bounds.width&&h.x+h.width>bounds.x&&h.y<bounds.y+bounds.height&&h.y+h.height>bounds.y);
    if(holes.length&&BaseWindow&&process.platform==='win32') {
      try {
        if(!record.nativeOverlay){
          if(record.attached){record.host.contentView.removeChildView(record.view);record.attached=false;}
          const {createNativeSocialWindow}=require('./native-social-window.cjs');
          record.nativeOverlay=createNativeSocialWindow({BaseWindow,host:record.host,view:record.view});
          record.nativeOverlay.attach();record.attached=true;
        }
        record.nativeOverlay.place(bounds,holes);return true;
      }catch{
        if(record.nativeOverlay){record.nativeOverlay.destroy();record.nativeOverlay=null;record.attached=false;}
      }
    } else if(record.nativeOverlay) {record.nativeOverlay.destroy();record.nativeOverlay=null;record.attached=false;}
    // Preserve access to the original composer if shaped windows fail.
    const controls=holes.filter(h=>!(h.width<=48&&h.height>100));
    if(controls.length){const bottom=Math.max(bounds.y,Math.min(...controls.map(h=>h.y),bounds.y+bounds.height)-8);bounds={...bounds,height:bottom-bounds.y};if(!bounds.height){detach(record);return false;}}
    record.view.setBounds(bounds);
    if (!record.attached) { record.host.contentView.addChildView(record.view); record.attached = true; }
    restoreAudio(record);
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
    listen(host, 'move', () => { if (current?.nativeOverlay) place(current); });
    listen(host, 'hide', () => { if (current?.nativeOverlay) place(current); });
    listen(host, 'show', () => { if (current?.nativeOverlay) place(current); });
    listen(host, 'minimize', () => { if (current?.nativeOverlay) place(current); });
    listen(host, 'restore', () => { if (current?.nativeOverlay) place(current); });
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
    const communityUrl = isYoutube ? YOUTUBE_SAMPLE_URL : isBilibili ? BILIBILI_URL : resolveCommunityUrl(env.NEKO_WORKBENCH_COMMUNITY_URL);
    const view = new WebContentsView({ webPreferences: communityWebPreferences(isYoutube ? YOUTUBE_PARTITION : isBilibili ? BILIBILI_PARTITION : COMMUNITY_PARTITION) });
    const record = { host, view, webContents: view.webContents, communityUrl, bounds, requestId,
      epoch: 0, loadId: 0, loading: null, loaded: false, failed: false, wanted: true,
      attached: false, popups: new Set(), responseCode: 0 };
    current = record;
    const contents = record.webContents;
    record.desktopUserAgent = isBilibili ? (bilibiliDesktopUserAgent(contents.getUserAgent?.()) || BILIBILI_DESKTOP_USER_AGENT) : null;
    function setBilibiliAgent() {
      if (!isBilibili) return;
      contents.setUserAgent(record.desktopUserAgent);
    }
    record.setBilibiliAgent = setBilibiliAgent;
    if (isBilibili) setBilibiliAgent();
    record.cleanupNavigation = installCommunityNavigation(view, { communityUrl, parent: host, openExternal, onExternalError, rewriteInternal:isYoutube, blockExternalRedirect:isYoutube,
      classify: url => classify(url, communityUrl), allowAuthPopup: !isBilibili && !isYoutube,
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
      if ((isBilibili || isYoutube) && isMainFrame && current === record && record.wanted) {
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
      await record.webContents.loadURL(url, isYoutube ? { httpReferrer: youtubeIdentity } : undefined);
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
          record.epoch++; record.wanted = false; muteWhileHidden(record); detach(record);
          if (wasWanted) state(record, 'hidden');
        }
      }
      return { ok: true };
    }
    if (request.action === 'layout') {
      if (current) { const wasSmall = current.tooSmall; current.bounds = request.bounds; current.holes=request.holes||[]; place(current); if (isYoutube && wasSmall !== current.tooSmall && current.wanted) state(current, 'ready'); }
      return { ok: true };
    }
    if (request.action === 'back') {
      const record = current;
      if (!record || !record.wanted || record.webContents.isDestroyed()) throw new Error('请先打开内容');
      if (canGoBack(record)) {
        // Keep the desktop identity when returning from the official player.
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
    if (request.action === 'open-youtube-video') {
      const record = current, url = youtubeEmbedUrl(request.videoUrl);
      if (!isYoutube || !record || !record.wanted || !url || record.webContents.isDestroyed()) throw new Error('请先打开 YouTube 播放器并输入有效的视频链接');
      if (record.loading) throw new Error('播放器正在加载，请稍后重试');
      const epoch = record.epoch;
      await load(record, url);
      if (current !== record || !record.wanted || epoch !== record.epoch) throw new Error(CANCEL_ERROR);
      place(record); state(record, 'ready');
      return { ok: true };
    }
    if (request.action === 'open-youtube-shorts') {
      const record = current;
      if (!isYoutube || !record || !record.wanted || record.webContents.isDestroyed()) throw new Error('请先打开 YouTube');
      if (record.loading) throw new Error('页面正在加载，请稍后重试');
      const epoch = record.epoch;
      await load(record, YOUTUBE_SHORTS_URL);
      if (current !== record || !record.wanted || epoch !== record.epoch) throw new Error(CANCEL_ERROR);
      place(record); state(record, 'ready'); return { ok:true };
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
    if (request.bounds) {record.bounds = request.bounds;record.holes=request.holes||[];}
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
    if (isBilibili || isYoutube || !record || record.host !== host || !record.wanted || record.loading || host.isDestroyed()) throw new Error(CANCEL_ERROR);
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
  const controllers = Object.fromEntries(['community', 'bilibili', 'youtube'].map(site => [site,
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
      const result = await controllers[next].action(host, { action: 'open', site: next, slot, bounds: request.bounds, ...(request.holes ? {holes:request.holes} : {}),
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
    get hasVisibleView() { return controllers.community.isOpen || controllers.bilibili.isOpen || controllers.youtube.isOpen; },
    get isOpen() { return controllers.community.isOpen; },
    get view() { return controllers[active].view; } });
}

module.exports = { DEFAULT_COMMUNITY_URL, OFFICIAL_AUTH_ORIGIN, COMMUNITY_PARTITION, BILIBILI_URL, BILIBILI_HOME_URL, BILIBILI_PARTITION, BILIBILI_DESKTOP_USER_AGENT, BILIBILI_PLAYER_ORIGIN, YOUTUBE_PARTITION, YOUTUBE_SAMPLE_URL, YOUTUBE_APP_ID, YOUTUBE_MIN_SIZE,
  resolveCommunityUrl, classifyCommunityNavigation, communityWebPreferences, communityWindowOptions,
  classifyBilibiliNavigation, bilibiliVideoShareUrl, bilibiliOfficialPlayerUrl, youtubeEmbedUrl, classifyYoutubeNavigation, youtubeReferrer, installCommunityNavigation, validateCommunityRequest, communityBounds,
  createCommunityController, createSocialController };
