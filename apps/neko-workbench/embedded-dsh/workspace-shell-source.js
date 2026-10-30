function installWorkspaceShell(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const bridge = options.bridge || win?.nekoWorkbench;
  if (!doc?.body || !win?.MutationObserver || typeof bridge?.workspace !== 'function' || typeof bridge.companion !== 'function' || doc.querySelector('[data-neko-workspace-shell]')) return () => {};
  const el = (tag, className, text) => { const n = doc.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, className, click) => { const n = el('button', className, label); n.type = 'button'; if (click) n.addEventListener('click', click); return n; };
  const image = (src, className) => { const n = el('img', className); n.alt = ''; n.draggable = false; if (src) n.src = src; return n; };
  const avatar = id => options.avatar?.(id) || '';
  const style = el('style'); style.dataset.nekoWorkspaceShell = ''; style.textContent = options.cssText || ''; doc.head.appendChild(style);
  let disposed = false, queued = false, layout = null, state = null, catalog = null, selectedProject = '', selectedId = null, searchText = '', layoutVersion = -1, listLoading = false, sending = false, socialOpen = false;
  let startupOpen = true, startupSearchText = '', catalogError = '', startupError = '', startupOpening = false;
  let nativeNewPending = false, nativeNewTimer = null, nativeNewBefore = null;
  let office = { status: 'idle', thread: null, items: [], approvals: [], error: '' };
  const nativeMarks = new Map(), nodes = [], releases = [], drafts = new Map(), groupOpen = new Set(), startupCollapsed = new Set();
  const modelChoices = new Map();
  const currentModelChoice = () => modelChoices.get(selectedId || 'new') || { model: null, effort: null };
  function rememberModelChoice(key, choice) {
    modelChoices.delete(key); modelChoices.set(key, { ...choice });
    while (modelChoices.size > 200) modelChoices.delete(modelChoices.keys().next().value);
    call({ action: 'codex-model-choice', id: key, ...choice }).catch(() => { if (!disposed) showOfficeError(Error('模型选择未能保存到本机，本次发送仍使用当前选择')); });
  }
  let codexModels = [], modelsState = 'idle', modelsError = '', modelRenderKey = '', officeErrorText = '', officeReading = false, sendContext = null;
  const effortLabel = value => ({ none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '极高', ultra: '最高' })[value] || value;
  const own = node => { node.dataset.nekoWorkspaceOwned = ''; nodes.push(node); return node; };
  const call = request => bridge.workspace(request);
  // The controller projects this flag without altering saved seat or session data.
  const codexPaused = () => layout?.codexAvailable === false;
  const hideSocial = () => { options.hideSocial?.(); socialOpen = false; };
  function markNative(node, name) { if (!node) return; if (!nativeMarks.has(node)) nativeMarks.set(node, new Map()); const attrs = nativeMarks.get(node); if (!attrs.has(name)) attrs.set(name, node.getAttribute(name)); if (!node.hasAttribute(name)) node.setAttribute(name, ''); }
  const railTop = own(el('div', 'neko-workspace-rail-controls'));
  const officeButton = own(button('', 'neko-side-rail__button neko-office-switch', () => openSettings('office')));
  officeButton.setAttribute('aria-label', '切换工作界面'); officeButton.title = '切换 DSH / Codex 工作界面';
  const officeImage = image(avatar('bigfish')); officeButton.appendChild(officeImage);
  const settingsButton = button('⚙', 'neko-side-rail__button neko-workspace-settings', () => openSettings('general'));
  settingsButton.setAttribute('aria-label', '工作台设置'); settingsButton.title = '工作台设置';
  const communityButton = button('', 'neko-side-rail__button neko-community neko-community-yui', () => { closeSettings(); lobby?.hide(); Promise.resolve(options.openCommunity?.()).catch(showError); });
  communityButton.setAttribute('aria-label', 'Yui · N.E.K.O. 社区'); communityButton.title = 'N.E.K.O. 原生社区'; communityButton.appendChild(image(avatar('yui')));
  railTop.append(settingsButton, communityButton);
  // Lobby (频道): optional. Without bridge.lobby there is no button and no panel. It never touches the dock.
  const lobby = typeof bridge.lobby === 'function' ? createLobbyView({ doc, bridge, el, button, image, avatar, composer: options.lobbyComposer || (typeof WORKBENCH_LOBBY_COMPOSER !== 'undefined' ? WORKBENCH_LOBBY_COMPOSER : null) || win.WorkbenchLobbyComposer || null, companion: () => state?.companion, onOpen: () => { hideSocial(); closeSettings(); }, onChange: () => { renderOffice(); schedule(); } }) : null;
  if (lobby) { own(lobby.panel); railTop.appendChild(lobby.railButton); releases.push(lobby.dispose); }
  const leaveViews = () => { hideSocial(); lobby?.hide(); };
  // The room is a local visual preview. It never touches the work session or
  // the saved multi-pane layout. The original sidebar stays mounted behind it.
  const previewFactory = options.createChatroomPreview || (typeof createChatroomPreview === 'function' ? createChatroomPreview : null);
  const roomPreview = previewFactory ? own(previewFactory(doc, avatar, { mountHome: options.mountHome })) : null;
  if (roomPreview?.disposeHome) releases.push(() => roomPreview.disposeHome());
  let roomActive = !!roomPreview, roomSelection = !!roomPreview, sideSocial = false, initialRoomResolved = false;
  let flexSocialRect = null, flexSocialKey = '';
  function onFlexSocialGeometry(event) {
    const rect = event.detail, key = JSON.stringify([rect || null,doc.body.hasAttribute('data-neko-flex-social-hidden')]); if (key === flexSocialKey) return;
    flexSocialKey = key; flexSocialRect = rect || null;
    if (rect) for (const [name, value] of Object.entries(rect)) doc.body.style.setProperty('--neko-social-'+name, Math.round(value)+'px');
    else for (const name of ['x','y','width','height']) doc.body.style.removeProperty('--neko-social-'+name);
    schedule();
  }
  doc.addEventListener('neko-flex-social-geometry', onFlexSocialGeometry);
  const roomInert = new Set();
  const roomButton = roomPreview && button('', 'neko-side-rail__button neko-room-entry', () => setRoomActive(true));
  const workButton = roomPreview && button('', 'neko-side-rail__button neko-room-workspace', () => setRoomActive(false));
  if (roomPreview) {
    roomPreview.hidden = true;
    for (const [control, label] of [[roomButton, '聊天室'], [workButton, '工作区']]) { control.title = label; control.setAttribute('aria-label', label); }
    for (const [control, path] of [[roomButton, 'M4 5.5h16v11H9l-4 3v-3H4z M8 9h8 M8 12h5'], [workButton, 'M4 6h6l2 2h8v11H4z M4 6V4.5h6l2 1.5']]) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'), shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      for (const [key, value] of Object.entries({ d:path, fill:'none', stroke:'currentColor', 'stroke-width':'1.7', 'stroke-linecap':'round', 'stroke-linejoin':'round' })) shape.setAttribute(key, value);
      svg.appendChild(shape); control.appendChild(svg);
    }
    railTop.prepend(roomButton, workButton); doc.body.appendChild(roomPreview);
    doc.body.setAttribute('data-neko-chatroom-active', '');
  }
  function releaseRoomInert() { for (const node of roomInert) if (node.hasAttribute('inert')) node.removeAttribute('inert'); roomInert.clear(); }
  function protectRoomFooter(sidebar, account) {
    // Never inert the original main companion/account footer. Mark only the
    // branches that are wholly behind the preview and restore our marks later.
    // The original native tools nav remains in the sidebar DOM even when its
    // overlay is positioned elsewhere. Exempt only its path while it is open.
    const tools = sidebar.querySelector('nav[data-neko-tools="open"]');
    function visit(node) {
      if (node === dock || node === account || node.hasAttribute('data-neko-companion-footer')) return;
      if (tools && node === tools) { if (roomInert.delete(node)) node.removeAttribute('inert'); return; }
      if (node.contains(dock) || account && node.contains(account) || tools && node.contains(tools)) {
        if (roomInert.delete(node)) node.removeAttribute('inert');
        for (const child of node.children) visit(child); return;
      }
      if (!node.hasAttribute('inert')) { node.setAttribute('inert', ''); roomInert.add(node); }
    }
    for (const child of sidebar.children) visit(child);
  }
  function setRoomActive(active, { closeSocial = true } = {}) {
    if (!roomPreview || disposed) return;
    if (closeSocial && sideSocial) doc.dispatchEvent(new win.Event('neko-side-surface-close'));
    if (closeSocial) { sideSocial = false; roomSelection = !!active; }
    roomActive = !!active;
    if (roomActive) { doc.body.setAttribute('data-neko-chatroom-active', ''); doc.querySelector('.neko-side-rail__expand:not([hidden])')?.click(); }
    else { doc.body.removeAttribute('data-neko-chatroom-active'); roomPreview.hidden = true; releaseRoomInert(); }
    roomButton.setAttribute('aria-pressed', String(roomActive)); workButton.setAttribute('aria-pressed', String(!roomActive));
    doc.dispatchEvent(new win.Event('neko-chatroom-mode-change'));
    schedule();
  }
  function sideSurfaceChanged(event) {
    const surface = event.detail?.surface;
    if (surface === 'community' || surface === 'bilibili') {
      sideSocial = true;
      setRoomActive(false, { closeSocial: false });
      roomButton?.setAttribute('aria-pressed', 'false'); workButton?.setAttribute('aria-pressed', 'false');
    } else if (surface === 'hidden' && sideSocial) {
      sideSocial = false;
      setRoomActive(roomSelection, { closeSocial: false });
    }
  }
  doc.addEventListener('neko-side-surface-change', sideSurfaceChanged);
  function showWorkspaceFromLayout() { setRoomActive(false); }
  if (roomPreview) { roomButton.setAttribute('aria-pressed', 'true'); workButton.setAttribute('aria-pressed', 'false'); doc.addEventListener('neko-chatroom-show-workspace', showWorkspaceFromLayout); }
  const seats = own(el('div', 'neko-custom-seats')); seats.setAttribute('role', 'group'); seats.setAttribute('aria-label', '自定义工作 agent');
  const sessionBrowser = own(el('section', 'neko-session-browser')); sessionBrowser.setAttribute('aria-label', '全部工作会话');
  const listHeader = el('div', 'neko-session-browser__header');
  const allButton = button('全部工作会话', 'neko-session-all', () => saveLayout({ activeSeatId: null }));
  const refreshButton = button('↻', 'neko-session-refresh', () => refreshCatalog(true)); refreshButton.setAttribute('aria-label', '刷新本地工作会话');
  listHeader.append(allButton, refreshButton);
  const search = el('input', 'neko-session-search'); search.type = 'search'; search.placeholder = '搜索工作会话或项目'; search.setAttribute('aria-label', '搜索工作会话或项目'); search.addEventListener('input', () => { searchText = search.value.toLowerCase(); renderCatalog(); });
  const listStatus = el('p', 'neko-session-status'), projectList = el('div', 'neko-project-list');
  listStatus.setAttribute('role', 'status'); listStatus.setAttribute('aria-live', 'polite');
  sessionBrowser.append(listHeader, search, listStatus, projectList);
  // This is an ephemeral navigation surface over the existing work view. It
  // never starts a task, modifies drafts or changes the persisted pane layout.
  const startup = own(el('section', 'neko-startup')); startup.setAttribute('aria-label', '选择工作项目或会话');
  const startupInner = el('div', 'neko-startup__inner');
  const startupHead = el('header', 'neko-startup__header');
  const startupHeading = el('div'); startupHeading.append(el('h1', '', '选择工作内容'), el('p', '', '打开已有项目中的工作会话'));
  // A live native binding is required: saved selection alone may still be
  // awaiting startup restoration, or point to an unavailable session.
  const startupContinue = button('继续当前工作', 'neko-startup__continue', () => { if (hasActiveDshSession()) closeStartup(); });
  startupContinue.hidden = true;
  startupHead.append(startupHeading, startupContinue);
  const startupSearch = el('input', 'neko-startup__search'); startupSearch.type = 'search'; startupSearch.placeholder = '搜索项目或会话'; startupSearch.setAttribute('aria-label', '搜索项目或会话');
  startupSearch.addEventListener('input', () => { startupSearchText = startupSearch.value.toLowerCase(); renderStartup(); });
  const startupToolbar = el('div', 'neko-startup__toolbar'), startupTitle = el('strong', '', '本地工作项目');
  const startupRefresh = button('刷新', 'neko-startup__refresh', () => refreshCatalog(true));
  startupToolbar.append(startupTitle, startupRefresh);
  const startupStatus = el('p', 'neko-startup__status', '正在读取本地工作会话…'); startupStatus.setAttribute('role', 'status'); startupStatus.setAttribute('aria-live', 'polite');
  const startupProjects = el('div', 'neko-startup__projects');
  startupInner.append(startupHead, startupSearch, startupToolbar, startupStatus, startupProjects); startup.appendChild(startupInner); doc.body.appendChild(startup);
  function stopNativeNew() { nativeNewPending = false; if (nativeNewTimer !== null) win.clearTimeout(nativeNewTimer); nativeNewTimer = null; }
  function beginNativeNew() {
    stopNativeNew(); nativeNewBefore = nativeSelection()?.sessionId || null; nativeNewPending = true;
    nativeNewTimer = win.setTimeout(() => { nativeNewPending = false; nativeNewTimer = null; schedule(); }, 10000);
  }
  function nativeSelection() { try { const value = options.getDshSelection?.(); return value && typeof value === 'object' ? value : null; } catch { return null; } }
  function hasActiveDshSession() { try { return layout?.officeMode === 'dsh' && options.hasDshActiveSession?.() === true; } catch { return false; } }
  function closeStartup() { startupOpen = false; startup.hidden = true; }
  function showStartup() { startupOpen = true; renderStartup(); schedule(); }
  function showNativeToolsPage() { closeStartup(); }
  doc.addEventListener('neko-native-tools-navigate', showNativeToolsPage);
  function renderStartup() {
    if (!startupOpen || disposed) return;
    startupRefresh.disabled = listLoading || startupOpening; startupContinue.disabled = startupOpening;
    startupProjects.setAttribute('aria-busy', String(listLoading || startupOpening));
    const rows = (catalog?.sessions || []).filter(row => (row.title + ' ' + row.cwd + ' ' + row.provider).toLowerCase().includes(startupSearchText));
    const groups = new Map();
    for (const row of rows) {
      const key = row.provider + ':' + row.cwd;
      if (!groups.has(key)) groups.set(key, { cwd: row.cwd, provider: row.provider, sessions: [] });
      groups.get(key).sessions.push(row);
    }
    startupProjects.replaceChildren(...[...groups.entries()].map(([key, group]) => {
      const section = el('section', 'neko-startup__project'), projectRow = el('div', 'neko-startup__project-row');
      const header = button('', 'neko-startup__project-header', () => { if (startupCollapsed.has(key)) startupCollapsed.delete(key); else startupCollapsed.add(key); renderStartup(); });
      const expanded = !startupCollapsed.has(key); header.setAttribute('aria-expanded', String(expanded));
      const label = group.cwd?.split(/[\\\\/]/).filter(Boolean).at(-1) || '未指定项目';
      const title = el('strong', '', label); title.title = group.cwd || '未指定项目';
      header.append(title, el('span', 'neko-startup__provider', group.provider.toUpperCase())); projectRow.appendChild(header);
      const projectNew = button('新会话', 'neko-startup__project-new', async () => {
        if (startupOpening) return;
        startupOpening = true; startupError = ''; renderStartup();
        try { await openProject(group); }
        catch (error) { startupError = error?.message || '项目未能打开，请重试'; }
        finally { startupOpening = false; renderStartup(); }
      });
      projectNew.setAttribute('aria-label', '在 ' + label + ' 新建工作会话');
      projectNew.disabled = !group.cwd || startupOpening || group.provider === 'codex' && (codexPaused() || catalog?.providers?.codex === 'testing');
      if (!group.cwd) projectNew.title = '该会话未关联项目';
      else if (group.provider === 'codex' && projectNew.disabled) projectNew.title = 'Codex 测试中，暂不可用';
      projectRow.appendChild(projectNew); section.appendChild(projectRow);
      for (const row of expanded ? group.sessions : []) {
        const item = button('', 'neko-startup__session', async () => {
          if (startupOpening) return;
          startupOpening = true; startupError = ''; renderStartup();
          try { if (await openSession(row)) closeStartup(); }
          catch (error) { startupError = error?.message || '会话未能打开，请重试'; }
          finally { startupOpening = false; renderStartup(); }
        });
        item.append(el('span', '', row.title), el('span', 'neko-startup__arrow', '›')); item.title = row.title;
        if (row.provider === 'codex' && (codexPaused() || catalog?.providers?.codex === 'testing')) { item.disabled = true; item.title = 'Codex 测试中，暂不可用'; item.firstChild.textContent += ' · 测试中'; }
        if (startupOpening) item.disabled = true;
        section.appendChild(item);
      }
      return section;
    }));
    if (catalog?.nextDshOffset != null) startupProjects.appendChild(button('加载更多 DSH 会话', 'neko-startup__more', () => refreshCatalog(true, catalog.nextDshOffset)));
    const unavailable = Object.entries(catalog?.providers || {}).filter(([, status]) => status !== 'ready' && status !== 'testing').map(([name]) => name.toUpperCase());
    const notices = [];
    if (startupError || catalogError) notices.push(startupError || catalogError);
    else if (listLoading) notices.push('正在读取本地工作会话…');
    else if (!rows.length) notices.push(startupSearchText ? '没有匹配的项目或会话' : '暂无可显示的工作会话');
    if (unavailable.length) notices.push(unavailable.join('、') + ' 会话暂不可读取');
    if (catalog?.providers?.codex === 'testing' || codexPaused()) notices.push('Codex 测试中，暂不可用');
    startupStatus.textContent = notices.join(' · ');
  }
  const dock = own(el('section', 'neko-companion-dock')); dock.setAttribute('aria-label', '主 agent 聊天');
  const character = el('div', 'neko-companion-character');
  character.setAttribute('role', 'slider'); character.tabIndex = 0; character.setAttribute('aria-label', '大肥鱼，点击打开互动菜单，左右方向键移动'); character.setAttribute('aria-orientation', 'horizontal'); character.title = '点击互动 · 左右拖动 · Home 回到中间';
  let companionOffset = 0, companionDrag = null, suppressCompanionClick = false, companionInRail = false, dockIntersecting = null, observedDockParent = null;
  function setCompanionOffset(value) {
    const width = dock.clientWidth || dock.getBoundingClientRect().width;
    const spriteWidth = character.offsetWidth || 76;
    const limit = Math.max(0, Math.floor(Math.min(48, (width - spriteWidth) / 2 - 8)));
    companionOffset = Math.round(Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0)));
    character.style.setProperty('--neko-companion-offset', companionOffset + 'px');
    character.setAttribute('aria-valuemin', String(-Math.floor(limit))); character.setAttribute('aria-valuemax', String(Math.floor(limit))); character.setAttribute('aria-valuenow', String(companionOffset));
    character.setAttribute('aria-valuetext', companionOffset === 0 ? '居中' : (companionOffset < 0 ? '向左 ' : '向右 ') + Math.abs(companionOffset) + ' 像素');
  }
  character.addEventListener('pointerdown', event => {
    if (event.button !== 0 || companionDrag || companionInRail) return;
    suppressCompanionClick = false;
    setCompanionOffset(companionOffset); companionDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: companionOffset, moved: false };
    character.dataset.dragging = 'true'; event.preventDefault();
    try { character.setPointerCapture(event.pointerId); } catch {}
  });
  character.addEventListener('pointermove', event => {
    if (!companionDrag || companionDrag.pointerId !== event.pointerId) return;
    if (!companionDrag.moved && Math.hypot(event.clientX - companionDrag.x, event.clientY - companionDrag.y) > 5) { companionDrag.moved = true; closeCompanionMenu(false); }
    setCompanionOffset(companionDrag.offset + event.clientX - companionDrag.x);
  });
  const finishCompanionDrag = event => { if (!companionDrag || companionDrag.pointerId !== event.pointerId) return; suppressCompanionClick = companionDrag.moved || event.type !== 'pointerup'; companionDrag = null; character.removeAttribute('data-dragging'); try { character.releasePointerCapture(event.pointerId); } catch {} };
  character.addEventListener('pointerup', finishCompanionDrag); character.addEventListener('pointercancel', finishCompanionDrag); character.addEventListener('lostpointercapture', finishCompanionDrag);
  character.addEventListener('dragstart', event => event.preventDefault());
  character.addEventListener('click', event => {
    if (companionInRail) return;
    if (suppressCompanionClick) { suppressCompanionClick = false; event.preventDefault(); return; }
    if (event.button === 0) toggleCompanionMenu(character);
  });
  character.addEventListener('keydown', event => {
    if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); toggleCompanionMenu(character); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); setCompanionOffset(event.key === 'Home' ? 0 : companionOffset + (event.key === 'ArrowLeft' ? -8 : 8));
  });
  const characterPoster = image(options.companionPosterSrc || avatar('bigfish'), 'neko-companion-poster');
  character.appendChild(characterPoster);
  const motion = win.matchMedia?.('(prefers-reduced-motion: reduce)'); let characterVideo = null, videoFailed = false;
  if (options.companionVideoSrc) {
    characterVideo = el('video', 'neko-companion-video'); characterVideo.muted = characterVideo.defaultMuted = true;
    characterVideo.autoplay = true; characterVideo.loop = true; characterVideo.playsInline = true; characterVideo.preload = 'metadata';
    characterVideo.setAttribute('muted', ''); characterVideo.setAttribute('playsinline', ''); characterVideo.setAttribute('aria-hidden', 'true'); characterVideo.hidden = true;
    characterVideo.addEventListener('error', () => { videoFailed = true; syncCharacter(); });
    characterVideo.addEventListener('playing', () => { if (!videoFailed && !motion?.matches && doc.visibilityState !== 'hidden') { characterVideo.hidden = false; characterPoster.hidden = true; } });
    characterVideo.src = options.companionVideoSrc; character.appendChild(characterVideo);
  }
  function syncCharacter() {
    if (!characterVideo) return;
    const paused = videoFailed || motion?.matches || doc.visibilityState === 'hidden';
    if (paused) { characterVideo.pause(); characterVideo.hidden = true; characterPoster.hidden = false; }
    else { try { characterVideo.play()?.catch(() => { characterPoster.hidden = false; characterVideo.hidden = true; }); } catch {} }
  }
  motion?.addEventListener?.('change', syncCharacter); doc.addEventListener('visibilitychange', syncCharacter);
  const history = el('div', 'neko-companion-history'); history.id = 'neko-companion-history'; history.hidden = true; history.tabIndex = 0; history.setAttribute('role', 'log'); history.setAttribute('aria-label', '主 agent 最近聊天记录'); history.setAttribute('aria-live', 'polite');
  const chatStatus = el('div', 'neko-companion-status'); chatStatus.hidden = true;
  const chatStatusText = el('span'); chatStatusText.setAttribute('role', 'status'); chatStatusText.setAttribute('aria-live', 'polite');
  const chatSetup = button('聊天设置', 'neko-companion-setup', async () => { try { await bridge.action('chat-settings'); } catch (error) { chatError = error.message || '聊天设置未能打开'; renderCompanion(); } });
  const chatRecover = button('恢复失败内容', 'neko-companion-recover', () => {
    const failedText = state?.companion?.failedText;
    if (!failedText || chatInput.value.trim()) return;
    chatInput.value = failedText; chatInput.focus(); renderCompanion();
  });
  chatSetup.hidden = chatRecover.hidden = true; chatStatus.append(chatStatusText, chatSetup, chatRecover);
  const form = el('form', 'neko-companion-form'), chatInput = el('textarea'); chatInput.rows = 1; chatInput.placeholder = '说点什么…'; chatInput.maxLength = 8000; chatInput.setAttribute('aria-label', '给主 agent 的消息');
  const chatSend = el('button', '', '↑'); chatSend.type = 'submit'; chatSend.setAttribute('aria-label', '发送给主 agent');
  let historyPeek = false;
  const historyToggle = button('', 'neko-companion-history-toggle', () => {
    const open = !!layout?.companionHistoryOpen || historyPeek;
    historyPeek = false; saveLayout({ companionHistoryOpen: !open });
  });
  historyToggle.setAttribute('aria-controls', history.id); historyToggle.setAttribute('aria-label', '展开聊天记录'); historyToggle.title = '展开聊天记录'; historyToggle.setAttribute('aria-expanded', 'false');
  const historyIcon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); historyIcon.setAttribute('viewBox', '0 0 24 24'); historyIcon.setAttribute('aria-hidden', 'true');
  const historyPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); historyPath.setAttribute('d', 'M4 5h16v11H9l-5 4V5Zm4 4h8M8 12h5'); historyIcon.appendChild(historyPath); historyToggle.appendChild(historyIcon);
  const chatStop = button('■', 'neko-companion-stop', () => bridge.companion({ action: 'stop' }).catch(error => { chatError = error.message || '未能停止回复'; renderCompanion(); })); chatStop.setAttribute('aria-label', '停止回复'); chatStop.title = '停止回复'; chatStop.hidden = true;
  form.append(historyToggle, chatInput, chatSend, chatStop); dock.append(character, history, form, chatStatus);
  // Move the existing animated character, rather than creating another pet.
  // The chat and its draft stay mounted in the original dock throughout.
  function focusCompanionChat() {
    const expand = doc.querySelector('.neko-side-rail__expand');
    if (expand && !expand.hidden) expand.click();
    dock.scrollIntoView?.({ block: 'nearest' }); chatInput.focus();
  }
  const railCompanion = own(button('', 'neko-side-rail__button neko-rail-companion', () => {
    if (suppressRailClick) { suppressRailClick = false; return; }
    toggleCompanionMenu(railCompanion);
  }));
  railCompanion.hidden = true; railCompanion.title = '点击互动 · 拖动位置 · 方向键移动';
  railCompanion.setAttribute('aria-label', '大肥鱼互动菜单，可拖动，方向键移动');
  let railSpace = null, railSpaceBeforeAria = null, railX = null, railY = null, railDrag = null;
  let railWalkTimer = null, suppressRailClick = false, railClickTimer = null, lastRailSize = '';
  function railBounds() {
    if (!railSpace) return null;
    const space = railSpace.getBoundingClientRect(), pet = railCompanion.getBoundingClientRect();
    if (space.width <= 0 || space.height <= 0) return null;
    return { space, x: Math.max(0, space.width - (pet.width || Math.min(44, space.width))), y: Math.max(0, space.height - (pet.height || Math.min(52, space.height))) };
  }
  function stopRailWalking() { if (railWalkTimer !== null) win.clearTimeout(railWalkTimer); railWalkTimer = null; }
  function setRailPosition(x, y, duration = 0) {
    const bounds = railBounds(); if (!bounds) return;
    railX = Math.max(0, Math.min(bounds.x, Number.isFinite(x) ? x : bounds.x / 2));
    railY = Math.max(0, Math.min(bounds.y, Number.isFinite(y) ? y : 0));
    railCompanion.style.transition = duration > 0 ? `left ${duration}ms linear, top ${duration}ms linear` : 'none';
    railCompanion.style.left = railX + 'px'; railCompanion.style.top = railY + 'px';
  }
  function syncRailWalking() {
    stopRailWalking();
    if (disposed || !companionInRail || railCompanion.hidden || railDrag || !companionMenu.hidden) return;
    if (motion?.matches || doc.visibilityState === 'hidden') { freezeRailPosition(); return; }
    const bounds = railBounds(); if (!bounds) return;
    if (railX === null || railY === null) setRailPosition(bounds.x / 2, 0);
    if (bounds.x < 1 && bounds.y < 1) return;
    railWalkTimer = win.setTimeout(() => {
      railWalkTimer = null;
      const current = railBounds();
      if (!current || disposed || !companionInRail || railCompanion.hidden || motion?.matches || doc.visibilityState === 'hidden' || railDrag || !companionMenu.hidden) return;
      const x = Math.random() * current.x, y = Math.random() * current.y;
      const duration = Math.max(1200, Math.min(12000, Math.hypot(x - railX, y - railY) / 20 * 1000));
      setRailPosition(x, y, duration);
      railWalkTimer = win.setTimeout(syncRailWalking, duration + 1800);
    }, 1800);
  }
  function freezeRailPosition() {
    const bounds = railBounds(); if (!bounds) return;
    const pet = railCompanion.getBoundingClientRect();
    setRailPosition(pet.left - bounds.space.left, pet.top - bounds.space.top);
  }
  railCompanion.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !companionInRail || !railSpace || railDrag) return;
    stopRailWalking(); freezeRailPosition(); suppressRailClick = false;
    railDrag = { id:event.pointerId, x:event.clientX, y:event.clientY, left:railX, top:railY, moved:false };
    try { railCompanion.setPointerCapture(event.pointerId); } catch {}
  });
  railCompanion.addEventListener('pointermove', event => {
    if (!railDrag || railDrag.id !== event.pointerId) return;
    const dx = event.clientX - railDrag.x, dy = event.clientY - railDrag.y;
    if (!railDrag.moved && Math.hypot(dx, dy) > 5) { railDrag.moved = true; closeCompanionMenu(false); railCompanion.dataset.dragging = 'true'; }
    if (railDrag.moved) { event.preventDefault(); setRailPosition(railDrag.left + dx, railDrag.top + dy); }
  });
  function finishRailDrag(event) {
    if (!railDrag || railDrag.id !== event.pointerId) return;
    const moved = railDrag.moved || event.type !== 'pointerup'; railDrag = null; delete railCompanion.dataset.dragging;
    suppressRailClick = moved;
    if (railClickTimer !== null) win.clearTimeout(railClickTimer);
    railClickTimer = win.setTimeout(() => { suppressRailClick = false; railClickTimer = null; }, 0);
    try { railCompanion.releasePointerCapture(event.pointerId); } catch {}
    syncRailWalking();
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) railCompanion.addEventListener(type, finishRailDrag);
  railCompanion.addEventListener('keydown', event => {
    if (!companionInRail || !railSpace || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); stopRailWalking(); freezeRailPosition(); const bounds = railBounds(); if (!bounds) return;
    setRailPosition(event.key === 'ArrowLeft' ? railX - 8 : event.key === 'ArrowRight' ? railX + 8 : railX,
      event.key === 'Home' ? 0 : event.key === 'End' ? bounds.y : event.key === 'ArrowUp' ? railY - 8 : event.key === 'ArrowDown' ? railY + 8 : railY);
    syncRailWalking();
  });
  const companionMenu = own(el('div', 'neko-companion-menu')); companionMenu.id = 'neko-companion-menu'; companionMenu.hidden = true;
  companionMenu.setAttribute('role', 'menu'); companionMenu.setAttribute('aria-label', '大肥鱼互动');
  const visitButton = button('社区串门', 'neko-companion-menu__visit', async () => {
    if (visitButton.disabled) return;
    visitButton.disabled = true; visitButton.setAttribute('aria-busy', 'true'); companionMenuStatus.textContent = '';
    try {
      if (typeof options.openCommunity !== 'function') throw Error('社区入口暂不可用，请稍后重试');
      closeSettings(); await options.openCommunity(); if (!disposed) closeCompanionMenu(false);
    } catch (error) { if (!disposed) companionMenuStatus.textContent = error?.message || '社区暂时无法打开，请重试'; }
    finally { visitButton.disabled = false; visitButton.removeAttribute('aria-busy'); }
  });
  const companionChatButton = button('和我聊聊', 'neko-companion-menu__chat', () => { closeCompanionMenu(false); focusCompanionChat(); });
  for (const item of [visitButton, companionChatButton]) item.setAttribute('role', 'menuitem');
  const companionMenuStatus = el('p', 'neko-companion-menu__status'); companionMenuStatus.setAttribute('role', 'status');
  companionMenu.append(visitButton, companionChatButton, companionMenuStatus); doc.body.appendChild(companionMenu);
  let companionMenuAnchor = null;
  for (const trigger of [character, railCompanion]) { trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-controls', companionMenu.id); trigger.setAttribute('aria-expanded', 'false'); }
  function closeCompanionMenu(restoreFocus = true) {
    if (companionMenu.hidden) return;
    companionMenu.hidden = true;
    for (const trigger of [character, railCompanion]) trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && companionMenuAnchor?.isConnected) companionMenuAnchor.focus();
    companionMenuAnchor = null;
    syncRailWalking();
  }
  function positionCompanionMenu() {
    if (companionMenu.hidden || !companionMenuAnchor) return;
    const r = companionMenuAnchor.getBoundingClientRect(), width = companionMenu.offsetWidth || 180, height = companionMenu.offsetHeight || 100;
    const left = Math.max(8, Math.min(r.left, win.innerWidth - width - 8));
    const top = Math.max(8, Math.min(r.top >= height + 14 ? r.top - height - 6 : r.bottom + 6, win.innerHeight - height - 8));
    Object.assign(companionMenu.style, { left: left + 'px', top: top + 'px' });
  }
  function toggleCompanionMenu(anchor) {
    if (!companionMenu.hidden) { closeCompanionMenu(); return; }
    if (anchor === railCompanion) { stopRailWalking(); freezeRailPosition(); }
    companionMenuAnchor = anchor; companionMenuStatus.textContent = ''; companionMenu.hidden = false;
    for (const trigger of [character, railCompanion]) trigger.setAttribute('aria-expanded', 'true');
    positionCompanionMenu(); (visitButton.disabled ? companionChatButton : visitButton).focus();
  }
  companionMenu.addEventListener('keydown', event => {
    const items = [visitButton, companionChatButton].filter(item => !item.disabled);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const index = items.indexOf(doc.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === 'Tab') closeCompanionMenu(false);
  });
  function dismissCompanionMenu(event) { if (!companionMenu.contains(event.target) && !character.contains(event.target) && !railCompanion.contains(event.target)) closeCompanionMenu(false); }
  doc.addEventListener('pointerdown', dismissCompanionMenu, true);
  function syncCompanionPlacement(rail) {
    if (!rail) return;
    const connected = dock.isConnected;
    let visible = connected && dockIntersecting !== false;
    for (let node = dock; visible && node && node !== doc.body; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || node.getAttribute('data-sidebar-collapsed') === 'true') visible = false;
    }
    if (visible) {
      const r = dock.getBoundingClientRect();
      visible = r.width > 0 && r.height > 0 && r.right > 0 && r.left < win.innerWidth && r.bottom > 0 && r.top < win.innerHeight;
    }
    const needsRail = !visible;
    const changed = needsRail !== companionInRail || (needsRail && character.parentNode !== railCompanion);
    if (changed) {
      closeCompanionMenu(false);
      companionInRail = needsRail;
      if (needsRail) {
        companionDrag = null; character.removeAttribute('data-dragging');
        character.setAttribute('aria-hidden', 'true'); character.tabIndex = -1;
        railCompanion.appendChild(character);
      } else {
        character.removeAttribute('aria-hidden'); character.tabIndex = 0;
        dock.prepend(character); setCompanionOffset(companionOffset);
      }
      syncCharacter();
    }
    if (railCompanion.hidden !== !needsRail) railCompanion.hidden = !needsRail;
    if (changed) {
      if (!needsRail) { stopRailWalking(); railDrag = null; delete railCompanion.dataset.dragging; }
      else { setRailPosition(railX, railY); syncRailWalking(); }
    }
  }
  motion?.addEventListener?.('change', syncRailWalking);
  doc.addEventListener('visibilitychange', syncRailWalking);
  let historyKey = '', chatError = '';
  form.addEventListener('submit', async event => {
    event.preventDefault(); const text = chatInput.value.trim(); if (!text || sending || state?.companion?.working) return;
    chatError = '';
    if (!state?.companion?.ready) { try { await bridge.action('chat-settings'); } catch (error) { chatError = error.message || '请从左上角设置连接聊天'; } renderCompanion(); return; }
    const draft = chatInput.value; sending = true; renderCompanion();
    try { await bridge.companion({ action: 'send', text }); historyPeek = true; if (chatInput.value === draft) chatInput.value = ''; }
    catch (error) { chatError = error.message || '消息未发送，请重试'; }
    finally { sending = false; renderCompanion(); }
  });
  chatInput.addEventListener('input', renderCompanion);
  chatInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
  const panel = own(el('section', 'neko-office-panel')); panel.hidden = true; panel.setAttribute('aria-label', 'Codex 工作界面');
  const officeHeader = el('header', 'neko-office-header'); const officeTitle = el('strong', '', 'Codex'); const officeModel = el('span', 'neko-office-model');
  const projectButton = button('选择项目', 'neko-office-project', async () => { try { const cwd = await call({ action: 'choose-project' }); if (cwd) { selectedProject = cwd; renderOffice(); } } catch (error) { showOfficeError(error); } });
  const newButton = button('＋', 'neko-office-new', () => newOffice()); newButton.setAttribute('aria-label', '新建 Codex 工作会话');
  officeHeader.append(image(avatar('devcat'), 'neko-office-brand'), officeTitle, officeModel, projectButton, newButton);
  const officeHistory = el('div', 'neko-office-history'); officeHistory.setAttribute('role', 'log'); officeHistory.setAttribute('aria-label', 'Codex 工作会话记录');
  const officeError = el('p', 'neko-office-error'); officeError.setAttribute('role', 'status');
  const officeApprovals = el('div', 'neko-office-approvals');
  const officeForm = el('form', 'neko-office-form'), officeInput = el('textarea'); officeInput.rows = 3; officeInput.maxLength = 30000; officeInput.placeholder = '给 Codex 分配工作任务…'; officeInput.setAttribute('aria-label', 'Codex 工作任务');
  const modelControls = el('div', 'neko-office-controls');
  const modelLabel = el('label', 'neko-office-control', '模型'), modelSelect = el('select', 'neko-office-model-select'); modelSelect.setAttribute('aria-label', 'Codex 模型'); modelLabel.appendChild(modelSelect);
  const effortLabelNode = el('label', 'neko-office-control', '思考'), effortSelect = el('select', 'neko-office-effort-select'); effortSelect.setAttribute('aria-label', 'Codex 思考强度'); effortLabelNode.appendChild(effortSelect);
  const modelsRefresh = button('↻', 'neko-office-model-refresh', () => refreshModels(true)); modelsRefresh.setAttribute('aria-label', '刷新 Codex 模型列表'); modelsRefresh.title = '从 Codex 重新读取模型列表';
  const modelsStatus = el('p', 'neko-office-model-status'); modelsStatus.setAttribute('role', 'status'); modelsStatus.setAttribute('aria-live', 'polite');
  modelControls.append(modelLabel, effortLabelNode, modelsRefresh);
  const officeFooter = el('div', 'neko-office-form-footer'), officeCaption = el('span', '', 'Codex 原生执行层 · 沿用本机配置');
  const stopButton = button('停止', 'neko-office-stop', () => call({ action: 'codex-stop' }).catch(showOfficeError));
  const sendButton = el('button', 'neko-office-send', '发送'); sendButton.type = 'submit';
  officeFooter.append(officeCaption, stopButton, sendButton); officeForm.append(officeInput, modelControls, modelsStatus, officeFooter);
  panel.append(officeHeader, officeHistory, officeError, officeApprovals, officeForm); doc.body.appendChild(panel);
  officeInput.addEventListener('input', () => drafts.set(selectedId || 'new', officeInput.value));
  let officeSending = false, officeRenderKey = '', readVersion = 0;
  modelSelect.addEventListener('change', () => { rememberModelChoice(selectedId || 'new', { model: modelSelect.value || null, effort: null }); renderOffice(); });
  effortSelect.addEventListener('change', () => { rememberModelChoice(selectedId || 'new', { ...currentModelChoice(), effort: effortSelect.value || null }); renderOffice(); });
  officeForm.addEventListener('submit', async event => {
    event.preventDefault(); const message = officeInput.value.trim(); if (!message || officeSending || officeReading || office.status === 'working' || sendButton.disabled) return;
    const key = selectedId || 'new', version = readVersion, draft = officeInput.value, choice = { ...currentModelChoice() };
    officeSending = true; sendContext = { id: selectedId, version }; officeErrorText = ''; renderOffice();
    try {
      const next = await call({ action: 'codex-send', id: selectedId, cwd: office.thread?.cwd || selectedProject || state?.workspaceRoot, message, ...choice });
      if (drafts.get(key) === draft) drafts.delete(key);
      if (version === readVersion) { office = next; selectedId = next.thread?.id || selectedId; if (selectedId) rememberModelChoice(selectedId, choice); if (officeInput.value === draft) officeInput.value = ''; }
      else office.approvals = next.approvals || [];
      renderOffice(); refreshCatalog(true);
    } catch (error) { if (version === readVersion) showOfficeError(error); }
    finally { officeSending = false; sendContext = null; renderOffice(); }
  });
  officeInput.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); officeForm.requestSubmit(); } });
  const modal = own(el('div', 'neko-workspace-modal')); modal.hidden = true; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  // Keep the native composer mounted in its original React tree when the
  // workspace is collapsed. A CSS marker changes its presentation only.
  const expandWorkspace = own(button('展开工作区', 'neko-workspace-expand-control', () => doc.dispatchEvent(new win.Event('neko-workspace-expand'))));
  expandWorkspace.hidden = true; expandWorkspace.setAttribute('data-neko-workspace-expand-control', ''); doc.body.appendChild(expandWorkspace);
  const collapseNotice = own(el('p', 'neko-workspace-collapse-notice')); collapseNotice.setAttribute('role', 'status'); collapseNotice.hidden = true; doc.body.appendChild(collapseNotice);
  let collapsedComposer = null, collapseGeometry = '', collapseNoticeTimer = null;
  let floatingComposer = null, floatingGeometry = '', floatingState = '', floatingRecoveryPending = false, floatingInitialized = false;
  const hasNativeComposerBridge = typeof bridge.nativeComposer === 'function' && typeof bridge.subscribeNativeComposer === 'function';
  function recoverFloatingComposer() {
    if (disposed || floatingRecoveryPending || !doc.body.hasAttribute('data-neko-flex-workspace-collapsed')) return;
    floatingRecoveryPending = true;
    collapseNotice.textContent = '浮动输入暂不可用，已展开工作区'; collapseNotice.hidden = false;
    if (collapseNoticeTimer) win.clearTimeout(collapseNoticeTimer);
    collapseNoticeTimer = win.setTimeout(() => { collapseNotice.hidden = true; }, 3500);
    doc.dispatchEvent(new win.Event('neko-workspace-expand'));
  }
  function floatingCall(request) {
    if (!hasNativeComposerBridge) return;
    try { Promise.resolve(bridge.nativeComposer(request)).then(result => { if (request.action === 'place' && result?.ok === false) recoverFloatingComposer(); }).catch(() => { if (request.action === 'place') recoverFloatingComposer(); }); }
    catch { if (request.action === 'place') recoverFloatingComposer(); }
  }
  function updateFloatingComposer(state, extra = {}) {
    if (!floatingInitialized || !hasNativeComposerBridge) return;
    const available = layout?.officeMode === 'dsh' && state?.available === true;
    const next = { value:typeof state?.draft === 'string' ? state.draft.slice(0, 30000) : '', enabled:available, busy:state?.phase != null && state.phase !== 'plain', sessionToken:typeof state?.sessionId === 'string' ? state.sessionId : '', revision:Number.isSafeInteger(state?.revision) && state.revision >= 0 ? state.revision : 0, placeholder:available ? '发消息或创建任务…' : '请先打开可用的工作会话', status:state?.reason || state?.status || '', ...extra };
    const key = JSON.stringify(next); if (key === floatingState && !Object.keys(extra).length) return;
    floatingState = key; floatingCall({action:'update',state:next});
  }
  if (typeof createNativeComposerAdapter === 'function' && options.nativeComposerBindings) {
    floatingComposer = createNativeComposerAdapter({ ...options.nativeComposerBindings, onChange: state => updateFloatingComposer(state) });
  }
  if (hasNativeComposerBridge) {
    try {
      const off = bridge.subscribeNativeComposer(event => {
        if (!floatingInitialized || !event || typeof event.type !== 'string') return;
        if (event.type === 'expand') { if (doc.body.hasAttribute('data-neko-flex-workspace-collapsed')) doc.dispatchEvent(new win.Event('neko-workspace-expand')); return; }
        if (event.type === 'unavailable') { recoverFloatingComposer(); return; }
        if (!['edit','submit'].includes(event.type)) return;
        const request = {sessionId:event.sessionToken, revision:event.revision, text:event.value};
        let result;
        if (!floatingComposer || layout?.officeMode !== 'dsh') result = {ok:false,code:'unavailable',state:floatingComposer?.snapshot()};
        else if (event.type === 'edit') result = floatingComposer.write(request);
        else if (lobby?.isOpen()) result = {ok:false,code:'lobby_open',state:floatingComposer.snapshot()};
        else {
          const state = floatingComposer.snapshot();
          result = state.draft !== event.value ? {ok:false,code:'draft_changed',state} : floatingComposer.submit(request);
        }
        const state = result.state || floatingComposer?.snapshot();
        if (event.type === 'edit') updateFloatingComposer(state, {settledEditId:event.editId, editConflict:!result.ok, status:result.ok ? '' : '原工作区草稿已变化，请展开工作区处理'});
        else updateFloatingComposer(state, {settledSubmitId:event.submissionId, status:result.ok ? (state?.status || '已交给工作区处理') : result.code === 'already_submitted' ? '这条消息已交给工作区，请展开查看或重试' : result.code === 'lobby_open' ? '已切换到公共大厅，返回工作区后再发送' : '工作会话或草稿已变化，请检查后重试'});
      });
      if (typeof off === 'function') releases.push(off);
    } catch { /* Missing bridge is handled as unavailable. */ }
  }
  function syncFloatingComposer() {
    const flex = doc.body.hasAttribute('data-neko-flex-workspace-collapsed');
    if (!flex || lobby?.isOpen()) { if (floatingGeometry) floatingCall({action:'remove'}); floatingGeometry = ''; floatingState = ''; floatingRecoveryPending = false; return; }
    if (!hasNativeComposerBridge) { recoverFloatingComposer(); return; }
    const style = doc.body.style;
    const width = Math.min(480, parseFloat(style.getPropertyValue('--neko-flex-compact-width')) || 0);
    const right = parseFloat(style.getPropertyValue('--neko-flex-compact-right')) || 0;
    const bottom = parseFloat(style.getPropertyValue('--neko-flex-compact-bottom')) || 0;
    if (width >= 100) {
      const rect = {x:Math.max(0,Math.round(win.innerWidth-right-width)),y:Math.max(0,Math.round(win.innerHeight-bottom-76)),width:Math.round(width),height:76};
      const key = JSON.stringify(rect); if (key !== floatingGeometry) { floatingInitialized = true; floatingGeometry = key; floatingCall({action:'place',rect}); }
      updateFloatingComposer(floatingComposer?.snapshot());
    }
  }
  const collapseResize = win.ResizeObserver ? new win.ResizeObserver(() => schedule()) : null;
  function notifyCollapseGeometry() {
    const rect = node => { const r = node.getBoundingClientRect(); return [r.left,r.top,r.width,r.height].map(Math.round); };
    const key = JSON.stringify([collapsedComposer && rect(collapsedComposer), !expandWorkspace.hidden && rect(expandWorkspace)]);
    if (key !== collapseGeometry) { collapseGeometry = key; doc.dispatchEvent(new win.Event('neko-collapsed-composer-geometry')); }
  }
  function clearCollapsedComposer() {
    if (collapsedComposer) { collapseResize?.unobserve(collapsedComposer); collapsedComposer.removeAttribute('data-neko-collapsed-composer'); collapsedComposer = null; }
    expandWorkspace.hidden = true; notifyCollapseGeometry();
  }
  function syncCollapsedComposer() {
    const flexCollapsed = doc.body.hasAttribute('data-neko-flex-workspace-collapsed');
    syncFloatingComposer();
    if (flexCollapsed) { clearCollapsedComposer(); return; }
    if (!doc.body.hasAttribute('data-neko-workspace-collapsed') && !flexCollapsed) { clearCollapsedComposer(); return; }
    if (!layout) return;
    const center = doc.querySelector(flexCollapsed ? '[data-neko-flex-coding]' : '[data-neko-chat-center]');
    const next = layout.officeMode === 'codex' ? (codexPaused() ? null : officeForm) : center?.querySelector('[data-composer-seat]');
    const editor = next?.querySelector('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    if (!next || !editor || next.closest('[inert]')) {
      clearCollapsedComposer();
      collapseNotice.textContent = '暂时无法显示工作输入框，已展开工作区'; collapseNotice.hidden = false;
      if (collapseNoticeTimer) win.clearTimeout(collapseNoticeTimer);
      collapseNoticeTimer = win.setTimeout(() => { collapseNotice.hidden = true; }, 3500);
      doc.dispatchEvent(new win.Event('neko-workspace-expand')); return;
    }
    if (next !== collapsedComposer) { clearCollapsedComposer(); collapsedComposer = next; next.setAttribute('data-neko-collapsed-composer', ''); collapseResize?.observe(next); }
    expandWorkspace.hidden = false;
    const r = next.getBoundingClientRect();
    const top = Math.max(12, Math.round(r.top - 42));
    if (expandWorkspace.style.top !== `${top}px`) expandWorkspace.style.top = `${top}px`;
    notifyCollapseGeometry();
  }
  const modalCard = el('section', 'neko-workspace-modal__card'), modalHeader = el('header'), modalTitle = el('h2');
  const modalClose = button('×', 'neko-workspace-modal__close', closeSettings); modalClose.setAttribute('aria-label', '关闭工作台设置');
  modalHeader.append(modalTitle, modalClose); const modalBody = el('div', 'neko-workspace-modal__body'); modalCard.append(modalHeader, modalBody); modal.appendChild(modalCard); doc.body.appendChild(modal);
  modal.addEventListener('pointerdown', event => { if (event.target === modal) closeSettings(); });
  function showError(error) { listStatus.textContent = error?.message || '工作台操作未完成，请重试'; }
  function showOfficeError(error) { officeErrorText = error?.message || 'Codex 操作未完成，请重试'; officeError.textContent = officeErrorText; }
  async function refreshModels(force = false) {
    if (disposed || codexPaused() || modelsState === 'loading' || !force && modelsState !== 'idle') return;
    modelsState = 'loading'; modelsError = ''; renderOffice();
    try {
      const next = await call({ action: 'codex-models', force });
      if (!Array.isArray(next?.models)) throw Error('Codex 模型列表暂不可用');
      if (!disposed) { codexModels = next.models; modelsState = 'ready'; }
    } catch { if (!disposed) { modelsState = 'error'; modelsError = '模型列表读取失败，可刷新重试，或沿用本机默认'; } }
    if (!disposed) renderOffice();
  }
  async function saveLayout(patch) {
    if (codexPaused() && patch.officeMode === 'codex') { showError(Error('Codex 测试中，暂不可用')); return false; }
    try { layout = await call({ action: 'update', patch }); renderLayout(); return true; }
    catch (error) { showError(error); return false; }
  }
  async function newSeatSession(seat) {
    if (!seat.provider) { openSettings('seat', seat.id); return; }
    if (seat.provider === 'codex' && codexPaused()) { showError(Error('Codex 测试中，暂不可用')); return; }
    hideSocial(); closeSettings();
    if (!await saveLayout({ activeSeatId: seat.id, officeMode: seat.provider })) return;
    if (seat.provider === 'codex') { selectedProject = seat.projectRoot || state?.workspaceRoot || ''; newOffice(); return; }
    if (!seat.projectRoot) { showStartup(); return; }
    try {
      if (typeof options.openDshNew !== 'function') throw Error('无法打开 DSH 工作界面，请重试');
      beginNativeNew(); await options.openDshNew(seat.projectRoot); closeStartup();
    } catch (error) { stopNativeNew(); showError(error); }
  }
  function renderLayout() {
    if (!layout || disposed) return;
    officeImage.src = avatar(layout.officeMode === 'codex' ? 'devcat' : 'bigfish');
    officeButton.setAttribute('aria-label', '工作界面：' + (layout.officeMode === 'codex' ? 'Codex' : 'DSH') + '，点击切换');
    officeButton.title = codexPaused() ? '工作界面设置 · Codex 测试中' : '切换 DSH / Codex 工作界面';
    doc.body.setAttribute('data-neko-office-mode', layout.officeMode);
    const active = layout.activeSeatId;
    seats.replaceChildren(...layout.seats.map(seat => {
      const row = el('div', 'neko-custom-seat'); row.dataset.active = String(active === seat.id);
      const pick = button('', 'neko-custom-seat__pick', () => {
        if (!seat.provider) { openSettings('seat', seat.id); return; }
        if (seat.provider === 'codex' && codexPaused()) return;
        leaveViews();
        saveLayout({ activeSeatId: seat.id, officeMode: seat.provider });
      });
      if (seat.provider === 'codex' && codexPaused()) { pick.disabled = true; pick.title = 'Codex 测试中，暂不可用'; pick.setAttribute('aria-label', seat.name + '，Codex 测试中，暂不可用'); }
      pick.setAttribute('aria-pressed', String(active === seat.id));
      pick.append(image(seat.avatarId === 'custom' ? seat.customDataUrl : avatar(seat.avatarId)), el('span', 'neko-custom-seat__name', seat.name));
      const add = button('+', 'neko-custom-seat__new', () => newSeatSession(seat));
      add.setAttribute('aria-label', '新建 ' + seat.name + ' 工作会话'); add.title = seat.provider ? '新建 ' + seat.name + ' 工作会话' : '先配置 ' + seat.name;
      if (seat.provider === 'codex' && codexPaused()) { add.disabled = true; add.title = 'Codex 测试中，暂不可用'; add.setAttribute('aria-label', '新建 ' + seat.name + ' 工作会话，Codex 测试中，暂不可用'); }
      const settings = button('⋯', 'neko-custom-seat__settings', () => openSettings('seat', seat.id)); settings.setAttribute('aria-label', '配置工作 agent：' + seat.name);
      row.append(pick, add, el('span', 'neko-custom-seat__provider', seat.provider === 'codex' && codexPaused() ? '测试中' : seat.provider?.toUpperCase() || '未绑定'), settings); return row;
    }));
    renderCatalog(); renderCompanion(); renderOffice(); place();
  }
  function renderCatalog() {
    if (!layout) { renderStartup(); return; }
    const seat = layout.seats.find(s => s.id === layout.activeSeatId);
    allButton.textContent = seat ? seat.name + ' 的工作项目' : '全部工作会话'; allButton.setAttribute('aria-pressed', String(!seat));
    const rows = (catalog?.sessions || []).filter(s => (!seat || s.provider === seat.provider && (!seat.projectRoot || s.cwd === seat.projectRoot)) && (!searchText || (s.title + ' ' + s.cwd + ' ' + s.provider).toLowerCase().includes(searchText)));
    const groups = new Map();
    for (const item of rows) { const key = item.provider + ':' + item.cwd; if (!groups.has(key)) groups.set(key, { provider: item.provider, cwd: item.cwd, sessions: [] }); groups.get(key).sessions.push(item); }
    projectList.replaceChildren(...[...groups].map(([key, group]) => {
      const section = el('section', 'neko-workspace-project'), heading = el('div', 'neko-workspace-project__heading');
      const name = group.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '未指定项目';
      const folder = button('▾ ' + name, 'neko-workspace-project__name', () => { if (groupOpen.has(key)) groupOpen.delete(key); else groupOpen.add(key); renderCatalog(); });
      folder.title = group.cwd || '未指定项目';
      heading.append(folder, el('span', 'neko-workspace-project__provider', group.provider.toUpperCase())); section.appendChild(heading);
      if (!groupOpen.has(key)) for (const row of group.sessions) {
        const link = button(row.title, 'neko-workspace-session', () => openSession(row).catch(showError));
        link.title = row.title; link.dataset.selected = String(row.provider === 'codex' && row.id === selectedId);
        if (row.provider === 'codex' && codexPaused()) { link.disabled = true; link.title = 'Codex 测试中，暂不可用'; link.textContent += ' · 测试中'; }
        section.appendChild(link);
      }
      return section;
    }));
    if (catalog?.nextDshOffset != null) projectList.appendChild(button('加载更多 DSH 会话', 'neko-workspace-more', () => refreshCatalog(true, catalog.nextDshOffset)));
    const unavailable = Object.entries(catalog?.providers || {}).filter(([, status]) => status !== 'ready' && status !== 'testing').map(([name]) => name.toUpperCase());
    refreshButton.setAttribute('aria-busy', String(listLoading)); projectList.setAttribute('aria-busy', String(listLoading));
    listStatus.textContent = listLoading ? '正在读取本地工作会话…' : unavailable.length ? unavailable.join('、') + ' 会话暂不可读取，可刷新重试' : codexPaused() ? 'Codex 测试中，暂不可用' : rows.length ? '' : seat && !seat.provider ? '请配置这个工作 agent' : '暂无匹配的工作会话';
    renderStartup();
  }
  async function refreshCatalog(force = false, dshOffset = 0) {
    if (disposed || listLoading) return;
    listLoading = true; catalogError = ''; renderCatalog();
    try { const next = await call({ action: 'catalog', force, dshOffset }); if (!disposed) catalog = next; }
    catch (error) { catalogError = '工作会话读取失败，请刷新重试'; showError(error); }
    finally { listLoading = false; if (!disposed) renderCatalog(); }
  }
  function sessionPatch(row) {
    // Keep the selected sidebar agent compatible with the chosen session.
    // Prefer the current compatible seat, then a project-specific or general
    // seat. If none is bound, show all sessions instead of a misleading filter.
    const seatsForProvider = (layout?.seats || []).filter(seat => seat.provider === row.provider && (!seat.projectRoot || seat.projectRoot === row.cwd));
    const selectedSeat = seatsForProvider.find(seat => seat.id === layout?.activeSeatId) || seatsForProvider.find(seat => seat.projectRoot === row.cwd) || seatsForProvider.find(seat => !seat.projectRoot);
    return { officeMode: row.provider, activeSeatId: selectedSeat?.id || null };
  }
  async function openProject(group) {
    if (!group.cwd) throw Error('该项目没有可用目录');
    if (group.provider === 'codex' && codexPaused()) throw Error('Codex 测试中，暂不可用');
    leaveViews(); closeSettings();
    if (!await saveLayout(sessionPatch(group))) throw Error('无法切换工作界面，请重试');
    if (group.provider === 'dsh') {
      if (typeof options.openDshNew !== 'function') throw Error('无法打开 DSH 工作项目，请重试');
      beginNativeNew(); try { await options.openDshNew(group.cwd); closeStartup(); } catch (error) { stopNativeNew(); throw error; }
    } else if (group.provider === 'codex') { selectedProject = group.cwd; newOffice(); }
    else throw Error('不支持的工作平台');
  }
  async function openSession(row) {
    if (row.provider === 'codex' && codexPaused()) { showError(Error('Codex 测试中，暂不可用')); return false; }
    leaveViews(); closeSettings();
    const patch = sessionPatch(row);
    if (row.provider === 'dsh') {
      if (!await saveLayout(patch)) throw Error('无法切换 DSH 工作界面，请重试');
      if (typeof options.openDshSession !== 'function') throw Error('无法打开 DSH 工作会话，请重试');
      await options.openDshSession(row.id); closeStartup(); return true;
    }
    else {
      const version = ++readVersion; selectedId = row.id; selectedProject = row.cwd; officeInput.value = drafts.get(row.id) || ''; officeReading = true; officeErrorText = '';
      if (!await saveLayout(patch)) throw Error('无法切换 Codex 工作界面，请重试'); officeError.textContent = '正在读取原生 Codex 会话…';
      try { const next = await call({ action: 'codex-read', id: row.id }); if (!disposed && version === readVersion) office = next; }
      catch (error) { if (!disposed && version === readVersion) showOfficeError(error); throw error; }
      finally { if (!disposed && version === readVersion) { officeReading = false; renderOffice(); } }
      closeStartup(); return true;
    }
  }
  function newOffice() { ++readVersion; leaveViews(); selectedId = null; officeReading = false; officeErrorText = ''; office = { status: 'idle', thread: null, items: [], approvals: office.approvals || [], error: '' }; officeInput.value = drafts.get('new') || ''; officeRenderKey = ''; renderOffice(); closeStartup(); officeInput.focus(); }
  function renderCompanion() {
    const c = state?.companion || {}, open = !!layout?.companionHistoryOpen || historyPeek, wasHidden = history.hidden;
    history.hidden = !open; historyToggle.setAttribute('aria-expanded', String(open)); historyToggle.setAttribute('aria-label', open ? '收起聊天记录' : '展开聊天记录'); historyToggle.title = open ? '收起聊天记录' : '展开聊天记录';
    chatSend.hidden = !!c.working; chatStop.hidden = !c.working; chatSend.disabled = sending; chatSend.title = c.ready ? '发送消息' : '连接聊天设置';
    const status = !state?.companion ? '正在检查聊天连接…' : sending ? '正在发送…' : c.working ? '大肥鱼正在回复…' : chatError || c.error || (!c.ready ? '聊天尚未连接，请先设置' : '');
    chatStatusText.textContent = status;
    chatSetup.hidden = !state?.companion || !!c.ready || sending || !!c.working;
    chatRecover.hidden = !c.failedText || sending || !!c.working;
    chatRecover.disabled = !!chatInput.value.trim();
    chatRecover.title = chatRecover.disabled ? '请先保留或清空当前草稿，再恢复失败的消息' : '将失败的消息放回输入框，不会自动发送';
    chatStatus.hidden = !status && chatSetup.hidden && chatRecover.hidden;
    const key = JSON.stringify(c.messages || []);
    if (key !== historyKey) {
      const bottom = history.scrollHeight - history.scrollTop - history.clientHeight < 30; historyKey = key;
      history.replaceChildren(...(c.messages || []).map(m => { const line = el('p', 'neko-companion-message'); line.dataset.role = m.role; line.append(el('strong', '', m.role === 'user' ? '你：' : m.role === 'error' ? '提示：' : m.streaming ? '回复中：' : m.partial ? '未完成回复：' : '回复：'), doc.createTextNode(m.text)); return line; }));
      if (!history.children.length) history.appendChild(el('p', 'neko-companion-empty', '暂无聊天记录'));
      if (bottom) history.scrollTop = history.scrollHeight;
    }
    if (wasHidden && open) history.scrollTop = history.scrollHeight;
    lobby?.renderStatus();
  }
  function renderOffice() {
    if (!layout) return;
    const lobbyOpen = !!lobby?.isOpen(); panel.hidden = layout.officeMode !== 'codex' || socialOpen || lobbyOpen;
    if (!panel.hidden && !codexPaused() && modelsState === 'idle') refreshModels();
    for (const main of doc.querySelectorAll('main')) { if (socialOpen) continue; if (main.closest('[data-neko-workspace-owned]')) continue; if ((!panel.hidden || lobbyOpen) && !main.contains(dock)) markNative(main, 'inert'); else if (nativeMarks.get(main)?.has('inert')) { const before = nativeMarks.get(main).get('inert'); if (before === null) main.removeAttribute('inert'); else main.setAttribute('inert', before); nativeMarks.get(main).delete('inert'); } }
    officeTitle.textContent = office.thread?.title || 'Codex'; officeModel.textContent = office.thread?.model || '本机默认模型';
    const cwd = office.thread?.cwd || selectedProject || state?.workspaceRoot || '';
    projectButton.textContent = cwd ? cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd : '选择项目'; projectButton.title = cwd || '选择项目';
    const choice = currentModelChoice(), pickedModel = codexModels.find(m => m.model === choice.model), busy = officeSending || officeReading || office.status === 'working';
    const invalidChoice = !!choice.model && (!pickedModel || modelsState !== 'ready' || choice.effort && !pickedModel.supportedReasoningEfforts.some(e => e.reasoningEffort === choice.effort));
    const modelKey = JSON.stringify([codexModels, choice, office.thread?.model]);
    if (modelKey !== modelRenderKey) {
      modelRenderKey = modelKey;
      const option = (value, label) => { const n = el('option', '', label); n.value = value; return n; };
      modelSelect.replaceChildren(option('', office.thread?.model ? '沿用会话 · ' + office.thread.model : '本机默认'));
      for (const m of codexModels) { const n = option(m.model, m.displayName + (m.isDefault ? ' · 推荐' : '')); n.title = m.description || m.model; modelSelect.appendChild(n); }
      if (choice.model && !pickedModel) { const n = option(choice.model, choice.model + ' · 暂不可用'); n.disabled = true; modelSelect.appendChild(n); }
      modelSelect.value = choice.model || '';
      effortSelect.replaceChildren(option('', pickedModel?.defaultReasoningEffort ? '默认 · ' + effortLabel(pickedModel.defaultReasoningEffort) : '模型默认'));
      for (const e of pickedModel?.supportedReasoningEfforts || []) { const n = option(e.reasoningEffort, effortLabel(e.reasoningEffort)); n.title = e.description; effortSelect.appendChild(n); }
      if (choice.effort && !pickedModel?.supportedReasoningEfforts.some(e => e.reasoningEffort === choice.effort)) { const n = option(choice.effort, choice.effort + ' · 暂不可用'); n.disabled = true; effortSelect.appendChild(n); }
      effortSelect.value = choice.effort || '';
    }
    modelSelect.disabled = codexPaused() || busy; effortSelect.disabled = codexPaused() || busy || !pickedModel?.supportedReasoningEfforts.length; modelsRefresh.disabled = codexPaused() || busy || modelsState === 'loading';
    modelsStatus.textContent = modelsState === 'loading' ? '正在读取 Codex 模型…' : modelsError || (invalidChoice ? '已选模型或思考强度暂不可用，请重新选择或刷新' : modelsState === 'ready' && !codexModels.length ? '暂无可选模型，可沿用本机默认' : '');
    modelsStatus.hidden = !modelsStatus.textContent;
    officeCaption.textContent = (busy ? '执行于 Codex' : '发送到 Codex') + ' · ' + (pickedModel?.displayName || choice.model || office.thread?.model || '本机默认') + (pickedModel ? ' · 思考：' + effortLabel(choice.effort || pickedModel.defaultReasoningEffort || '默认') : '') + ' · ⌘/Ctrl Enter 发送';
    const key = JSON.stringify(office.items || []);
    if (key !== officeRenderKey) {
      const bottom = officeHistory.scrollHeight - officeHistory.scrollTop - officeHistory.clientHeight < 60; officeRenderKey = key;
      const old = new Map([...officeHistory.children].map(n => [n.dataset.item, n]));
      const children = (office.items || []).map(item => {
        let n = old.get(item.id); if (!n) { n = el(item.kind === 'activity' ? 'details' : 'article', 'neko-office-item'); n.dataset.item = item.id; n.dataset.kind = item.kind; }
        const value = (item.title || '') + '\n' + item.text;
        if (n._nekoContent !== value) { n._nekoContent = value; n.replaceChildren(); if (item.kind === 'activity') n.appendChild(el('summary', '', item.title)); n.appendChild(el('div', 'neko-office-item__text', item.text)); }
        return n;
      });
      officeHistory.replaceChildren(...children);
      if (!children.length) { const welcome = el('div', 'neko-office-welcome'); welcome.append(image(avatar('devcat')), el('h2', '', 'Codex 工作界面'), el('p', '', '选择一个本地工作会话，或在当前项目创建任务')); officeHistory.appendChild(welcome); }
      if (bottom) officeHistory.scrollTop = officeHistory.scrollHeight;
    }
    officeError.textContent = officeErrorText || office.error || (officeReading ? '正在读取原生 Codex 会话…' : office.status === 'working' ? 'Codex 正在工作…' : '');
    sendButton.disabled = codexPaused() || busy || invalidChoice; sendButton.textContent = codexPaused() ? '测试中' : officeSending ? '发送中…' : '发送'; stopButton.hidden = office.status !== 'working';
    newButton.disabled = codexPaused(); projectButton.disabled = codexPaused(); officeInput.disabled = codexPaused();
    if (codexPaused()) officeCaption.textContent = 'Codex 测试中，暂不可新建或发送任务';
    officeApprovals.replaceChildren(...(office.approvals || []).map(a => {
      const box = el('section', 'neko-office-approval'); box.append(el('strong', '', a.title), el('p', '', [a.threadTitle, a.cwd].filter(Boolean).join(' · ')), el('pre', '', a.command || a.reason || 'Codex 请求确认此操作'));
      box.append(button('允许本次', '', () => call({ action: 'codex-approve', key: a.key, decision: 'accept' }).catch(showOfficeError)), button('拒绝', '', () => call({ action: 'codex-approve', key: a.key, decision: 'decline' }).catch(showOfficeError))); return box;
    }));
  }
  let settingsReturnFocus = null;
  function closeSettings() { if (modal.hidden) return; modal.hidden = true; const target = settingsReturnFocus; settingsReturnFocus = null; if (target?.isConnected && typeof target.focus === 'function') target.focus(); else settingsButton.focus(); }
  function officeChoices() {
    const choices = el('div', 'neko-office-choices');
    for (const [id, name, pic] of [['dsh', 'DSH', 'bigfish'], ['codex', codexPaused() ? 'Codex · 测试中' : 'Codex', 'devcat'], ['claude', 'Claude · 待接入', 'claude']]) {
      const b = button('', 'neko-office-choice', async () => { leaveViews(); await saveLayout({ officeMode: id }); closeSettings(); });
      b.disabled = id === 'claude' || id === 'codex' && codexPaused(); b.setAttribute('aria-pressed', String(layout?.officeMode === id)); b.append(image(avatar(pic)), el('span', '', name)); choices.appendChild(b);
    }
    return choices;
  }
  function connectionSummary() { const connected = phase => ['ready', 'connected'].includes(phase) ? '已连接' : phase === 'error' ? '连接出错' : '未连接'; return 'N.E.K.O.：' + connected(state?.neko?.connection) + ' · 工作台：' + connected(state?.workbench?.connection); }
  function openSettings(kind = 'general', id) {
    if (modal.hidden) settingsReturnFocus = doc.activeElement;
    hideSocial(); modalBody.replaceChildren(); modalTitle.textContent = kind === 'seat' ? '自定义工作 agent' : '工作台设置'; modal.setAttribute('aria-label', modalTitle.textContent); modal.hidden = false;
    if (kind !== 'seat') {
      modalBody.append(el('h3', '', '右侧工作界面'), officeChoices());
      if (kind === 'general') {
        modalBody.append(el('h3', '', '头像与配色'));
        const palette = el('div', 'neko-workspace-palettes');
        for (const [id, name] of [['yui','Yui'],['devcat','开发喵'],['bigfish','大肥鱼'],['claude','Claude 娘'],['gemini','Gemini 小猫']]) { const b = button('', '', () => bridge.setAvatar(id).catch(showError)); b.setAttribute('aria-label', '配色：' + name); b.title = name; b.appendChild(image(avatar(id))); palette.appendChild(b); }
        modalBody.appendChild(palette);
        modalBody.append(el('h3', '', '常用设置'));
        const common = el('div', 'neko-workspace-common');
        common.append(button('界面布局', 'neko-workspace-setting-link', () => { closeSettings(); doc.dispatchEvent(new win.CustomEvent('neko-unified-open-config', {detail:{returnFocus:settingsButton}})); }));
        common.append(button('主 agent 聊天设置', 'neko-workspace-setting-link', () => { closeSettings(); Promise.resolve(bridge.action('chat-settings')).catch(showError); }), button('账号、隐私 / 高级设置', 'neko-workspace-setting-link', () => { closeSettings(); options.openNativeSettings?.(); }));
        modalBody.appendChild(common);
        const more = el('details', 'neko-workspace-more-settings'); const summary = el('summary', '', '更多工具与连接'); more.appendChild(summary);
        const connections = el('p', 'neko-workspace-connections', connectionSummary());
        connections.setAttribute('role', 'status'); more.appendChild(connections);
        const actions = el('div', 'neko-workspace-actions'), actionError = el('p', 'neko-workspace-form-error'); actionError.setAttribute('role', 'status');
        for (const [action, label] of options.settingsActions || []) {
          if (action === 'neko-settings') continue; // The main-chat settings entry above opens the same native window.
          const item = button(label, 'neko-workspace-setting-link', async () => {
            const controls = [...actions.querySelectorAll('button')]; controls.forEach(b => b.disabled = true); item.setAttribute('aria-busy', 'true'); actionError.textContent = '';
            try { const result = await bridge.action(action); if (result?.ok === false) throw Error('操作未完成，请重试'); if (!['connect-neko', 'reconnect-workbench', 'connection-status'].includes(action)) closeSettings(); }
            catch (error) { actionError.textContent = error.message || '操作未完成，请重试'; }
            finally { controls.forEach(b => b.disabled = false); item.removeAttribute('aria-busy'); }
          }); item.dataset.workbenchAction = action; actions.appendChild(item);
        }
        more.append(actions, actionError, el('p', 'neko-workspace-note', 'DSH 与 Codex 沿用本机登录；主 agent 陪伴聊天单独连接。')); modalBody.appendChild(more);
      }
    } else {
      const seat = layout?.seats.find(s => s.id === id); if (!seat) return;
      const edit = el('form', 'neko-seat-editor');
      const nameLabel = el('label', '', '名称'), name = el('input'); name.value = seat.name; name.maxLength = 24; nameLabel.appendChild(name);
      const providerLabel = el('label', '', '执行平台'), provider = el('select');
      for (const [value, label] of [['', '暂不绑定'], ['dsh', 'DSH'], ['codex', codexPaused() ? 'Codex · 测试中' : 'Codex']]) { const option = el('option', '', label); option.value = value; option.disabled = value === 'codex' && codexPaused() && seat.provider !== 'codex'; provider.appendChild(option); } provider.value = seat.provider || ''; providerLabel.appendChild(provider);
      const projectLabel = el('label', '', '工作项目范围'), project = el('select'); const all = el('option', '', '全部项目'); all.value = ''; project.appendChild(all);
      for (const cwd of [...new Set((catalog?.projects || []).map(p => p.cwd).filter(Boolean))]) { const option = el('option', '', cwd); option.value = cwd; project.appendChild(option); } project.value = seat.projectRoot || ''; projectLabel.appendChild(project);
      const avatarLabel = el('label', '', '头像'), pick = el('select');
      for (const id of ['yui', 'devcat', 'bigfish', 'claude', 'gemini', ...(seat.customDataUrl ? ['custom'] : [])]) { const option = el('option', '', ({ yui: 'Yui', devcat: '开发喵', bigfish: '大肥鱼', claude: 'Claude娘', gemini: 'Gemini小猫', custom: '自定义头像' })[id]); option.value = id; pick.appendChild(option); } pick.value = seat.avatarId; avatarLabel.appendChild(pick);
      const upload = button('上传头像…', 'neko-workspace-setting-link', async () => { try { layout = await call({ action: 'upload-seat', id: seat.id }); renderLayout(); openSettings('seat', seat.id); } catch (e) { error.textContent = e.message || '上传未完成'; } });
      const error = el('p', 'neko-workspace-form-error'); error.setAttribute('role', 'status');
      const save = el('button', 'neko-seat-save', '保存'); save.type = 'submit';
      edit.append(nameLabel, providerLabel, projectLabel, avatarLabel, upload, error, save);
      edit.addEventListener('submit', async e => { e.preventDefault(); try { layout = await call({ action: 'update-seat', id: seat.id, patch: { name: name.value, provider: provider.value || null, projectRoot: project.value || null, avatarId: pick.value } }); renderLayout(); closeSettings(); } catch (e) { error.textContent = e.message || '未能保存'; } });
      modalBody.appendChild(edit);
    }
    modalClose.focus();
  }
  function place() {
    if (disposed) return;
    // A valid selection snapshot with no session plus a visible DSH hero means
    // the native workspace was cleared. Global tool pages do not mount it.
    const selection = nativeSelection();
    startupContinue.hidden = !hasActiveDshSession();
    if (nativeNewPending && selection?.sessionId && selection.sessionId !== nativeNewBefore) stopNativeNew();
    const hero = doc.querySelector('.neko-gallery');
    if (!startupOpen && !nativeNewPending && layout?.officeMode === 'dsh' && selection && !selection.sessionId && hero && !hero.closest('[hidden],[inert]')) {
      startupOpen = true; renderStartup();
    }
    const found = options.locateSidebar?.(); const root = found?.root || found?.slot || doc.querySelector('[data-slot="sidebar"]');
    const rail = doc.querySelector('[data-neko-side-rail]'), theme = rail?.querySelector('.neko-side-rail__theme');
    const space = rail?.querySelector('.neko-side-rail__space') || null;
    if (space !== railSpace) {
      stopRailWalking();
      if (railSpace) { if (railSpaceBeforeAria === null) railSpace.removeAttribute('aria-hidden'); else railSpace.setAttribute('aria-hidden', railSpaceBeforeAria); resize?.unobserve?.(railSpace); }
      railSpace = space; railSpaceBeforeAria = space?.getAttribute('aria-hidden') ?? null; lastRailSize = '';
      if (space) { space.setAttribute('aria-hidden', 'false'); resize?.observe(space); }
    }
    if (space) {
      railCompanion.setAttribute('data-neko-rail-roam', '');
      if (railCompanion.parentNode !== space) space.appendChild(railCompanion);
    } else {
      railCompanion.removeAttribute('data-neko-rail-roam');
      railCompanion.style.removeProperty('left'); railCompanion.style.removeProperty('top'); railCompanion.style.removeProperty('transition');
      if (rail && railCompanion.parentNode !== rail) rail.prepend(railCompanion);
    }
    if (theme && officeButton.parentNode !== theme) { if (!nativeMarks.has(theme)) nativeMarks.set(theme, new Map()); nativeMarks.get(theme).set('aria-hidden', theme.getAttribute('aria-hidden')); theme.setAttribute('aria-hidden', ''); theme.appendChild(officeButton); }
    if (rail && railTop.parentNode !== rail) theme?.after(railTop);
    const mount = doc.querySelector('[data-neko-seat-mount]'); if (mount && seats.parentNode !== mount) mount.appendChild(seats);
    const nativeBrowser = doc.querySelector('[data-slot="sidebar.workspaces"]');
    if (nativeBrowser) { markNative(nativeBrowser, 'data-neko-session-browser-original'); if (sessionBrowser.parentNode !== nativeBrowser.parentNode || sessionBrowser.nextSibling !== nativeBrowser) nativeBrowser.before(sessionBrowser); }
    const account = doc.querySelector('[data-slot="settings.launcher"]');
    if (account?.parentElement) markNative(account.parentElement, 'data-neko-companion-footer');
    if (account && (dock.parentNode !== account.parentNode || dock.nextSibling !== account)) account.before(dock);
    if (roomPreview && (roomActive || sideSocial)) {
      const sidebar = doc.querySelector('[data-slot="sidebar"]');
      if (sidebar && !initialRoomResolved) {
        const collapsed = !!sidebar.closest('[data-sidebar-collapsed="true"]');
        const expand = doc.querySelector('.neko-side-rail__expand:not([hidden])');
        if (!collapsed || expand) { initialRoomResolved = true; if (collapsed) expand.click(); }
      }
      let track = sidebar;
      while (track?.parentElement && track.parentElement !== doc.body) {
        const next = track.nextElementSibling;
        if (next && typeof next.className === 'string' && /(?:^|\s)[^\s]*_centerCol(?:[_-][^\s]+)?(?:\s|$)/.test(next.className)) break;
        track = track.parentElement;
      }
      const slotRect = sidebar?.getBoundingClientRect();
      const side = flexSocialRect ? {left:flexSocialRect.x,top:flexSocialRect.y,right:flexSocialRect.x+flexSocialRect.width,bottom:flexSocialRect.y+flexSocialRect.height,width:flexSocialRect.width,height:flexSocialRect.height} : slotRect?.width > 0 && slotRect?.height > 0 ? slotRect : track?.getBoundingClientRect();
      let bottom = side?.bottom;
      for (const node of flexSocialRect ? [account?.parentElement] : [account?.parentElement, dock, account]) {
        const r = node?.getBoundingClientRect();
        if (r && r.height > 0 && r.top > (side?.top || 0) + 60) bottom = Math.min(bottom, r.top);
      }
      const visible = !!side && side.width >= 80 && bottom - side.top >= 80 && !sidebar?.closest('[data-sidebar-collapsed="true"]');
      if (visible) {
        const values = { left: `${Math.round(side.left)}px`, top: `${Math.round(side.top)}px`, width: `${Math.round(side.width)}px`, height: `${Math.round(bottom - side.top)}px` };
        for (const [key, value] of Object.entries(values)) if (roomPreview.style[key] !== value) roomPreview.style[key] = value;
        protectRoomFooter(sidebar, account);
      } else releaseRoomInert();
      const showRoom = visible && roomActive && !sideSocial && !doc.body.hasAttribute('data-neko-flex-social-hidden');
      if (roomPreview.hidden === showRoom) roomPreview.hidden = !showRoom;
    }
    watchDockAncestors();
    syncCompanionPlacement(rail);
    const bounds = companionInRail ? railBounds() : null, size = bounds ? `${bounds.space.width}:${bounds.space.height}` : '';
    if (bounds && size !== lastRailSize) { lastRailSize = size; setRailPosition(railX, railY); syncRailWalking(); }
    if (!companionInRail) setCompanionOffset(companionOffset);
    if (root) {
      const r = root.getBoundingClientRect(), strip = doc.querySelector('.neko-strip')?.getBoundingClientRect();
      // The native sidebar's inner navigation can be narrower than its grid
      // track. Anchor overlays to the actual center column during the chat
      // split so they never cover the enlarged room at startup or while dragging.
      const chatCenter = (doc.body.hasAttribute('data-neko-chatroom-active') || doc.body.hasAttribute('data-neko-side-social-active')) ? doc.querySelector('[data-neko-chat-center]') : null;
      const centerRect = chatCenter?.getBoundingClientRect();
      const x = Math.ceil(centerRect && centerRect.width > 0 ? centerRect.left : r.right), bottom = strip?.top > 0 ? strip.top : win.innerHeight;
      panel.toggleAttribute('data-neko-compact', win.innerWidth - x <= 400);
      Object.assign(panel.style, { left: x + 'px', top: '0px', width: Math.max(0, win.innerWidth - x) + 'px', height: Math.max(0, bottom) + 'px' });
      lobby?.place(panel.style);
      // In unified mode only cover the actual coding track, never a native
      // community or video WebContentsView. The hidden track keeps the chooser
      // pending so it returns when the user switches back to coding.
      const unified = doc.body.hasAttribute('data-neko-unified-enabled') && !doc.body.hasAttribute('data-neko-side-social-active');
      const coding = unified ? doc.querySelector('[data-neko-unified-coding]') : null;
      const codeRect = coding?.getBoundingClientRect();
      const codeVisible = !!coding && coding.getAttribute('data-neko-unified-coding') !== 'hidden' && !coding.hasAttribute('inert') && codeRect?.width > 0 && codeRect?.height > 0;
      const px = unified && codeVisible ? Math.ceil(codeRect.left) : x;
      const py = unified && codeVisible ? Math.max(56, Math.ceil(codeRect.top)) : 56;
      const pw = unified && codeVisible ? Math.floor(codeRect.width) : Math.max(0, win.innerWidth - x);
      const ph = unified && codeVisible ? Math.max(0, Math.min(bottom, Math.floor(codeRect.bottom)) - py) : Math.max(0, bottom - 56);
      startup.hidden = !startupOpen || !!lobby?.isOpen() || doc.body.hasAttribute('data-neko-workspace-collapsed') || doc.body.hasAttribute('data-neko-flex-workspace-collapsed') || (unified && !codeVisible);
      Object.assign(startup.style, { left: px + 'px', top: py + 'px', width: pw + 'px', height: ph + 'px' });
    }
    syncCollapsedComposer(); positionCompanionMenu();
  }
  function schedule() { if (!disposed && !queued) { queued = true; Promise.resolve().then(() => { queued = false; place(); positionCompanionMenu(); }); } }
  function nativeNew(event) {
    const target = event.target?.closest?.('button');
    if (!target) return;
    const marked = target.getAttribute('data-neko-new-session') === 'plus';
    // The DSH React node is not always decorated by the optional sidebar
    // adapter. Match only its sidebar button, not the composer attachment +.
    const sidebar = target.closest('[data-slot="sidebar"]');
    const label = (target.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const native = sidebar && !target.closest('[data-neko-workspace-owned]') &&
      (/(?:^|\s)[^\s]*_newSession(?:\s|$)/.test(target.className) || /^(?:新建会话|新会话|新建对话|new (?:chat|session|conversation))$/i.test(label));
    if (!marked && !native) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (layout?.officeMode === 'codex') newOffice(); else showStartup();
  }
  function escape(event) { if (event.key !== 'Escape') return; if (!companionMenu.hidden) { event.preventDefault(); event.stopPropagation(); closeCompanionMenu(); } else if (!modal.hidden) { event.stopPropagation(); closeSettings(); } else if ((layout?.companionHistoryOpen || historyPeek) && dock.contains(doc.activeElement)) { event.preventDefault(); historyPeek = false; saveLayout({ companionHistoryOpen: false }); historyToggle.focus(); } }
  const observer = new win.MutationObserver(records => { if (records.some(record => record.type !== 'attributes' || record.attributeName !== 'style' || record.target.matches?.('[data-neko-unified-coding]') || record.target === doc.body && doc.body.hasAttribute('data-neko-flex-workspace-collapsed'))) schedule(); }); observer.observe(doc.body, { childList: true, subtree: true, attributes:true, attributeFilter:['data-neko-unified-enabled', 'data-neko-unified-coding', 'data-neko-side-social-active', 'data-neko-workspace-collapsed', 'data-neko-flex-workspace-collapsed', 'data-neko-flex-coding', 'data-neko-tools', 'style'] });
  // Observe only the dock's ancestors for inline style changes: watching every
  // style mutation would also watch our own drag/position updates.
  const ancestorObserver = new win.MutationObserver(schedule);
  function watchDockAncestors() {
    if (observedDockParent === dock.parentElement) return;
    ancestorObserver.disconnect(); observedDockParent = dock.parentElement;
    for (let node = observedDockParent; node && node !== doc.body; node = node.parentElement)
      ancestorObserver.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-sidebar-collapsed'] });
  }
  const intersection = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    const entry = entries.find(item => item.target === dock);
    if (entry && dockIntersecting !== entry.isIntersecting) { dockIntersecting = entry.isIntersecting; schedule(); }
  }) : null;
  intersection?.observe(dock);
  win.addEventListener('resize', place); doc.addEventListener('scroll', schedule, true); doc.addEventListener('click', nativeNew, true); doc.addEventListener('keydown', escape, true);
  const resize = win.ResizeObserver ? new win.ResizeObserver(place) : null;
  if (options.locateSidebar?.()?.root) resize?.observe(options.locateSidebar().root);
  resize?.observe(dock);
  doc.body.setAttribute('data-neko-workspace-shell', '');
  if (typeof options.subscribeDshSelection === 'function') {
    try {
      const releaseSelection = options.subscribeDshSelection(() => schedule());
      if (typeof releaseSelection === 'function') releases.push(releaseSelection);
    } catch { /* Older DSH versions may not expose selection subscriptions. */ }
  }
  if (typeof bridge.subscribe === 'function') releases.push(bridge.subscribe(next => {
    if (disposed) return; state = next; const connections = modalBody.querySelector('.neko-workspace-connections'); if (connections) connections.textContent = connectionSummary(); if (!selectedProject) selectedProject = next.workspaceRoot || '';
    renderCompanion(); if (next.workspaceRevision !== layoutVersion) { layoutVersion = next.workspaceRevision; call({ action: 'state' }).then(value => { if (!disposed) { layout = value; renderLayout(); } }).catch(showError); }
  }));
  if (typeof bridge.subscribeOffice === 'function') releases.push(bridge.subscribeOffice(next => { if (disposed) return; if (next.thread?.id === selectedId || sendContext?.version === readVersion && sendContext.id === null) { office = next; } else { office.approvals = next.approvals || []; } renderOffice(); }));
  if (typeof bridge.subscribeCommunity === 'function') releases.push(bridge.subscribeCommunity(next => { if (disposed || next?.slot) return; socialOpen = next.status !== 'hidden'; if (socialOpen) lobby?.hide(); renderOffice(); }));
  Promise.all([bridge.getState(), call({ action: 'state' }), call({ action: 'codex-state' }), call({ action: 'codex-model-choices' }).catch(() => null)]).then(([s, l, c, choices]) => { if (!disposed) { for (const [id, choice] of Object.entries(choices || {})) modelChoices.set(id, choice); state = s; layout = l; office = c; selectedId = c.thread?.id || null; selectedProject ||= s.workspaceRoot || ''; renderLayout(); refreshCatalog(); } }).catch(error => { catalogError = '工作会话读取失败，请刷新重试'; renderStartup(); showError(error); });
  syncCharacter();
  const interval = win.setInterval(() => { if (doc.visibilityState !== 'hidden') refreshCatalog(true); }, 60000);
  place();
  return () => {
    clearCollapsedComposer(); collapseResize?.disconnect(); if (collapseNoticeTimer) win.clearTimeout(collapseNoticeTimer);
    if (disposed) return; disposed = true; floatingComposer?.dispose(); if (floatingGeometry) floatingCall({action:'remove'}); stopNativeNew(); motion?.removeEventListener?.('change', syncCharacter); motion?.removeEventListener?.('change', syncRailWalking); doc.removeEventListener('visibilitychange', syncCharacter); doc.removeEventListener('visibilitychange', syncRailWalking); stopRailWalking(); if (railClickTimer !== null) win.clearTimeout(railClickTimer); if (railSpace) { if (railSpaceBeforeAria === null) railSpace.removeAttribute('aria-hidden'); else railSpace.setAttribute('aria-hidden', railSpaceBeforeAria); } if (characterVideo) { characterVideo.pause(); characterVideo.removeAttribute('src'); characterVideo.load(); } observer.disconnect(); ancestorObserver.disconnect(); intersection?.disconnect(); resize?.disconnect(); win.clearInterval(interval);
    win.removeEventListener('resize', place); doc.removeEventListener('scroll', schedule, true); doc.removeEventListener('click', nativeNew, true); doc.removeEventListener('keydown', escape, true);
    doc.removeEventListener('pointerdown', dismissCompanionMenu, true);
    doc.removeEventListener('neko-native-tools-navigate', showNativeToolsPage);
    doc.removeEventListener('neko-side-surface-change', sideSurfaceChanged);
    doc.removeEventListener('neko-flex-social-geometry', onFlexSocialGeometry);
    if (roomPreview) { doc.removeEventListener('neko-chatroom-show-workspace', showWorkspaceFromLayout); doc.body.removeAttribute('data-neko-chatroom-active'); releaseRoomInert(); doc.dispatchEvent(new win.Event('neko-chatroom-mode-change')); }
    for (const release of releases) if (typeof release === 'function') release();
    for (const [node, attrs] of nativeMarks) for (const [name, before] of attrs) { if (node.getAttribute(name) === '') { if (before === null) node.removeAttribute(name); else node.setAttribute(name, before); } }
    doc.body.removeAttribute('data-neko-workspace-shell'); doc.body.removeAttribute('data-neko-office-mode');
    for (const n of nodes) n.remove(); style.remove();
  };
}

