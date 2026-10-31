// Own navigation only. Native avatar and account React controls keep their
// original owners, parents, login handlers and popup anchoring.
function installWorkbenchSideRail(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const bridge = options.bridge || win?.nekoWorkbench;
  if (!doc?.body || !win?.MutationObserver || typeof bridge?.action !== 'function' ||
      typeof options.openBilibiliHome !== 'function' || doc.querySelector('[data-neko-side-rail]')) return () => {};
  const rail = doc.createElement('aside');
  rail.className = 'neko-side-rail'; rail.dataset.nekoSideRail = '';
  rail.setAttribute('aria-label', '工作台快捷导航');
  const theme = doc.createElement('div'); theme.className = 'neko-side-rail__theme'; theme.setAttribute('aria-hidden', 'true');
  const space = doc.createElement('div'); space.className = 'neko-side-rail__space'; space.setAttribute('aria-hidden', 'true');
  const bottom = doc.createElement('nav'); bottom.className = 'neko-side-rail__bottom'; bottom.setAttribute('aria-label', '视频与养鱼');
  const expand = doc.createElement('button'); expand.type = 'button'; expand.className = 'neko-side-rail__button neko-side-rail__expand';
  expand.setAttribute('aria-label', '展开侧边栏'); expand.title = '展开侧边栏'; expand.hidden = true;
  const expandIcon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  expandIcon.setAttribute('viewBox', '0 0 24 24'); expandIcon.setAttribute('aria-hidden', 'true');
  const expandPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [key, value] of Object.entries({ d: 'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5Zm4.5 0v15M13 9l3 3-3 3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) expandPath.setAttribute(key, value);
  expandIcon.appendChild(expandPath); expand.appendChild(expandIcon);
  const bili = doc.createElement('button'); bili.type = 'button'; bili.className = 'neko-side-rail__button neko-side-rail__bilibili neko-community neko-bilibili';
  bili.dataset.nekoVideoEntry = ''; bili.setAttribute('aria-haspopup', 'menu'); bili.setAttribute('aria-expanded', 'false');
  bili.setAttribute('aria-label', '哔哩哔哩主页'); bili.title = '哔哩哔哩主页';
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [key, value] of Object.entries({ x: 3, y: 6, width: 18, height: 14, rx: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 })) rect.setAttribute(key, value);
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [key, value] of Object.entries({ d: 'M7 2.5 10 6m7-3.5L14 6M8 11v3m8-3v3M9 20l-1 1m7-1 1 1', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' })) path.setAttribute(key, value);
  svg.append(rect, path); bili.appendChild(svg);
  const youtubeIcon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  youtubeIcon.setAttribute('viewBox', '0 0 24 24'); youtubeIcon.setAttribute('aria-hidden', 'true'); youtubeIcon.setAttribute('hidden','');
  const youtubeBox = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [key,value] of Object.entries({x:2,y:5,width:20,height:14,rx:4,fill:'none',stroke:'currentColor','stroke-width':1.7})) youtubeBox.setAttribute(key,value);
  const youtubePlay = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [key,value] of Object.entries({d:'M10 9v6l5-3z',fill:'currentColor'})) youtubePlay.setAttribute(key,value);
  youtubeIcon.append(youtubeBox,youtubePlay); bili.appendChild(youtubeIcon);
  const videoMenu = doc.createElement('div'); videoMenu.className = 'neko-side-rail__video-menu'; videoMenu.id = 'neko-video-platform-menu'; videoMenu.hidden = true;
  videoMenu.setAttribute('role','menu'); videoMenu.setAttribute('aria-label','选择视频平台'); bili.setAttribute('aria-controls',videoMenu.id);
  const videoOptions = {};
  for (const [platform,label] of [['bilibili','B站'],['youtube','YouTube']]) {
    const item = doc.createElement('button'); item.type = 'button'; item.dataset.platform = platform;
    item.setAttribute('role','menuitemradio'); item.textContent = label; videoOptions[platform] = item; videoMenu.appendChild(item);
  }
  const fish = doc.createElement('button'); fish.type = 'button'; fish.className = 'neko-side-rail__button neko-side-rail__fish';
  const fishLabel = (options.fishLabel || '养鱼设置').replace('养鱼界面', '养鱼设置');
  fish.setAttribute('aria-label', fishLabel); fish.title = fishLabel;
  const image = doc.createElement('img'); image.alt = ''; image.draggable = false;
  if (/^data:image\/(?:png|webp|jpeg);base64,/.test(options.fishAvatar || '')) image.src = options.fishAvatar;
  fish.appendChild(image);
  const account = doc.createElement('button'); account.type = 'button'; account.className = 'neko-side-rail__button neko-side-rail__account';
  account.setAttribute('aria-label', '账号与额度'); account.setAttribute('aria-haspopup', 'menu'); account.title = '账号与额度';
  const accountImage = doc.createElement('img'); accountImage.alt = ''; accountImage.draggable = false;
  if (/^data:image\/(?:png|webp|jpeg);base64,/.test(options.accountAvatar || '')) accountImage.src = options.accountAvatar;
  account.appendChild(accountImage);
  const notice = doc.createElement('p'); notice.className = 'neko-side-rail__notice'; notice.hidden = true; notice.setAttribute('role', 'status');
  bottom.append(expand, bili, fish, account); rail.append(theme, space, bottom, notice, videoMenu);
  // The upstream DSH sidebar handle clamps its width like a navigation rail.
  // The left content area is a primary surface, so give it a live grid divider.
  const chatDivider = doc.createElement('div'); chatDivider.className = 'neko-chat-sidebar-divider'; chatDivider.hidden = true;
  chatDivider.tabIndex = 0; chatDivider.setAttribute('role', 'separator'); chatDivider.setAttribute('aria-orientation', 'vertical');
  chatDivider.setAttribute('aria-label', '调整左侧内容和工作区宽度');
  chatDivider.title = '拖动调整宽度 · 双击恢复 3:1 · 方向键调整';
  let preferredRatio = 1, restoreRatio = .75, chatFrame = null, chatCenter = null, oldChatGrid = null, chatDrag = null, lastChatGeometry = null;
  // One remembered width shared by the Chat and Work layouts.
  let gridMode = null;
  let nativeDividerKey = '';
  function postNativeDivider(rect) {
    if (typeof bridge.divider !== 'function') return;
    const key = JSON.stringify(rect); if (key === nativeDividerKey) return; nativeDividerKey = key;
    void Promise.resolve(bridge.divider(rect ? {action:'place',id:'chat',rect} : {action:'remove',id:'chat'})).catch(()=>{});
  }
  const style = doc.createElement('style'); style.dataset.nekoSideRailStyle = ''; style.textContent = options.cssText || '';
  const originalBodyMarker = doc.body.getAttribute('data-neko-side-rail-layout');
  const claimed = new Map(); let stopped = false, queued = false, pending = false, appRoot = null, nativeAccount = null, nativeToggle = null, hiddenFrame = null, previousGrid = null, sidebarDrag = null;
  function releaseFrame() {
    if (!hiddenFrame) return;
    release(hiddenFrame, 'data-neko-sidebar-hidden-grid');
    if (previousGrid?.value) hiddenFrame.style.setProperty('--neko-hidden-grid', previousGrid.value, previousGrid.priority);
    else hiddenFrame.style.removeProperty('--neko-hidden-grid');
    hiddenFrame = null; previousGrid = null;
  }
  function mark(node, name, value = '') {
    if (!node) return;
    if (!claimed.has(node)) claimed.set(node, new Map());
    const attrs = claimed.get(node);
    if (!attrs.has(name)) attrs.set(name, { before: node.getAttribute(name), owned: value });
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  function release(node, name) {
    const attrs = claimed.get(node);
    if (!attrs?.has(name)) return;
    if (node.getAttribute(name) === attrs.get(name).owned) {
      const before = attrs.get(name).before;
      if (before === null) node.removeAttribute(name); else node.setAttribute(name, before);
    }
    attrs.delete(name); if (!attrs.size) claimed.delete(node);
  }
  function clearChatGrid() {
    if (!chatFrame) return;
    if (chatDrag) { const pending = chatDrag; chatDrag = null; preferredRatio = pending.started; delete chatDivider.dataset.dragging; try { chatDivider.releasePointerCapture(pending.id); } catch {} }
    release(chatFrame, 'data-neko-chat-sidebar-grid');
    if (chatCenter) release(chatCenter, 'data-neko-chat-center');
    if (oldChatGrid?.value) chatFrame.style.setProperty('--neko-chat-sidebar-grid', oldChatGrid.value, oldChatGrid.priority);
    else chatFrame.style.removeProperty('--neko-chat-sidebar-grid');
    chatFrame = null; chatCenter = null; oldChatGrid = null; lastChatGeometry = null; chatDivider.hidden = true;
    if (doc.body.hasAttribute('data-neko-workspace-collapsed')) doc.body.removeAttribute('data-neko-workspace-collapsed');
    postNativeDivider(null);
    win.dispatchEvent(new win.Event('resize'));
  }
  function findChatFrame(sidebar) {
    // On current DSH the sidebar slot is display:contents. The grid track is
    // owned by an ancestor whose next track is the native center column.
    for (let item = sidebar; item?.parentElement && item.parentElement !== doc.body; item = item.parentElement) {
      const next = item.nextElementSibling;
      if (next && typeof next.className === 'string' && /(?:^|\s)[^\s]*_centerCol(?:[_-][^\s]+)?(?:\s|$)/.test(next.className)) return { frame:item.parentElement, center:next };
    }
    // Fallback for earlier DSH versions with a direct sidebar/main grid.
    for (let item = sidebar; item?.parentElement && item.parentElement !== doc.body; item = item.parentElement) {
      const parent = item.parentElement;
      if (parent.style.gridTemplateColumns && item.nextElementSibling) return { frame:parent, center:item.nextElementSibling };
    }
    return null;
  }
  function chatGeometry(found, mode) {
    const bounds = found.frame.getBoundingClientRect(), center = found.center.getBoundingClientRect();
    // Exclude an independent native right track (if open) from the 3:1 split.
    const reserve = center.width > 0 && center.right > bounds.left && center.right <= bounds.right ? Math.max(0, bounds.right - center.right) : 0;
    const width = bounds.width - reserve;
    if (!Number.isFinite(width) || width < 240 || bounds.height < 100) return null;
    const min = Math.min(265, width), max = mode === 'office' ? Math.max(min, width - Math.min(320, width * .4)) : width;
    return { bounds, width, min, max };
  }
  function setChatRatio(next) {
    if (!Number.isFinite(next)) return;
    // A small snap area at the edge lets a pointer reach the collapsed state
    // without requiring a pixel-perfect drag to the window boundary.
    if (gridMode === 'social' && lastChatGeometry && next >= 1 - Math.min(24 / lastChatGeometry.width, .06)) next = 1;
    preferredRatio = Math.min(1, Math.max(.01, next));
    schedule();
  }
  function syncChatGrid(sidebar) {
    const found = sidebar && findChatFrame(sidebar);
    const social = doc.body.hasAttribute('data-neko-chatroom-active') || doc.body.hasAttribute('data-neko-side-social-active');
    const active = !doc.body.hasAttribute('data-neko-flex-mode') && found && !sidebar.closest('[data-sidebar-collapsed="true"]');
    const mode = active ? (social ? 'social' : 'office') : null;
    const rawColumns = found?.frame.style.gridTemplateColumns || '';
    const rest = rawColumns.match(/^\s*\S+\s+([\s\S]+)$/)?.[1];
    const geometry = active && rest ? chatGeometry(found, mode) : null;
    if (!geometry) { clearChatGrid(); return; }
    if (gridMode !== mode) {
      const first = gridMode === null;
      clearChatGrid();
      gridMode = mode;
      if (first) {
        const nativeWidth = /^\s*(\d+(?:\.\d+)?)px(?:\s|$)/.exec(rawColumns);
        preferredRatio = nativeWidth ? Number(nativeWidth[1]) / geometry.width : .26;
      }
      // Both modes share one width; switching keeps the current ratio.
    }
    const dividerLabel = mode === 'office' ? '调整项目列表和工作区宽度' : '调整左侧内容和工作区宽度';
    if (chatDivider.getAttribute('aria-label') !== dividerLabel) chatDivider.setAttribute('aria-label', dividerLabel);
    chatDivider.title = mode === 'office' ? '拖动调整宽度 · 双击恢复默认 · 方向键调整' : '拖动调整宽度 · 双击恢复 3:1 · 方向键调整';
    if (chatFrame !== found.frame) {
      clearChatGrid(); chatFrame = found.frame;
      oldChatGrid = { value:chatFrame.style.getPropertyValue('--neko-chat-sidebar-grid'), priority:chatFrame.style.getPropertyPriority('--neko-chat-sidebar-grid') };
    }
    if (chatCenter !== found.center) { if (chatCenter) release(chatCenter, 'data-neko-chat-center'); chatCenter = found.center; }
    mark(chatCenter, 'data-neko-chat-center');
    const actual = Math.max(geometry.min, Math.min(geometry.max, geometry.width * preferredRatio));
    const width = Math.round(actual), grid = `${width}px ${rest}`;
    const collapsed = width >= Math.round(geometry.width);
    if (collapsed !== doc.body.hasAttribute('data-neko-workspace-collapsed')) doc.body.toggleAttribute('data-neko-workspace-collapsed', collapsed);
    const changed = chatFrame.style.getPropertyValue('--neko-chat-sidebar-grid') !== grid || !chatFrame.hasAttribute('data-neko-chat-sidebar-grid');
    if (changed) chatFrame.style.setProperty('--neko-chat-sidebar-grid', grid);
    mark(chatFrame, 'data-neko-chat-sidebar-grid');
    lastChatGeometry = geometry;
    // Keep the full grab target on the sidebar: native WebContentsView panes
    // can otherwise cover the half protruding into the neighboring region.
    for (const [key, value] of Object.entries({ left: `${Math.round(geometry.bounds.left + width - 12)}px`, top:`${Math.round(geometry.bounds.top)}px`, height:`${Math.round(geometry.bounds.height)}px` }))
      if (chatDivider.style[key] !== value) chatDivider.style[key] = value;
    chatDivider.hidden = false;
    postNativeDivider({x:Math.round(geometry.bounds.left + width - 12),y:Math.round(geometry.bounds.top),width:12,height:Math.round(geometry.bounds.height)});
    chatDivider.setAttribute('aria-valuemin', String(Math.round(geometry.min / geometry.width * 100)));
    chatDivider.setAttribute('aria-valuemax', String(Math.round(geometry.max / geometry.width * 100)));
    chatDivider.setAttribute('aria-valuenow', String(Math.round(width / geometry.width * 100)));
    chatDivider.setAttribute('aria-valuetext', `左侧内容 ${Math.round(width / geometry.width * 100)}%，工作区 ${100 - Math.round(width / geometry.width * 100)}%`);
    // Existing workspace/preview and native social view code already reacts to
    // resize; the parent grid's own outer size stays fixed during divider drag.
    if (changed) win.dispatchEvent(new win.Event('resize'));
  }
  function sync() {
    queued = false; if (stopped) return;
    const sidebar = doc.querySelector('[data-slot="sidebar"]');
    syncChatGrid(sidebar);
    const frame = sidebar?.closest('[data-sidebar-collapsed="true"]');
    nativeToggle = frame ? [...sidebar.querySelectorAll('button')].find(button => /^(打开侧边栏|展开侧边栏|open sidebar|expand sidebar)$/i.test((button.getAttribute('aria-label') || button.getAttribute('title') || '').trim())) : null;
    const columns = frame?.style.gridTemplateColumns || '';
    const hiddenColumns = /^\s*\S+\s+/.test(columns) ? columns.replace(/^\s*\S+\s+/, '72px ') : '';
    if (hiddenFrame && (hiddenFrame !== frame || !nativeToggle || !hiddenColumns)) releaseFrame();
    if (frame && nativeToggle && hiddenColumns) {
      if (!hiddenFrame) { hiddenFrame = frame; previousGrid = { value: frame.style.getPropertyValue('--neko-hidden-grid'), priority: frame.style.getPropertyPriority('--neko-hidden-grid') }; }
      if (frame.style.getPropertyValue('--neko-hidden-grid') !== hiddenColumns) frame.style.setProperty('--neko-hidden-grid', hiddenColumns);
      mark(frame, 'data-neko-sidebar-hidden-grid');
    }
    expand.hidden = !hiddenFrame;
    let next = sidebar;
    while (next?.parentElement && next.parentElement !== doc.body) next = next.parentElement;
    if (!next || next === doc.body || next === rail || next.parentElement !== doc.body) next = null;
    if (appRoot !== next) { if (appRoot) release(appRoot, 'data-neko-rail-app'); appRoot = next; }
    if (appRoot) mark(appRoot, 'data-neko-rail-app');
    const nextAccount = doc.querySelector('[data-slot="settings.launcher"] button.hjANda_trigger[aria-haspopup="menu"]');
    if (nativeAccount !== nextAccount) {
      if (nativeAccount) { release(nativeAccount, 'data-neko-rail-account-original'); release(nativeAccount, 'tabindex'); release(nativeAccount, 'aria-hidden'); }
      nativeAccount = nextAccount;
    }
    account.disabled = !nativeAccount;
    if (nativeAccount) {
      mark(nativeAccount, 'data-neko-rail-account-original'); mark(nativeAccount, 'tabindex', '-1');
      mark(nativeAccount, 'aria-hidden', 'true');
      const label = nativeAccount.getAttribute('aria-label') || '账号与额度';
      if (account.getAttribute('aria-label') !== label) account.setAttribute('aria-label', label);
      const expanded = nativeAccount.getAttribute('aria-expanded') === 'true' ? 'true' : 'false';
      if (account.getAttribute('aria-expanded') !== expanded) account.setAttribute('aria-expanded', expanded);
    }
    const selected = new Set();
    for (const button of (appRoot || sidebar)?.querySelectorAll('button') || []) {
      const label = button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent.trim();
      if (label === '养鱼设置') { mark(button, 'data-neko-rail-fish-original'); selected.add(button); }
    }
    for (const [node, attrs] of [...claimed]) if (attrs.has('data-neko-rail-fish-original') && !selected.has(node)) release(node, 'data-neko-rail-fish-original');
  }
  function schedule() { if (stopped || queued) return; queued = true; Promise.resolve().then(sync); }
  async function act(button, callback) {
    if (pending || stopped) return;
    pending = true; button.setAttribute('aria-busy', 'true'); notice.hidden = true;
    try { await callback(); }
    catch { if (!stopped) { notice.textContent = button === bili ? '视频未能打开，请重试' : '养鱼设置未能打开，请重试'; notice.hidden = false; } }
    finally { pending = false; if (!stopped) button.removeAttribute('aria-busy'); }
  }
  let videoPlatform = 'bilibili', videoSelectionRevision = 0, videoMenuTimer = null;
  function showVideoPlatform(platform) {
    videoPlatform = platform === 'youtube' ? 'youtube' : 'bilibili';
    const label = videoPlatform === 'youtube' ? 'YouTube 视频' : '哔哩哔哩主页';
    bili.setAttribute('aria-label', label); bili.title = label + ' · 悬停选择视频平台';
    bili.dataset.videoPlatform = videoPlatform; svg.toggleAttribute('hidden',videoPlatform !== 'bilibili'); youtubeIcon.toggleAttribute('hidden',videoPlatform !== 'youtube');
    for (const [key,item] of Object.entries(videoOptions)) item.setAttribute('aria-checked',String(key === videoPlatform));
  }
  function setVideoMenu(open, focus = false) {
    if (stopped) return;
    if (videoMenuTimer) win.clearTimeout(videoMenuTimer); videoMenuTimer = null;
    videoMenu.hidden = !open; bili.setAttribute('aria-expanded',String(open));
    if (open) { const rect = bili.getBoundingClientRect(); videoMenu.style.top = Math.max(8,Math.min(win.innerHeight - 112,rect.top - 12))+'px'; videoMenu.style.left = Math.max(8, Math.round(rect.left))+'px'; }
    if (focus && open) videoOptions[videoPlatform].focus(); else if (focus) bili.focus();
  }
  function delayVideoMenuClose() { if (videoMenuTimer) win.clearTimeout(videoMenuTimer); videoMenuTimer = win.setTimeout(() => setVideoMenu(false),220); }
  function openVideo() {
    return act(bili, () => {
      const detail = {platform:videoPlatform,handled:false,promise:null};
      doc.dispatchEvent(new win.CustomEvent('neko-video-open',{detail}));
      if (detail.handled) return detail.promise;
      if (videoPlatform === 'bilibili') return options.openBilibiliHome();
      if (typeof options.openYoutubeHome === 'function') return options.openYoutubeHome();
      throw new Error('视频入口暂不可用');
    });
  }
  const onBili = () => { setVideoMenu(false); void openVideo(); };
  const onVideoEnter = () => setVideoMenu(true);
  const onVideoLeave = event => { if (videoMenu.contains(doc.activeElement) || event.relatedTarget && (videoMenu.contains(event.relatedTarget) || bili.contains(event.relatedTarget))) return; delayVideoMenuClose(); };
  const onVideoFocusOut = event => { if (!videoMenu.hidden && event.relatedTarget && !videoMenu.contains(event.relatedTarget) && event.relatedTarget !== bili) setVideoMenu(false); };
  const onVideoKey = event => {
    if (event.key === 'Escape' && !videoMenu.hidden) { event.preventDefault(); event.stopPropagation(); setVideoMenu(false,true); }
    else if (event.key === 'ArrowDown' && event.target === bili) { event.preventDefault(); setVideoMenu(true,true); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && videoMenu.contains(event.target)) { event.preventDefault(); const items = Object.values(videoOptions), index=items.indexOf(doc.activeElement); items[(index+(event.key==='ArrowDown'?1:items.length-1))%items.length].focus(); }
  };
  const onVideoSelect = async event => {
    const item = event.target.closest?.('[data-platform]'); if (!item || !videoMenu.contains(item)) return;
    const selected = item.dataset.platform; if (!['bilibili','youtube'].includes(selected)) return;
    ++videoSelectionRevision; showVideoPlatform(selected); setVideoMenu(false,true);
    let saveFailed = false;
    if (typeof bridge.workspace === 'function') try { await bridge.workspace({action:'set-video-platform',platform:selected}); }
    catch { saveFailed = true; }
    if (!stopped) { await openVideo(); if (saveFailed) { notice.textContent = '视频平台设置未能保存，本次仍可使用'; notice.hidden = false; } }
  };
  const onVideoOutside = event => { if (!videoMenu.hidden && !videoMenu.contains(event.target) && !bili.contains(event.target)) setVideoMenu(false); };
  showVideoPlatform('bilibili');
  if (typeof bridge.workspace === 'function') {
    const revision = videoSelectionRevision;
    Promise.resolve().then(() => bridge.workspace({action:'video-platform'})).then(value => { if (!stopped && revision === videoSelectionRevision) showVideoPlatform(value?.platform); }).catch(() => {});
  }
  const onExpand = () => { if (!stopped && nativeToggle?.isConnected) nativeToggle.click(); };
  const onDragStart = event => {
    const handle = event.target?.closest?.('[data-side="sidebar"]');
    if (event.button !== 0 || !handle) return;
    const sidebar = doc.querySelector('[data-slot="sidebar"]');
    if (!sidebar || !handle.parentElement?.contains(sidebar)) return;
    sidebarDrag = { pointerId: event.pointerId, frame: handle.parentElement };
  };
  const onDragEnd = event => {
    const drag = sidebarDrag; sidebarDrag = null;
    if (!drag || drag.pointerId !== event.pointerId || event.type !== 'pointerup' || stopped) return;
    const sidebar = doc.querySelector('[data-slot="sidebar"]');
    const close = [...(sidebar?.querySelectorAll('button') || [])].find(button => /^(收起侧边栏|关闭侧边栏|close sidebar|collapse sidebar)$/i.test((button.getAttribute('aria-label') || button.getAttribute('title') || '').trim()));
    if (close && event.clientX - drag.frame.getBoundingClientRect().left < 160) close.click();
  };
  const onFish = () => act(fish, () => bridge.action('fish-settings'));
  const onAccount = () => {
    if (!nativeAccount?.isConnected || stopped) return;
    options.beforeAccount?.(); nativeAccount.click();
  };
  const onFocus = event => {
    if (event.target !== nativeAccount) return;
    Promise.resolve().then(() => { if (!stopped && nativeAccount?.getAttribute('aria-expanded') !== 'true') account.focus(); });
  };
  const onChatDown = event => {
    if (event.button !== 0 || !lastChatGeometry || chatDrag) return;
    if (preferredRatio < 1) restoreRatio = preferredRatio;
    chatDrag = { id:event.pointerId, started:preferredRatio }; chatDivider.dataset.dragging = 'true';
    try { chatDivider.setPointerCapture(event.pointerId); } catch {} event.preventDefault();
  };
  const onChatMove = event => {
    if (!chatDrag || chatDrag.id !== event.pointerId || !lastChatGeometry) return;
    const { bounds, width, min, max } = lastChatGeometry;
    setChatRatio(Math.max(min, Math.min(max, event.clientX - bounds.left)) / width); event.preventDefault();
  };
  const onChatEnd = event => {
    if (!chatDrag || chatDrag.id !== event.pointerId) return;
    const cancelled = event.type !== 'pointerup', previous = chatDrag.started; chatDrag = null; delete chatDivider.dataset.dragging;
    try { chatDivider.releasePointerCapture(event.pointerId); } catch {}
    setChatRatio(cancelled ? previous : preferredRatio);
    if (!cancelled && preferredRatio < 1) restoreRatio = preferredRatio;
  };
  const onChatKey = event => {
    if (!lastChatGeometry || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const { width, min, max } = lastChatGeometry, current = Math.max(min, Math.min(max, preferredRatio * width));
    const pixels = event.key === 'Home' ? min : event.key === 'End' ? max : current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 48 : 12);
    const next = Math.max(min, Math.min(max, pixels)) / width;
    if (next >= 1 && preferredRatio < 1) restoreRatio = preferredRatio;
    else if (next < 1) restoreRatio = next;
    event.preventDefault(); setChatRatio(next);
  };
  const onChatReset = () => setChatRatio(gridMode === 'office' ? .32 : .75);
  const onWorkspaceExpand = () => { if (doc.body.hasAttribute('data-neko-workspace-collapsed')) setChatRatio(restoreRatio < 1 ? restoreRatio : .75); };
  doc.addEventListener('neko-workspace-expand', onWorkspaceExpand);
  const unsubscribeNativeDivider = typeof bridge.subscribeDivider === 'function' ? bridge.subscribeDivider(event => {
    if (event?.id !== 'chat' || !lastChatGeometry) return;
    if (event.type === 'start') { if (!chatDrag) { if (preferredRatio < 1) restoreRatio = preferredRatio; chatDrag = {id:'native',started:preferredRatio}; chatDivider.dataset.dragging='true'; } }
    else if (event.type === 'move' && chatDrag?.id === 'native' && Number.isFinite(event.x)) {
      const {bounds,width,min,max}=lastChatGeometry; setChatRatio(Math.max(min,Math.min(max,event.x-bounds.left))/width);
    } else if ((event.type === 'end' || event.type === 'cancel') && chatDrag?.id === 'native') {
      const previous=chatDrag.started; chatDrag=null; delete chatDivider.dataset.dragging;
      if (event.type === 'cancel') setChatRatio(previous);
      else { if (event.click) setChatRatio(previous); else if (Number.isFinite(event.x)) { const {bounds,width,min,max}=lastChatGeometry; setChatRatio(Math.max(min,Math.min(max,event.x-bounds.left))/width); } if (preferredRatio < 1) restoreRatio = preferredRatio; chatDivider.focus(); }
    } else if (event.type === 'reset') onChatReset();
    else if (event.type === 'key') onChatKey({key:event.key,shiftKey:event.shift,preventDefault(){}});
  }) : null;
  chatDivider.addEventListener('pointerdown', onChatDown); chatDivider.addEventListener('pointermove', onChatMove);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) chatDivider.addEventListener(type, onChatEnd);
  chatDivider.addEventListener('keydown', onChatKey); chatDivider.addEventListener('dblclick', onChatReset);
  win.addEventListener('resize', schedule);
  expand.addEventListener('click', onExpand); bili.addEventListener('click', onBili); fish.addEventListener('click', onFish);
  bili.addEventListener('mouseenter',onVideoEnter); bili.addEventListener('mouseleave',onVideoLeave); bili.addEventListener('keydown',onVideoKey);
  videoMenu.addEventListener('mouseenter',onVideoEnter); videoMenu.addEventListener('mouseleave',onVideoLeave); videoMenu.addEventListener('keydown',onVideoKey); videoMenu.addEventListener('click',onVideoSelect); videoMenu.addEventListener('focusout',onVideoFocusOut);
  doc.addEventListener('pointerdown',onVideoOutside,true);
  account.addEventListener('click', onAccount); doc.addEventListener('focusin', onFocus);
  doc.addEventListener('pointerdown', onDragStart, true); doc.addEventListener('pointerup', onDragEnd); doc.addEventListener('pointercancel', onDragEnd);
  doc.head.appendChild(style); doc.body.prepend(rail); doc.body.appendChild(chatDivider); doc.body.setAttribute('data-neko-side-rail-layout', '');
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-expanded', 'data-sidebar-collapsed', 'data-neko-chatroom-active', 'data-neko-side-social-active', 'data-neko-flex-mode', 'style'] });
  sync();
  return () => {
    if (stopped) return; stopped = true; observer.disconnect();
    expand.removeEventListener('click', onExpand); bili.removeEventListener('click', onBili); fish.removeEventListener('click', onFish);
    bili.removeEventListener('mouseenter',onVideoEnter); bili.removeEventListener('mouseleave',onVideoLeave); bili.removeEventListener('keydown',onVideoKey);
    videoMenu.removeEventListener('mouseenter',onVideoEnter); videoMenu.removeEventListener('mouseleave',onVideoLeave); videoMenu.removeEventListener('keydown',onVideoKey); videoMenu.removeEventListener('click',onVideoSelect); videoMenu.removeEventListener('focusout',onVideoFocusOut); doc.removeEventListener('pointerdown',onVideoOutside,true); if (videoMenuTimer) win.clearTimeout(videoMenuTimer);
    account.removeEventListener('click', onAccount); doc.removeEventListener('focusin', onFocus);
    doc.removeEventListener('pointerdown', onDragStart, true); doc.removeEventListener('pointerup', onDragEnd); doc.removeEventListener('pointercancel', onDragEnd);
    win.removeEventListener('resize', schedule); clearChatGrid(); if (typeof unsubscribeNativeDivider === 'function') unsubscribeNativeDivider();
    doc.removeEventListener('neko-workspace-expand', onWorkspaceExpand);
    releaseFrame();
    for (const [node, attrs] of [...claimed]) for (const name of [...attrs.keys()]) release(node, name);
    if (doc.body.getAttribute('data-neko-side-rail-layout') === '') {
      if (originalBodyMarker === null) doc.body.removeAttribute('data-neko-side-rail-layout');
      else doc.body.setAttribute('data-neko-side-rail-layout', originalBodyMarker);
    }
    rail.remove(); chatDivider.remove(); style.remove();
  };
}