// Lobby (频道) view. Renderer only: every value from the lobby snapshot is written with textContent or DOM
// calls, never parsed as HTML. Drafts, the reply target and picked mentions stay in this closure.
// It never hides, inerts or rebuilds the companion dock, and degrades to nothing when bridge.lobby fails.
function createLobbyView({ doc, bridge, el, button, image, avatar, composer, companion, onOpen, onChange }) {
  const MAX_TEXT = 2000, MAX_NODES = 300, MENTION = /<@([uc]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;
  const MODES = [['off', '她不参与'], ['assist', '一起回复'], ['independent', '她自己说话']];
  let snap = null, open = false, joined = false, disposed = false, error = '', replyToId = null, picked = [], picker = null, sending = false;
  // Draft state (text, reply target, 人＋AI marker, undo) lives in lobby-composer.js; without it the assist flow is off.
  const C = composer && typeof composer.create === 'function' ? composer : null;
  const TRIGGERS = [['mention', '只在被 @ 时'], ['owner_or_mention', '主人说话或被 @ 时'], ['free', '自由发言']];
  const CAT_AVATARS = [['bigfish', '大肥鱼'], ['yui', 'YUi'], ['devcat', '开发喵'], ['claude', 'Claude娘'], ['gemini', 'Gemini小猫']];
  const SLOW = [[0, '关闭'], [5, '5 秒'], [10, '10 秒'], [30, '30 秒'], [60, '60 秒']];
  const MUTES = [[10, '禁言 10 分钟'], [60, '禁言 1 小时'], [1440, '禁言 24 小时']];
  let draft = C ? C.create() : null, assistOpen = false, menuFor = null, dialog = null, lastMode = null, nudgeSeen = null, membersKey = '', cardKey = '';
  const rows = new Map();
  const svg = (tag, attrs) => { const n = doc.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const railButton = button('', 'neko-side-rail__button neko-lobby-switch', () => toggle());
  railButton.setAttribute('aria-label', '频道 · 公共大厅'); railButton.title = '频道 · 公共大厅'; railButton.setAttribute('aria-expanded', 'false');
  const icon = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  icon.appendChild(svg('path', { d: 'M4 6h16v10H10l-4 3v-3H4V6Zm4 4h8M8 13h5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  railButton.appendChild(icon);
  const panel = el('section', 'neko-lobby-panel'); panel.hidden = true; panel.setAttribute('aria-label', '频道 · 公共大厅');
  const header = el('header', 'neko-lobby-header'), title = el('strong', 'neko-lobby-title', '频道'), topic = el('span', 'neko-lobby-topic'), onlineCount = el('span', 'neko-lobby-online');
  onlineCount.setAttribute('aria-live', 'polite');
  const signOut = button('退出登录', 'neko-lobby-sign-out', () => call({ action: 'sign-out' }));
  const headerActions = el('div', 'neko-lobby-header__actions');
  const catSettingsButton = button('猫猫设置', 'neko-lobby-cat-settings', () => openDialog('cat')); catSettingsButton.setAttribute('aria-haspopup', 'dialog');
  const adminButton = button('管理', 'neko-lobby-admin-open', () => openDialog('admin')); adminButton.setAttribute('aria-haspopup', 'dialog'); adminButton.dataset.admin = '';
  headerActions.append(catSettingsButton, signOut);
  header.append(title, topic, onlineCount, headerActions);
  const gate = el('div', 'neko-lobby-gate'), gateText = el('p', 'neko-lobby-gate__text');
  const signIn = button('登录频道', 'neko-lobby-sign-in', () => call({ action: 'sign-in' }).then(() => { if (open && connected()) join(); }));
  const signInCancel = button('取消登录', 'neko-lobby-sign-in-cancel', () => call({ action: 'sign-in-cancel' }));
  const reconnect = button('重新连接', 'neko-lobby-reconnect', () => join(true));
  gate.append(gateText, signIn, signInCancel, reconnect);
  const older = button('加载更早消息', 'neko-lobby-older', () => call({ action: 'load-older' }));
  const log = el('div', 'neko-lobby-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-label', '频道消息'); log.tabIndex = 0;
  const empty = el('p', 'neko-lobby-empty', '还没有消息，来打个招呼吧');
  const middle = el('div', 'neko-lobby-middle'), stream = el('div', 'neko-lobby-stream');
  const members = el('aside', 'neko-lobby-members'); members.setAttribute('aria-label', '频道成员');
  const membersTitle = el('h3', 'neko-lobby-members__title', '成员'), memberList = el('ul', 'neko-lobby-member-list');
  members.append(membersTitle, memberList); stream.append(older, log); middle.append(stream, members);
  // Private negotiation box: local to this machine, nothing in it is sent to the channel.
  const assist = el('section', 'neko-lobby-assist'); assist.hidden = true; assist.setAttribute('aria-label', '和她私下商量（只有你能看到）');
  const nudgeLine = el('div', 'neko-lobby-nudge'), nudgeText = el('span', 'neko-lobby-nudge__text'); nudgeLine.setAttribute('role', 'status'); nudgeLine.hidden = true;
  const nudgeHelp = button('请她帮我回', 'neko-lobby-nudge-help', () => { const id = snap?.nudge?.messageId; if (id) { nudgeSeen = id; requestAssist(id); } });
  const nudgeClose = button('×', 'neko-lobby-nudge-close', () => { nudgeSeen = snap?.nudge?.messageId || null; renderAssist(); }); nudgeClose.setAttribute('aria-label', '忽略这条提醒');
  nudgeLine.append(nudgeText, nudgeHelp, nudgeClose);
  const assistToggle = button('和她私下商量', 'neko-lobby-assist-toggle', () => { assistOpen = !assistOpen; renderAssist(); if (assistOpen) assistInput.focus?.(); });
  assistToggle.setAttribute('aria-expanded', 'false');
  const assistBody = el('div', 'neko-lobby-assist__body'); assistBody.hidden = true;
  const assistHint = el('p', 'neko-lobby-assist__hint', '只有你能看到这里。她想好的回复不会自动发出，要你采用并按发送。');
  const assistInput = el('textarea', 'neko-lobby-assist-input'); assistInput.rows = 2; assistInput.maxLength = 500;
  assistInput.placeholder = '想让她怎么帮你？比如：帮我委婉拒绝、改得可爱一点'; assistInput.setAttribute('aria-label', '给她的要求（只有你能看到）');
  const assistAsk = button('请她帮我想', 'neko-lobby-assist-ask', () => requestAssist(replyToId));
  const assistRow = el('div', 'neko-lobby-assist__row'); assistRow.append(assistInput, assistAsk);
  const card = el('div', 'neko-lobby-card'); card.hidden = true; card.setAttribute('aria-live', 'polite'); card.setAttribute('aria-label', '她的建议');
  assistBody.append(assistHint, assistRow, card); assist.append(nudgeLine, assistToggle, assistBody);
  assistInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!assistAsk.disabled) requestAssist(replyToId); } });
  const notice = el('p', 'neko-lobby-error'); notice.setAttribute('role', 'status');
  const modeBar = el('div', 'neko-lobby-modebar'), modeGroup = el('div', 'neko-lobby-modes'); modeGroup.setAttribute('role', 'group'); modeGroup.setAttribute('aria-label', '她在大厅的参与方式');
  const modeButtons = MODES.map(([mode, label]) => { const b = button(label, 'neko-lobby-mode', () => call({ action: 'mode-set', mode })); b.dataset.mode = mode; b.setAttribute('aria-pressed', 'false'); modeGroup.appendChild(b); return b; });
  const reason = el('span', 'neko-lobby-reason');
  const dots = el('div', 'neko-lobby-dots'); dots.setAttribute('aria-label', '状态');
  const dot = kind => { const n = el('span', 'neko-lobby-dot'); n.dataset.status = kind; n.setAttribute('role', 'status'); dots.appendChild(n); return n; };
  const privateDot = dot('private'), connectionDot = dot('connection'), participationDot = dot('participation');
  modeBar.append(modeGroup, reason, dots);
  const form = el('form', 'neko-lobby-form');
  const replyBar = el('div', 'neko-lobby-reply'), replyText = el('span', 'neko-lobby-reply__text'); replyBar.hidden = true;
  const replyCancel = button('×', 'neko-lobby-reply__cancel', () => setReply(null)); replyCancel.setAttribute('aria-label', '取消回复');
  replyBar.append(replyText, replyCancel);
  const input = el('textarea'); input.rows = 2; input.maxLength = MAX_TEXT; input.placeholder = '在频道里说点什么… Enter 发送，Shift+Enter 换行，@ 提及成员'; input.setAttribute('aria-label', '频道消息输入');
  const pickerList = el('ul', 'neko-lobby-picker'); pickerList.hidden = true; pickerList.id = 'neko-lobby-picker'; pickerList.setAttribute('role', 'listbox'); pickerList.setAttribute('aria-label', '提及成员');
  input.setAttribute('aria-controls', pickerList.id); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
  const send = el('button', 'neko-lobby-send', '发送'); send.type = 'submit';
  // Adopting into a non-empty draft asks first; replace keeps an undo snapshot. The 人＋AI marker follows the draft.
  const choiceBar = el('div', 'neko-lobby-adopt-choice'); choiceBar.hidden = true; choiceBar.setAttribute('role', 'group'); choiceBar.setAttribute('aria-label', '输入框里已经有内容');
  const choiceReplace = button('替换', 'neko-lobby-adopt-replace', () => chooseAdopt('replace'));
  choiceBar.append(el('span', 'neko-lobby-adopt-choice__text', '输入框里已有内容，她的建议要：'), choiceReplace,
    button('接在后面', 'neko-lobby-adopt-append', () => chooseAdopt('append')), button('取消', 'neko-lobby-adopt-cancel', () => chooseAdopt('cancel')));
  const undoBar = el('div', 'neko-lobby-undo'); undoBar.hidden = true;
  undoBar.append(el('span', 'neko-lobby-undo__text', '已用她的建议替换输入框内容'), button('撤销', 'neko-lobby-undo-button', () => undoReplace()));
  const marker = el('span', 'neko-lobby-marker'); marker.hidden = true;
  marker.title = '采用过她的建议，发出后别人会看到「人＋AI 共同回复」。清空输入框后标记消失。';
  const formFooter = el('div', 'neko-lobby-form-footer'), counter = el('span', 'neko-lobby-counter', '0 / ' + MAX_TEXT);
  formFooter.append(marker, counter, send); form.append(replyBar, choiceBar, undoBar, pickerList, input, formFooter);
  panel.append(header, gate, middle, notice, modeBar, assist, form); doc.body.appendChild(panel);

  const connection = () => snap?.connection || 'unconfigured';
  const connected = () => !['unconfigured', 'signed-out'].includes(connection());
  const meId = () => snap?.me?.user_id || null;
  const ownCat = author => author?.kind === 'cat' && !!meId() && author.owner_user_id === meId();
  const ownHuman = author => author?.kind === 'human' && !!meId() && author.user_id === meId();
  const isAdmin = () => connection() === 'online' && !!snap?.me?.is_admin;
  const assistOn = () => !!C && connection() === 'online' && !!snap?.participation?.available && snap.participation.mode === 'assist' && !!snap?.me?.cat?.id;
  async function call(request) {
    if (disposed) return null;
    let result = null;
    try { result = await bridge.lobby(request); } catch { result = { ok: false, error: '大厅操作失败，请稍后重试' }; }
    if (disposed) return result;
    if (result?.state && typeof result.state === 'object') snap = result.state;
    error = result?.ok === false && typeof result.error === 'string' ? result.error : '';
    render();
    return result;
  }
  function join(force = false) { if (!open || (!force && joined) || !connected()) return; joined = true; call({ action: 'open' }); }
  function show() { if (open || disposed) return; onOpen?.(); open = true; panel.hidden = false; railButton.setAttribute('aria-expanded', 'true'); render(); join(); onChange?.(); input.focus?.(); }
  function hide() { if (!open) return; open = false; panel.hidden = true; railButton.setAttribute('aria-expanded', 'false'); closePicker(); if (joined) { joined = false; call({ action: 'close' }); } onChange?.(); }
  function toggle() { if (open) hide(); else show(); }
  // ---- names and labels (style follows author.kind / origin only, never the name) ----
  function memberName(kind, id) {
    for (const m of snap?.members || []) {
      if (kind === 'c' && m.kind === 'cat' && m.cat_id === id) return ownCat(m) ? '我的' + (m.name || '猫猫') : m.display_name || m.name || '猫猫';
      if (kind === 'u' && m.kind === 'human' && m.user_id === id) return id === meId() ? '我' : m.display_name || m.name || '成员';
    }
    if (kind === 'u' && id === meId()) return '我';
    return kind === 'c' ? '猫猫' : '成员';
  }
  function authorName(author) {
    if (!author) return '成员';
    if (author.kind === 'cat') return ownCat(author) ? '我的' + (author.name || '猫猫') : author.display_name || author.name || '猫猫';
    return author.user_id && author.user_id === meId() ? '我' : author.display_name || author.name || '成员';
  }
  function originLabel(origin, label, author) {
    const mine = author && (author.kind === 'cat' ? ownCat(author) : !!meId() && author.user_id === meId());
    if (mine && origin === 'human') return '我';
    if (mine && origin === 'human_ai') return '人＋AI 共同回复 · 我与' + (author.assist_cat?.name || '猫猫');
    if (mine && origin === 'cat') return 'AI 独立发言 · 我的' + (author.name || '猫猫');
    if (typeof label === 'string' && label) return label;
    if (origin === 'cat') return 'AI 独立发言 · ' + authorName(author);
    if (origin === 'human_ai') return '人＋AI 共同回复 · ' + authorName(author) + '与' + (author?.assist_cat?.name || '猫猫');
    return authorName(author);
  }
  const findMessage = id => (snap?.messages || []).find(m => m.id === id) || null;
  function quoteLabel(reply) {
    const source = findMessage(reply.id);
    return source ? originLabel(source.origin, source.label, source.author) : originLabel(reply.origin, reply.label, null);
  }
  /** Plain text with <@u:…>/<@c:…> tokens as DOM nodes; no HTML is ever parsed. */
  function richText(text, className) {
    const box = el('div', className), value = String(text ?? '');
    let last = 0;
    for (const match of value.matchAll(MENTION)) {
      if (match.index > last) box.appendChild(doc.createTextNode(value.slice(last, match.index)));
      const kind = match[1].toLowerCase(), id = match[2].toLowerCase();
      const mention = el('span', 'neko-lobby-mention', '@' + memberName(kind, id)); mention.dataset.kind = kind === 'c' ? 'cat' : 'human';
      box.appendChild(mention); last = match.index + match[0].length;
    }
    if (last < value.length) box.appendChild(doc.createTextNode(value.slice(last)));
    return box;
  }
  function avatarNode(author) {
    if (author?.kind === 'cat') { const pic = image(avatar(author.avatar_key) || avatar('bigfish'), 'neko-lobby-avatar'); pic.dataset.kind = 'cat'; return pic; }
    const a = author?.avatar;
    if (a?.kind === 'image' && typeof a.url === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,/.test(a.url)) return image(a.url, 'neko-lobby-avatar');
    const hue = Number.isFinite(a?.hue) ? Math.round(a.hue) % 360 : 200;
    const node = el('span', 'neko-lobby-avatar neko-lobby-avatar--hue', typeof a?.text === 'string' ? Array.from(a.text).slice(0, 1).join('') : '');
    node.style.setProperty('--neko-lobby-hue', String(hue)); node.setAttribute('aria-hidden', 'true');
    return node;
  }
  function messageRow(m) {
    const row = el('article', 'neko-lobby-message'); row.dataset.id = m.id; row.dataset.origin = m.origin || 'human'; row.dataset.kind = m.author?.kind === 'cat' ? 'cat' : 'human';
    if (m.author && (m.author.kind === 'cat' ? ownCat(m.author) : m.author.user_id === meId())) row.dataset.mine = 'true';
    const body = el('div', 'neko-lobby-message__body'), meta = el('div', 'neko-lobby-message__meta');
    meta.appendChild(el('span', 'neko-lobby-label', originLabel(m.origin, m.label, m.author)));
    if (m.origin === 'cat') meta.appendChild(el('span', 'neko-lobby-badge', '🐾 猫猫'));
    else if (m.origin === 'human_ai') meta.appendChild(el('span', 'neko-lobby-badge neko-lobby-badge--assist', '人＋AI 🐾'));
    if (Number.isFinite(m.created_at)) { const time = el('time', 'neko-lobby-time', new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })); time.dateTime = new Date(m.created_at).toISOString(); meta.appendChild(time); }
    body.appendChild(meta);
    if (m.reply_to) {
      const quote = el('blockquote', 'neko-lobby-quote'), source = findMessage(m.reply_to.id);
      quote.dataset.origin = m.reply_to.origin || 'human';
      quote.append(el('span', 'neko-lobby-quote__label', '回复 ' + quoteLabel(m.reply_to)));
      if (source) quote.appendChild(source.deleted ? el('span', 'neko-lobby-deleted', '消息已删除') : richText(Array.from(source.text || '').slice(0, 80).join(''), 'neko-lobby-quote__text'));
      body.appendChild(quote);
    }
    if (m.deleted) body.appendChild(el('p', 'neko-lobby-deleted', '消息已删除'));
    else {
      body.appendChild(richText(m.text, 'neko-lobby-text'));
      const actions = el('div', 'neko-lobby-actions'), reply = button('回复', 'neko-lobby-reply-to', () => setReply(m.id));
      reply.setAttribute('aria-label', '回复 ' + originLabel(m.origin, m.label, m.author)); actions.appendChild(reply);
      if (assistOn() && !row.dataset.mine) {
        const help = button('请她帮我回', 'neko-lobby-assist-this', () => requestAssist(m.id));
        help.setAttribute('aria-label', '请她帮我回 ' + originLabel(m.origin, m.label, m.author)); actions.appendChild(help);
      }
      const remove = deleteButton(m); if (remove) actions.appendChild(remove);
      body.appendChild(actions);
    }
    row.append(avatarNode(m.author), body);
    return row;
  }
  function outboxRow(entry) {
    const row = el('article', 'neko-lobby-message neko-lobby-message--outbox'); row.dataset.outbox = entry.status; row.dataset.mine = 'true'; row.dataset.origin = entry.origin || 'human';
    const body = el('div', 'neko-lobby-message__body'), meta = el('div', 'neko-lobby-message__meta');
    meta.appendChild(el('span', 'neko-lobby-label', entry.origin === 'human_ai' ? '人＋AI 共同回复 · 我与' + (snap?.me?.cat?.name || '猫猫') : '我'));
    body.append(meta, richText(entry.text, 'neko-lobby-text'));
    const state = el('div', 'neko-lobby-actions');
    if (entry.status === 'failed') {
      state.append(el('span', 'neko-lobby-failed', entry.error || '发送失败'),
        button('重试', 'neko-lobby-retry', () => call({ action: 'send-retry', clientMessageId: entry.clientMessageId })),
        button('放弃', 'neko-lobby-discard', () => call({ action: 'send-discard', clientMessageId: entry.clientMessageId })));
    } else state.appendChild(el('span', 'neko-lobby-pending', '发送中…'));
    body.appendChild(state); row.append(avatarNode({ kind: 'human', avatar: snap?.me?.avatar }), body);
    return row;
  }
  // ---- composer: reply target, @ picker, Enter to send ----
  /** A new reply target is a new draft epoch: the unadopted card is discarded (adopted text stays in the draft). */
  function setReply(id, { discard = true } = {}) {
    const next = id && findMessage(id) ? id : null, changed = next !== replyToId;
    replyToId = next;
    if (C) { const before = draft.draftEpoch; draft = C.setReplyTarget(draft, replyToId); if (changed && discard && draft.draftEpoch !== before && snap?.suggestion && snap.suggestion.state !== 'generating' && snap.suggestion.targetId !== replyToId) call({ action: 'suggest-discard' }); }
    if (assist && !assist.hidden) renderAssist();
    const target = replyToId ? findMessage(replyToId) : null;
    replyBar.hidden = !target; replyText.textContent = target ? '回复 ' + originLabel(target.origin, target.label, target.author) : '';
    if (target) input.focus?.();
  }
  function candidates(query) {
    const q = query.toLowerCase(), out = [];
    for (const m of snap?.members || []) {
      if (m.kind === 'human' && m.user_id === meId()) continue;
      const id = m.kind === 'cat' ? m.cat_id : m.user_id; if (!id) continue;
      const name = m.kind === 'cat' ? (ownCat(m) ? '我的' + (m.name || '猫猫') : m.display_name || m.name || '猫猫') : m.display_name || m.name || '成员';
      if (!q || name.toLowerCase().includes(q)) out.push({ kind: m.kind === 'cat' ? 'c' : 'u', id, name, online: !!m.online });
    }
    return out.slice(0, 8);
  }
  function closePicker() { picker = null; pickerList.hidden = true; pickerList.replaceChildren(); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function renderPicker() {
    if (!picker || !picker.items.length) { closePicker(); return; }
    pickerList.replaceChildren(...picker.items.map((item, index) => {
      const li = el('li', 'neko-lobby-picker__item'); li.id = 'neko-lobby-pick-' + index; li.setAttribute('role', 'option'); li.dataset.kind = item.kind === 'c' ? 'cat' : 'human';
      li.setAttribute('aria-selected', String(index === picker.index)); li.append(el('span', '', (item.kind === 'c' ? '🐾 ' : '') + item.name));
      if (!item.online) li.dataset.offline = 'true';
      li.addEventListener('mousedown', event => { event.preventDefault(); choose(index); });
      return li;
    }));
    pickerList.hidden = false; input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-activedescendant', 'neko-lobby-pick-' + picker.index);
  }
  function updatePicker() {
    const caret = input.selectionStart ?? input.value.length, before = input.value.slice(0, caret), match = /(^|\s)@([^\s@]{0,32})$/.exec(before);
    if (!match) { closePicker(); return; }
    picker = { start: caret - match[2].length - 1, end: caret, items: candidates(match[2]), index: 0 }; renderPicker();
  }
  function choose(index) {
    const item = picker?.items[index]; if (!item) return;
    const text = '@' + item.name + ' ', value = input.value.slice(0, picker.start) + text + input.value.slice(picker.end);
    if (Array.from(value).length > MAX_TEXT) { closePicker(); return; }
    input.value = value; const caret = picker.start + text.length; input.setSelectionRange?.(caret, caret);
    if (!picked.some(p => p.kind === item.kind && p.id === item.id)) picked.push(item);
    closePicker(); renderCounter();
  }
  /** Picked @name text becomes a <@u:…>/<@c:…> token at send time; unpicked @text stays plain text. */
  function encode(text) {
    let out = text, count = 0;
    for (const p of [...picked].sort((a, b) => b.name.length - a.name.length)) {
      const needle = '@' + p.name; if (!out.includes(needle)) continue;
      out = out.split(needle).join('<@' + p.kind + ':' + p.id + '>'); count++;
    }
    return { text: out, count };
  }
  function renderCounter() { counter.textContent = Array.from(input.value).length + ' / ' + MAX_TEXT; }
  input.addEventListener('input', () => { if (!input.value.trim()) picked = []; if (C) { draft = C.edit(draft, input.value); renderDraft(); } renderCounter(); updatePicker(); });
  input.addEventListener('keydown', event => {
    if (picker && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); picker.index = (picker.index + (event.key === 'ArrowDown' ? 1 : picker.items.length - 1)) % picker.items.length; renderPicker(); return; }
    if (picker && (event.key === 'Tab' || (event.key === 'Enter' && !event.isComposing))) { event.preventDefault(); choose(picker.index); return; }
    if (picker && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('blur', () => closePicker());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const typed = input.value, raw = typed.trim();
    if (!raw || sending || connection() !== 'online') return;
    const { text, count } = encode(raw);
    if (count > 5) { error = '一条消息最多提及 5 位成员'; render(); return; }
    if (Array.from(text).length > MAX_TEXT) { error = '消息太长，请删减后再发'; render(); return; }
    // origin comes from the 人＋AI marker alone: only a draft that adopted a suggestion (and was not cleared) is human_ai.
    if (C) draft = C.edit(draft, input.value);
    const payload = C ? C.sendPayload(draft) : null, catId = payload?.assistCatId;
    const request = { action: 'send', text, origin: catId ? 'human_ai' : 'human' }; if (replyToId) request.replyToId = replyToId; if (catId) request.assistCatId = catId;
    const keepReply = replyToId, keepPicked = picked, keepDraft = draft;
    sending = true; input.value = ''; picked = []; if (C) draft = C.sent(draft); setReply(null, { discard: false }); renderCounter(); renderDraft(); render();
    const result = await call(request);
    sending = false;
    const queued = (snap?.outbox || []).some(e => e.text === text);
    if (result?.ok === false && !queued && !input.value) { input.value = typed; picked = keepPicked; if (C) draft = keepDraft; setReply(keepReply, { discard: false }); renderCounter(); renderDraft(); }
    render();
  });
  // ---- assist: 请她帮我回, private negotiation box, suggestion card. Nothing here sends to the channel. ----
  function requestAssist(targetId) {
    if (!assistOn() || snap?.suggestion?.state === 'generating') return;
    if (targetId !== undefined && targetId !== replyToId) setReply(targetId, { discard: false });
    assistOpen = true;
    const request = { action: 'suggest', instruction: Array.from(assistInput.value.trim()).slice(0, 500).join(''), draftEpoch: draft.draftEpoch };
    if (replyToId) request.targetMessageId = replyToId;
    renderAssist();
    return call(request);
  }
  /** Adopting fills the composer only; the user still presses 发送. A non-empty draft asks replace or append first. */
  function adoptCard() {
    const s = snap?.suggestion, catId = snap?.me?.cat?.id;
    if (!C || s?.state !== 'ready' || !catId) return;
    draft = C.edit(draft, input.value);
    const offered = C.adopt(draft, s, catId);
    if (offered === draft) return;
    draft = offered;
    if (draft.pendingAdopt) { renderDraft(); choiceReplace.focus?.(); return; }
    applyDraft(); call({ action: 'suggest-discard' });
  }
  function chooseAdopt(choice) {
    if (!C || !draft.pendingAdopt) return;
    draft = C.chooseAdopt(draft, choice);
    if (choice === 'cancel') { renderDraft(); input.focus?.(); return; }
    applyDraft(); call({ action: 'suggest-discard' });
  }
  function undoReplace() { if (!C || !draft.undo) return; draft = C.undoReplace(draft); applyDraft(); }
  function applyDraft() {
    input.value = draft.text; if (!input.value.trim()) picked = [];
    setReply(draft.replyToId, { discard: false }); renderCounter(); renderDraft();
    input.focus?.(); input.setSelectionRange?.(input.value.length, input.value.length);
  }
  function renderDraft() {
    const on = !!(C && draft?.assistCatId);
    marker.hidden = !on; marker.textContent = on ? '人＋AI · 与' + (snap?.me?.cat?.name || '猫猫') + '共同回复' : '';
    form.dataset.assist = String(on);
    choiceBar.hidden = !(C && draft?.pendingAdopt); undoBar.hidden = !(C && draft?.undo);
  }
  function renderCard() {
    const s = snap?.suggestion, key = JSON.stringify([s, snap?.cat?.error || '', !!draft?.pendingAdopt]);
    card.hidden = !s;
    if (key === cardKey) return; cardKey = key;
    if (!s) { card.replaceChildren(); return; }
    card.dataset.state = s.state;
    const target = s.targetId ? findMessage(s.targetId) : null, items = [];
    items.push(el('div', 'neko-lobby-card__title', target ? '她的建议 · 回复 ' + originLabel(target.origin, target.label, target.author) : '她的建议'));
    const row = el('div', 'neko-lobby-card__actions');
    const regenerate = () => button('重新生成', 'neko-lobby-card-regenerate', () => requestAssist(s.targetId ?? null));
    const discard = () => button('放弃', 'neko-lobby-card-discard', () => call({ action: 'suggest-discard' }));
    if (s.state === 'generating') {
      items.push(el('p', 'neko-lobby-card__status', '她在想…'));
      row.append(button('取消', 'neko-lobby-card-cancel', () => call({ action: 'suggest-cancel' })));
    } else if (s.state === 'ready') {
      items.push(richText(s.text, 'neko-lobby-card__text'));
      const adopt = button('采用', 'neko-lobby-card-adopt', () => adoptCard()); adopt.disabled = !!draft?.pendingAdopt;
      adopt.title = '放进输入框，你看过再按发送';
      row.append(adopt, regenerate(), discard());
    } else {
      items.push(el('p', 'neko-lobby-card__status', snap?.cat?.error || '她这次没想出来'));
      row.append(regenerate(), discard());
    }
    items.push(row); card.replaceChildren(...items);
  }
  function renderAssist() {
    const on = assistOn(); const show = on && connection() === 'online' && joined; assist.hidden = !show;
    if (!show) { card.hidden = true; return; }
    const nudge = snap?.nudge, showNudge = !!nudge && nudge.messageId !== nudgeSeen && !!findMessage(nudge.messageId);
    nudgeLine.hidden = !showNudge;
    nudgeText.textContent = showNudge ? (nudge.who === 'cat' ? '有人 @ 了她，要她帮你想想怎么回吗？' : '有人 @ 了你，要她帮你想想怎么回吗？') : '';
    const s = snap?.suggestion, generating = s?.state === 'generating';
    assistToggle.setAttribute('aria-expanded', String(assistOpen || !!s)); assistToggle.textContent = assistOpen || s ? '收起私下商量' : '和她私下商量';
    assistBody.hidden = !assistOpen && !s;
    assistAsk.disabled = generating; nudgeHelp.disabled = generating;
    assistAsk.textContent = replyToId ? '请她帮我回这条' : '请她帮我想';
    renderCard();
  }
  // ---- delete (admins, or the author of a human message) and the member list ----
  /** Two-step button: the first click arms it, the second runs it, blur disarms. */
  function confirmButton(label, armed, className, run) {
    const b = button(label, className, () => { if (b.dataset.armed !== 'true') { b.dataset.armed = 'true'; b.textContent = armed; return; } b.disabled = true; run(); });
    b.addEventListener('blur', () => { b.dataset.armed = 'false'; b.textContent = label; });
    return b;
  }
  function deleteButton(m) {
    const own = m.author?.kind === 'human' && ownHuman(m.author);
    if (!own && !isAdmin()) return null;
    const b = confirmButton('删除', '确认删除', 'neko-lobby-delete', () => call({ action: 'admin-delete', messageId: m.id }));
    if (!own) b.dataset.admin = '';
    b.setAttribute('aria-label', '删除这条消息');
    return b;
  }
  const mutedNow = m => Number.isFinite(m.muted_until) && m.muted_until > Date.now();
  function memberMenu(m) {
    const menu = el('div', 'neko-lobby-member-menu'); menu.dataset.admin = ''; menu.setAttribute('role', 'menu');
    const item = (label, request, className = '') => { const b = button(label, 'neko-lobby-member-action ' + className, () => { menuFor = null; call(request); }); b.setAttribute('role', 'menuitem'); return b; };
    if (m.kind === 'cat') {
      menu.append(m.admin_disabled ? item('恢复猫娘', { action: 'admin-cat', catId: m.cat_id, disable: false }, 'neko-lobby-cat-enable')
        : item('禁用猫娘', { action: 'admin-cat', catId: m.cat_id, disable: true }, 'neko-lobby-cat-disable'));
      return menu;
    }
    if (!m.banned_at) for (const [minutes, label] of MUTES) menu.appendChild(item(label, { action: 'admin-mute', userId: m.user_id, minutes }, 'neko-lobby-mute'));
    if (mutedNow(m)) menu.appendChild(item('解除禁言', { action: 'admin-unmute', userId: m.user_id }, 'neko-lobby-unmute'));
    if (m.banned_at) menu.appendChild(item('解封', { action: 'admin-unban', userId: m.user_id }, 'neko-lobby-unban'));
    else { const ban = confirmButton('封禁', '确认封禁', 'neko-lobby-member-action neko-lobby-ban', () => { menuFor = null; call({ action: 'admin-ban', userId: m.user_id }); }); ban.setAttribute('role', 'menuitem'); menu.appendChild(ban); }
    return menu;
  }
  function memberItem(m) {
    const cat = m.kind === 'cat', key = cat ? 'c:' + m.cat_id : 'u:' + m.user_id;
    const li = el('li', 'neko-lobby-member'); li.dataset.kind = cat ? 'cat' : 'human'; li.dataset.online = String(!!m.online); li.dataset.key = key;
    const name = cat ? (ownCat(m) ? '我的' + (m.name || '猫猫') : m.display_name || m.name || '猫猫') : (ownHuman(m) ? '我' : m.display_name || m.name || '成员');
    const line = el('div', 'neko-lobby-member__line'), dotNode = el('span', 'neko-lobby-member__dot'); dotNode.setAttribute('aria-hidden', 'true');
    line.append(dotNode, avatarNode(m), el('span', 'neko-lobby-member__name', (cat ? '🐾 ' : '') + name));
    const tags = [];
    if (!cat && m.role === 'admin') tags.push('管理员');
    if (!cat && m.banned_at) tags.push('已封禁'); else if (!cat && mutedNow(m)) tags.push('禁言中');
    if (cat && m.admin_disabled) tags.push('已停用');
    for (const tag of tags) line.appendChild(el('span', 'neko-lobby-member__tag', tag));
    li.setAttribute('aria-label', name + (m.online ? '，在线' : '，离线') + (tags.length ? '，' + tags.join('，') : ''));
    if (isAdmin() && !(m.kind === 'human' && ownHuman(m))) {
      const more = button('⋯', 'neko-lobby-member-more', () => { menuFor = menuFor === key ? null : key; membersKey = ''; renderMembers(); });
      more.dataset.admin = ''; more.setAttribute('aria-label', '管理 ' + name); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', String(menuFor === key));
      line.appendChild(more);
    }
    li.appendChild(line);
    if (menuFor === key && isAdmin()) li.appendChild(memberMenu(m));
    return li;
  }
  /** Online humans first (offline greyed), each human's cats listed right under the owner. */
  function renderMembers() {
    const list = snap?.members || [], key = JSON.stringify([meId(), isAdmin(), menuFor, list]);
    members.hidden = connection() !== 'online'; if (key === membersKey) return; membersKey = key;
    const humans = list.filter(m => m.kind === 'human'), cats = list.filter(m => m.kind === 'cat');
    const rank = m => (ownHuman(m) ? 0 : m.online ? 1 : 2);
    humans.sort((a, b) => rank(a) - rank(b) || String(a.display_name || a.name || '').localeCompare(String(b.display_name || b.name || ''), 'zh'));
    const items = [], placed = new Set();
    for (const h of humans) {
      items.push(memberItem(h));
      for (const c of cats) if (c.owner_user_id === h.user_id) { const li = memberItem(c); li.dataset.owner = h.user_id; items.push(li); placed.add(c); }
    }
    for (const c of cats) if (!placed.has(c)) items.push(memberItem(c));
    memberList.replaceChildren(...items);
    membersTitle.textContent = '成员 · ' + humans.filter(m => m.online).length + ' 在线';
  }
  // ---- 猫猫设置 and 管理 dialogs: built when opened, so a snapshot push never wipes what the user is typing ----
  function field(labelText, control, hint) {
    const label = el('label', 'neko-lobby-field'); label.append(el('span', 'neko-lobby-field__label', labelText), control);
    if (hint) label.appendChild(el('span', 'neko-lobby-field__hint', hint));
    return label;
  }
  function choiceGroup(name, options, current, disabled = () => false) {
    const group = el('div', 'neko-lobby-choices'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', name);
    const buttons = options.map(([value, label]) => {
      const b = button(label, 'neko-lobby-choice', () => { if (b.disabled) return; group.dataset.value = value; for (const x of buttons) x.setAttribute('aria-checked', String(x === b)); });
      b.dataset.value = value; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(value === current)); b.disabled = disabled(value);
      return b;
    });
    group.dataset.value = current; group.append(...buttons);
    return group;
  }
  function closeDialog() { if (!dialog) return; const from = dialog.from; dialog.node.remove(); dialog = null; from?.focus?.(); }
  function openDialog(kind) {
    closeDialog();
    if (kind === 'admin' && !isAdmin()) return;
    const node = el('div', 'neko-lobby-dialog'), box = el('form', 'neko-lobby-dialog__card');
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.dataset.dialog = kind;
    if (kind === 'admin') node.dataset.admin = '';
    const heading = el('h2', 'neko-lobby-dialog__title', kind === 'cat' ? '猫猫设置' : '频道管理'); heading.id = 'neko-lobby-dialog-title'; node.setAttribute('aria-labelledby', heading.id);
    const status = el('p', 'neko-lobby-dialog__error'); status.setAttribute('role', 'status'); status.hidden = true;
    const save = el('button', 'neko-lobby-dialog-save', '保存'); save.type = 'submit';
    const footer = el('div', 'neko-lobby-dialog__footer'); footer.append(button('取消', 'neko-lobby-dialog-cancel', () => closeDialog()), save);
    const build = kind === 'cat' ? catFields() : adminFields();
    box.append(heading, ...build.nodes, status, footer); node.appendChild(box);
    box.addEventListener('submit', async event => {
      event.preventDefault();
      const request = build.request();
      if (typeof request === 'string') { status.textContent = request; status.hidden = false; return; }
      if (!request) { closeDialog(); return; }
      save.disabled = true;
      const result = await call(request);
      if (!dialog || dialog.node !== node) return;
      save.disabled = false;
      if (result?.ok === false) { status.textContent = result.error || '保存失败'; status.hidden = false; return; }
      closeDialog();
    });
    node.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); } });
    node.addEventListener('mousedown', event => { if (event.target === node) closeDialog(); });
    dialog = { kind, node, from: doc.activeElement };
    panel.appendChild(node); (box.querySelector('input,textarea,button:not(:disabled)'))?.focus?.();
  }
  function catFields() {
    const settings = snap?.catSettings || {}, part = snap?.participation || {}, own = snap?.me?.cat;
    const myName = snap?.me?.display_name || snap?.me?.name || '我';
    const startName = settings.name || own?.name || '大肥鱼', startAvatar = settings.avatarKey && settings.avatarKey !== 'default' ? settings.avatarKey : own?.avatar_key || 'bigfish';
    const startMode = settings.mode || part.mode || 'assist';
    const needsApi = !part.available;
    const api = el('p', 'neko-lobby-cat-api'); api.dataset.ready = String(!needsApi);
    api.textContent = needsApi ? (part.reason || '需要聊天 API') + '。现在只能选「她不参与」，你自己照常聊天，私聊不受影响。' : '已连接你的聊天 API';
    const mode = choiceGroup('参与方式', MODES, needsApi ? 'off' : startMode, value => value !== 'off' && needsApi); mode.classList.add('neko-lobby-cat-mode');
    const name = el('input', 'neko-lobby-cat-name'); name.maxLength = 32; name.value = startName; name.setAttribute('aria-label', '猫娘名字');
    const preview = el('span', 'neko-lobby-cat-preview');
    const sync = () => { const n = name.value.trim() || '大肥鱼'; preview.textContent = '你看到「我的' + n + '」，别人看到「' + myName + '的' + n + '」'; };
    name.addEventListener('input', sync); sync();
    const avatars = el('div', 'neko-lobby-cat-avatars'); avatars.setAttribute('role', 'radiogroup'); avatars.setAttribute('aria-label', '猫娘头像'); avatars.dataset.value = startAvatar;
    const avatarButtons = CAT_AVATARS.map(([id, label]) => {
      const b = button('', 'neko-lobby-cat-avatar', () => { avatars.dataset.value = id; for (const x of avatarButtons) x.setAttribute('aria-checked', String(x === b)); });
      b.dataset.value = id; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', label); b.setAttribute('aria-checked', String(id === startAvatar));
      b.appendChild(image(avatar(id), 'neko-lobby-cat-avatar__img')); return b;
    });
    avatars.append(...avatarButtons);
    const trigger = choiceGroup('她自己说话时什么时候开口', TRIGGERS, settings.independentTrigger || 'mention'); trigger.classList.add('neko-lobby-cat-trigger');
    const note = el('textarea', 'neko-lobby-cat-note'); note.maxLength = 500; note.rows = 3; note.value = settings.note || '';
    note.placeholder = '可选：大厅里所有人都可能读到她按这段说明说的话'; note.setAttribute('aria-label', '频道补充说明');
    const usage = snap?.cat?.usage;
    const cost = el('p', 'neko-lobby-cat-cost', '猫猫回复使用你自己的聊天 API，自由发言会消耗更多额度。' + (usage && Number.isFinite(usage.today) ? '今日已用 ' + usage.today + ' / ' + usage.limit + ' 次。' : ''));
    const nodes = [api, field('参与方式', mode), field('名字', name, ''), preview, field('头像', avatars), field('她自己说话时', trigger), field('频道补充说明（公开）', note, '最多 500 字。别写私事，这段会影响她在公共频道里的发言。'), cost];
    function request() {
      const out = { action: 'cat-save' }, n = name.value.trim();
      if (!n || Array.from(n).length > 32) return '猫娘名字 1–32 字';
      if (n !== startName) out.name = n;
      if (avatars.dataset.value !== startAvatar) out.avatarKey = avatars.dataset.value;
      if (!needsApi && mode.dataset.value !== startMode) out.mode = mode.dataset.value;   // without a provider only 她不参与 is possible; keep the saved choice
      if (trigger.dataset.value !== (settings.independentTrigger || 'mention')) out.independentTrigger = trigger.dataset.value;
      if (note.value !== (settings.note || '')) out.note = note.value;
      return Object.keys(out).length > 1 ? out : null;
    }
    return { nodes, request };
  }
  function adminFields() {
    const channel = snap?.channel || {};
    const name = el('input', 'neko-lobby-admin-name'); name.maxLength = 32; name.value = channel.name || '';
    const topic = el('textarea', 'neko-lobby-admin-topic'); topic.maxLength = 500; topic.rows = 3; topic.value = channel.topic || '';
    const slow = el('select', 'neko-lobby-admin-slow');
    for (const [value, label] of SLOW) { const o = el('option', '', label); o.value = String(value); slow.appendChild(o); }
    slow.value = String(SLOW.some(([v]) => v === channel.slow_mode_seconds) ? channel.slow_mode_seconds : 0);
    const check = (className, on) => { const c = el('input', className); c.type = 'checkbox'; c.checked = !!on; return c; };
    const cats = check('neko-lobby-admin-cats', channel.cats_enabled !== false), free = check('neko-lobby-admin-free', !!channel.cat_free_mode_allowed);
    const nodes = [field('频道名称', name), field('频道话题', topic), field('慢速模式', slow, '每位成员两次发言之间的最短间隔'),
      field('允许猫娘参与', cats), field('允许猫娘自由发言', free, '关闭后，她自己说话只在被 @ 或主人说话时开口')];
    function request() {
      const out = { action: 'admin-channel' }, n = name.value.trim();
      if (!n || Array.from(n).length > 32) return '频道名字 1–32 字';
      if (n !== (channel.name || '')) out.name = n;
      if (topic.value !== (channel.topic || '')) out.topic = topic.value;
      if (Number(slow.value) !== (channel.slow_mode_seconds ?? 0)) out.slowModeSeconds = Number(slow.value);
      if (cats.checked !== (channel.cats_enabled !== false)) out.catsEnabled = cats.checked;
      if (free.checked !== !!channel.cat_free_mode_allowed) out.catFreeAllowed = free.checked;
      return Object.keys(out).length > 1 ? out : null;
    }
    return { nodes, request };
  }
  // ---- render ----
  const CONNECTION_TEXT = { online: '大厅已连接', connecting: '正在连接大厅…', offline: '大厅未连接', 'signed-out': '未登录频道', unconfigured: '频道服务未配置' };
  function setDot(node, on, text) { node.dataset.on = String(!!on); node.textContent = text; node.title = text; }
  function renderStatus() {
    if (disposed) return;
    const chat = companion?.() || {}, part = snap?.participation || { mode: 'off', available: false, reason: '' };
    setDot(privateDot, !!chat.ready, chat.ready ? '私聊可用' : '私聊未连接');
    setDot(connectionDot, connection() === 'online', CONNECTION_TEXT[connection()] || '大厅未连接');
    const active = part.available && part.mode !== 'off';
    setDot(participationDot, active, !part.available ? '她暂不能参与' : part.mode === 'off' ? '她不参与' : part.mode === 'assist' ? '她在陪你一起回复' : '她在自己说话');
    const current = part.available ? part.mode : 'off';
    for (const b of modeButtons) { b.setAttribute('aria-pressed', String(b.dataset.mode === current)); b.disabled = b.dataset.mode !== 'off' && !part.available; }
    reason.textContent = part.available ? '' : part.reason || ''; reason.hidden = !reason.textContent;
  }
  let identityKey = '';
  function renderLog() {
    const key = JSON.stringify([meId(), isAdmin(), assistOn(), (snap?.members || []).map(m => [m.kind, m.user_id || m.cat_id, m.name, m.display_name])]);
    if (key !== identityKey) { identityKey = key; rows.clear(); }
    const messages = snap?.messages || [], outbox = (snap?.outbox || []).filter(e => e.kind === 'human');
    const nodes = [];
    const live = new Set();
    for (const m of messages) {
      const rowKey = JSON.stringify(m) + (m.reply_to ? JSON.stringify(findMessage(m.reply_to.id)) : '');
      let cached = rows.get(m.id);
      if (!cached || cached.key !== rowKey) { cached = { key: rowKey, node: messageRow(m) }; rows.set(m.id, cached); }
      live.add(m.id); nodes.push(cached.node);
    }
    for (const id of [...rows.keys()]) if (!live.has(id)) rows.delete(id);
    for (const entry of outbox) nodes.push(outboxRow(entry));
    const shown = nodes.slice(-MAX_NODES);
    const bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...(shown.length ? shown : [empty]));
    if (bottom) log.scrollTop = log.scrollHeight;
  }
  function render() {
    if (disposed) return;
    const conn = connection(), auth = snap?.auth || {}, channel = snap?.channel;
    title.textContent = channel?.name || '频道'; topic.textContent = channel?.topic || ''; topic.hidden = !topic.textContent;
    const humans = (snap?.members || []).filter(m => m.kind === 'human' && m.online).length;
    onlineCount.textContent = conn === 'online' ? humans + ' 人在线' : ''; onlineCount.hidden = !onlineCount.textContent;
    signOut.hidden = conn === 'unconfigured' || conn === 'signed-out';
    gate.hidden = conn === 'online';
    gateText.textContent = conn === 'unconfigured' ? (auth.message || '频道服务未配置。') : conn === 'signed-out' ? (auth.signingIn ? '请在浏览器里完成社区账号授权…' : auth.message || '登录后即可进入频道。')
      : conn === 'connecting' ? '正在连接频道…' : '频道暂时连不上，私聊不受影响。';
    signIn.hidden = conn !== 'signed-out' || !!auth.signingIn; signInCancel.hidden = !(conn === 'signed-out' && auth.signingIn); reconnect.hidden = conn !== 'offline';
    older.hidden = conn !== 'online' || !snap?.hasMore;
    renderLog();
    const muted = Number.isFinite(snap?.me?.muted_until) && snap.me.muted_until > Date.now(), banned = !!snap?.me?.banned_at;
    input.disabled = conn !== 'online' || muted || banned; send.disabled = input.disabled || sending;
    input.placeholder = banned ? '你已被频道封禁' : muted ? '你正在禁言中' : conn === 'online' ? '在频道里说点什么… Enter 发送，Shift+Enter 换行，@ 提及成员' : '连接频道后才能发言';
    if (replyToId && !findMessage(replyToId)) setReply(null);
    notice.textContent = error || snap?.error || ''; notice.hidden = !notice.textContent;
    // Admin controls exist in the DOM only for admins (not merely hidden).
    if (isAdmin()) { if (!adminButton.isConnected) headerActions.insertBefore(adminButton, signOut); } else { adminButton.remove(); if (dialog?.kind === 'admin') closeDialog(); }
    catSettingsButton.hidden = conn !== 'online' || !snap?.me;
    const mode = snap?.participation?.available ? snap.participation.mode : 'off';
    if (lastMode !== null && mode !== lastMode && C) draft = C.modeChanged(draft);
    lastMode = mode;
    if (C && !input.value.trim() && draft.assistCatId) draft = C.edit(draft, '');
    renderMembers(); renderDraft(); renderAssist();
    railButton.dataset.connection = conn;
    renderStatus();
  }
  function place(style) { Object.assign(panel.style, { left: style.left, top: style.top, width: style.width, height: style.height }); }
  let release = null;
  if (typeof bridge.subscribeLobby === 'function') {
    try { release = bridge.subscribeLobby(next => { if (disposed || !next || typeof next !== 'object') return; snap = next; render(); if (open && !joined) join(); }); } catch { release = null; }
  }
  call({ action: 'state' });
  render();
  function dispose() {
    if (disposed) return;
    if (joined) { joined = false; try { Promise.resolve(bridge.lobby({ action: 'close' })).catch(() => {}); } catch {} }
    disposed = true; if (typeof release === 'function') release(); rows.clear(); if (dialog) { dialog.node.remove(); dialog = null; } panel.remove(); railButton.remove();
  }
  return { panel, railButton, show, hide, isOpen: () => open, place, renderStatus, dispose };
}
