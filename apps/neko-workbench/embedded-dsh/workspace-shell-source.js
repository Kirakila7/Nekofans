function installWorkspaceShell(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const bridge = options.bridge || win?.nekoWorkbench;
  if (!doc?.body || !win?.MutationObserver || typeof bridge?.workspace !== 'function' || typeof bridge.companion !== 'function' || doc.querySelector('[data-neko-workspace-shell]')) return () => {};
  const el = (tag, className, text) => { const n = doc.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, className, click) => { const n = el('button', className, label); n.type = 'button'; if (click) n.addEventListener('click', click); return n; };
  const image = (src, className) => { const n = el('img', className); n.alt = ''; n.draggable = false; if (src) n.src = src; return n; };
  // Claude娘 is an office-only portrait. Daily surfaces keep the retired
  // portrait mapped to 大肥鱼; no Claude platform or role entry is restored.
  const avatar = id => options.avatar?.(id === 'claude' && layout?.workbenchEdition !== 'office' ? 'bigfish' : id) || '';
  const style = el('style'); style.dataset.nekoWorkspaceShell = ''; style.textContent = options.cssText || ''; doc.head.appendChild(style);
  let disposed = false, queued = false, layout = null, state = null, catalog = null, selectedProject = '', selectedId = null, searchText = '', layoutVersion = -1, listLoading = false, sending = false, socialOpen = false;
  // The in-page chooser is a fallback only; the native composer owns its own
  // project list when its bridge is available, so never show both at once.
  let startupOpen = true, startupSearchText = '', catalogError = '', startupError = '', startupOpening = false, startupOpeningMessage = '', floatingRecordsOpen = !(typeof bridge.nativeComposer === 'function' && typeof bridge.subscribeNativeComposer === 'function');
  let sidebarOpening = null, sidebarOpenError = '', projectListKey = '';
  let nativeNewPending = false, nativeNewTimer = null, nativeNewBefore = null;
  let office = { status: 'idle', thread: null, items: [], approvals: [], error: '' };
  const nativeMarks = new Map(), nodes = [], releases = [], drafts = new Map(), groupOpen = new Set(), groupSearchCollapsed = new Set(), startupCollapsed = new Set(), startupSearchCollapsed = new Set();
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
  // Project retired engine UI into the current work surface without rewriting
  // saved engine selections, seat bindings, sessions or drafts.
  const visibleLayout = value => value?.officeMode === 'codex' ? {...value, officeMode:'dsh'} : value;
  const visibleSeats = () => (layout?.seats || []).filter(seat => seat.provider !== 'codex');
  const isOfficeEdition = () => layout?.workbenchEdition === 'office';
  const isDailyEdition = () => layout?.workbenchEdition === 'daily';
  let appliedEdition = null, dailyRoom = null, editionSaving = false;
  const hideSocial = () => { options.hideSocial?.(); socialOpen = false; };
  function markNative(node, name) { if (!node) return; if (!nativeMarks.has(node)) nativeMarks.set(node, new Map()); const attrs = nativeMarks.get(node); if (!attrs.has(name)) attrs.set(name, node.getAttribute(name)); if (!node.hasAttribute(name)) node.setAttribute(name, ''); }
  const railTop = own(el('div', 'neko-workspace-rail-controls'));
  const officeButton = own(button('', 'neko-side-rail__button neko-office-switch', async () => {
    if (editionSaving) return;
    editionSaving = true; officeButton.disabled = true;
    try { if (!await saveLayout({workbenchEdition:isOfficeEdition() ? 'daily' : 'office'})) officeButton.title = '切换未完成，请重试'; }
    finally { editionSaving = false; officeButton.disabled = false; }
  }));
  officeButton.setAttribute('aria-label', '切换办公版或日常版'); officeButton.title = '切换办公版 / 日常版';
  const officeImage = image(avatar('bigfish'), 'neko-edition-avatar'); officeButton.append(officeImage);
  const settingsButton = button('⚙', 'neko-side-rail__button neko-workspace-settings', () => openSettings('general'));
  settingsButton.setAttribute('aria-label', '工作台设置'); settingsButton.title = '工作台设置';
  const communityButton = button('', 'neko-side-rail__button neko-community neko-community-yui', () => { closeSettings(); lobby?.hide(); Promise.resolve(options.openCommunity?.()).catch(showError); });
  communityButton.setAttribute('aria-label','N.E.K.O. 社区');communityButton.title='N.E.K.O. 社区';
  const communitySvg=doc.createElementNS('http://www.w3.org/2000/svg','svg'),communityPath=doc.createElementNS('http://www.w3.org/2000/svg','path');communitySvg.setAttribute('viewBox','0 0 24 24');communitySvg.setAttribute('aria-hidden','true');for(const [key,value]of Object.entries({d:'M15.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM5 20v-2a5 5 0 0 1 10 0v2M18 9a3 3 0 0 1 3 3M18 15a4 4 0 0 1 3 4',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round'}))communityPath.setAttribute(key,value);communitySvg.append(communityPath);communityButton.append(communitySvg);
  railTop.append(communityButton);
  const memoryButton=button('', 'neko-side-rail__button neko-memory', async()=>{
    if(memoryButton.disabled)return;memoryButton.disabled=true;memoryButton.setAttribute('aria-busy','true');
    try{await bridge.action('chat-memory');}catch(error){showError(error);}finally{if(!disposed){memoryButton.disabled=false;memoryButton.removeAttribute('aria-busy');}}
  });
  memoryButton.setAttribute('aria-label','鱼的记忆');memoryButton.title='鱼的记忆';
  const memoryIcon=el('span','neko-memory-icon');memoryIcon.setAttribute('aria-hidden','true');memoryButton.append(memoryIcon);
  railTop.append(memoryButton);
  // Lobby (频道): optional. The room list opens it; older shells retain the rail fallback.
  const lobby = typeof bridge.lobby === 'function' ? createLobbyView({ doc, bridge, el, button, image, avatar, composer: options.lobbyComposer || (typeof WORKBENCH_LOBBY_COMPOSER !== 'undefined' ? WORKBENCH_LOBBY_COMPOSER : null) || win.WorkbenchLobbyComposer || null, companion: () => state?.companion, onOpen: () => { hideSocial(); closeSettings();roomPreview?.openLobby?.(); }, onBack: () => {roomPreview?.showRooms?.();Promise.resolve().then(() => roomPreview?.querySelector('button.neko-chatroom-preview__room')?.focus());}, onChange: () => { renderOffice(); schedule(); } }) : null;
  if (lobby) { own(lobby.panel); releases.push(lobby.dispose); }
  const leaveViews = () => { hideSocial(); lobby?.hide(); };
  // The room is a local visual preview. It never touches the work session or
  // the saved multi-pane layout. The original sidebar stays mounted behind it.
  const previewFactory = options.createChatroomPreview || (typeof createChatroomPreview === 'function' ? createChatroomPreview : null);
  let fishDateView=null;
  const isFishDateOpen=()=>!!fishDateView?.isOpen()&&roomActive&&!sideSocial&&isDailyEdition();
  const roomPreview = previewFactory ? own(previewFactory(doc, avatar, { mountHome: options.mountHome, onBeforeHome:()=>lobby?.hide(), onOpenLobby: lobby ? () => lobby.show() : undefined,
    createFishDate:typeof createFishDateView==='function'?()=>{fishDateView=createFishDateView({doc,bridge,avatar,onChange:schedule});releases.push(()=>fishDateView.dispose());return fishDateView.panel;}:undefined,
    onBeforeDate:()=>{lobby?.hide();closeSettings();},onDateVisibility:open=>{fishDateView?.setOpen(open);schedule();}
  })) : null;
  if (roomPreview?.disposeHome) releases.push(() => roomPreview.disposeHome());
  if (lobby && !roomPreview) railTop.appendChild(lobby.railButton);
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
  const roomInert = new Set(), roomMasked = new Set();
  const roomButton = roomPreview && button('', 'neko-side-rail__button neko-room-entry', () => { lobby?.hide(); setRoomActive(true); });
  const workButton = roomPreview && button('', 'neko-side-rail__button neko-room-workspace', () => { lobby?.hide(); setRoomActive(false); });
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
  function unmaskRoomBranch(node) {
    if (roomInert.delete(node)) node.removeAttribute('inert');
    if (roomMasked.delete(node)) node.removeAttribute('data-neko-room-masked');
  }
  function releaseRoomInert() {
    for (const node of roomInert) node.removeAttribute('inert');
    roomInert.clear();
    for (const node of roomMasked) node.removeAttribute('data-neko-room-masked');
    roomMasked.clear();
  }
  function protectRoomFooter(sidebar, account) {
    // Never inert the original main companion/account footer. Mark only the
    // branches that are wholly behind the preview and restore our marks later.
    // The original native tools nav remains in the sidebar DOM even when its
    // overlay is positioned elsewhere. Exempt only its path while it is open.
    const tools = sidebar.querySelector('nav[data-neko-tools="open"]');
    function visit(node) {
      if (node === dock || node === account || node.hasAttribute('data-neko-companion-footer')) { unmaskRoomBranch(node); return; }
      if (tools && node === tools) { unmaskRoomBranch(node); return; }
      if (node.contains(dock) || account && node.contains(account) || tools && node.contains(tools)) {
        unmaskRoomBranch(node);
        for (const child of node.children) visit(child); return;
      }
      if (!node.hasAttribute('inert')) { node.setAttribute('inert', ''); roomInert.add(node); }
      if (!node.hasAttribute('data-neko-room-masked')) { node.setAttribute('data-neko-room-masked', ''); roomMasked.add(node); }
    }
    for (const child of sidebar.children) visit(child);
  }
  function setRoomActive(active, { closeSocial = true } = {}) {
    if (!roomPreview || disposed) return;
    if (isOfficeEdition() && active) return;
    if (closeSocial && sideSocial) doc.dispatchEvent(new win.Event('neko-side-surface-close'));
    if (closeSocial) { sideSocial = false; roomSelection = !!active; }
    roomActive = !!active;
    // Leaving a social/office view closes the channel transport. Returning to
    // its selector should show a deliberate welcome state, not an empty right
    // column or an implicit network reconnect. A mounted home stays selected.
    if(roomActive&&roomPreview.dataset.roomView==='lobby'&&!lobby?.isOpen())roomPreview.showRooms?.();
    if (roomActive) { doc.body.setAttribute('data-neko-chatroom-active', ''); doc.querySelector('.neko-side-rail__expand:not([hidden])')?.click(); }
    else { doc.body.removeAttribute('data-neko-chatroom-active'); roomPreview.hidden = true; releaseRoomInert(); }
    roomButton.setAttribute('aria-pressed', String(roomActive)); workButton.setAttribute('aria-pressed', String(!roomActive));
    doc.dispatchEvent(new win.Event('neko-chatroom-mode-change'));
    schedule();
  }
  function sideSurfaceChanged(event) {
    const surface = event.detail?.surface;
    if (surface === 'community' || surface === 'bilibili' || surface === 'youtube') {
      lobby?.hide();
      sideSocial = true;
      setRoomActive(false, { closeSocial: false });
      roomButton?.setAttribute('aria-pressed', 'false'); workButton?.setAttribute('aria-pressed', 'false');
    } else if (surface === 'hidden' && sideSocial) {
      sideSocial = false;
      setRoomActive(roomSelection, { closeSocial: false });
    }
  }
  doc.addEventListener('neko-side-surface-change', sideSurfaceChanged);
  function showWorkspaceFromLayout() { if (!isDailyEdition()) setRoomActive(false); }
  if (roomPreview) { roomButton.setAttribute('aria-pressed', 'true'); workButton.setAttribute('aria-pressed', 'false'); doc.addEventListener('neko-chatroom-show-workspace', showWorkspaceFromLayout); }
  const seats = own(el('div', 'neko-custom-seats')); seats.setAttribute('role', 'group'); seats.setAttribute('aria-label', '自定义工作 agent');
  const sessionBrowser = own(el('section', 'neko-session-browser')); sessionBrowser.setAttribute('aria-label', '全部工作会话');
  const listHeader = el('div', 'neko-session-browser__header');
  const allButton = button('全部工作会话', 'neko-session-all', () => saveLayout({ activeSeatId: null }));
  const refreshButton = button('↻', 'neko-session-refresh', () => refreshCatalog(true)); refreshButton.setAttribute('aria-label', '刷新本地工作会话');
  listHeader.append(allButton, refreshButton);
  const search = el('input', 'neko-session-search'); search.type = 'search'; search.placeholder = '搜索工作会话或项目'; search.setAttribute('aria-label', '搜索工作会话或项目'); search.addEventListener('input', () => { searchText = search.value.trim().toLowerCase(); groupSearchCollapsed.clear(); renderCatalog(); });
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
  startupSearch.addEventListener('input', () => { startupSearchText = startupSearch.value.trim().toLowerCase(); startupSearchCollapsed.clear(); renderStartup(); });
  const startupToolbar = el('div', 'neko-startup__toolbar'), startupTitle = el('strong', '', '本地工作项目');
  const startupRefresh = button('刷新', 'neko-startup__refresh', () => refreshCatalog(true));
  startupToolbar.append(startupTitle, startupRefresh);
  const startupStatus = el('p', 'neko-startup__status', '正在读取本地工作会话…'); startupStatus.setAttribute('role', 'status'); startupStatus.setAttribute('aria-live', 'polite');
  const startupProjects = el('div', 'neko-startup__projects');
  startupInner.append(startupHead, startupSearch, startupToolbar, startupStatus, startupProjects); startup.appendChild(startupInner); doc.body.appendChild(startup);
  // The fixed social/video/work view uses the same real project picker as the
  // ordinary workbench. It does not switch away from the currently shown video.
  const sceneProjects = own(button('项目与会话', 'neko-scene-projects', () => showStartup()));
  sceneProjects.hidden = true; sceneProjects.setAttribute('aria-label', '选择工作项目或会话'); doc.body.appendChild(sceneProjects);
  function onFixedSceneEnter() { nativeRecordsOpen = false; floatingGeometry = ''; closeStartup(); schedule(); }
  function onFixedSceneExit() { sceneProjects.hidden = true; closeStartup(); schedule(); }
  doc.addEventListener('neko-fixed-scene-enter', onFixedSceneEnter);
  doc.addEventListener('neko-fixed-scene-exit', onFixedSceneExit);
  // A lightweight shortcut into DSH's own session-scoped file tree. It never
  // enumerates paths itself or changes the selected session or draft.
  const directoryControl = own(el('div', 'neko-workspace-directory'));
  const directoryButton = button('', 'neko-workspace-directory__button', () => {
    let message = '';
    if (layout?.officeMode !== 'dsh') message = '当前工作界面暂不支持项目目录';
    else if (startupOpen || !hasActiveDshSession()) message = '请先打开工作会话，再查看项目目录';
    else if (typeof options.openDshFiles !== 'function') message = '项目目录暂不可用';
    else {
      try { options.openDshFiles(directoryButton); }
      catch { message = '项目目录暂未打开，请重试'; }
    }
    directoryStatus.textContent = message;
    directoryStatus.hidden = !message;
  });
  directoryButton.title = '打开当前项目目录'; directoryButton.setAttribute('aria-label', '打开当前项目目录');
  const directoryIcon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  directoryIcon.setAttribute('viewBox', '0 0 24 24'); directoryIcon.setAttribute('aria-hidden', 'true');
  const folderPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [name, value] of Object.entries({ d:'M3.5 6h6l2 2h9v10.5h-17z', fill:'none', stroke:'currentColor', 'stroke-width':'1.7', 'stroke-linejoin':'round' })) folderPath.setAttribute(name, value);
  directoryIcon.appendChild(folderPath); directoryButton.appendChild(directoryIcon);
  const directoryStatus = el('span', 'neko-workspace-directory__status'); directoryStatus.hidden = true; directoryStatus.setAttribute('role', 'status'); directoryStatus.setAttribute('aria-live', 'polite');
  directoryControl.append(directoryStatus, directoryButton); directoryControl.hidden = true; doc.body.appendChild(directoryControl);
  function stopNativeNew() { nativeNewPending = false; if (nativeNewTimer !== null) win.clearTimeout(nativeNewTimer); nativeNewTimer = null; }
  function beginNativeNew() {
    stopNativeNew(); nativeNewBefore = nativeSelection()?.sessionId || null; nativeNewPending = true;
    nativeNewTimer = win.setTimeout(() => { nativeNewPending = false; nativeNewTimer = null; schedule(); }, 10000);
  }
  function nativeSelection() { try { const value = options.getDshSelection?.(); return value && typeof value === 'object' ? value : null; } catch { return null; } }
  function hasActiveDshSession() { try { return layout?.officeMode === 'dsh' && options.hasDshActiveSession?.() === true; } catch { return false; } }
  function closeStartup() { startupOpen = false; floatingRecordsOpen = false; startup.hidden = true; }
  function showStartup() { startupOpen = true; renderStartup(); schedule(); }
  function showNativeToolsPage() { closeStartup(); }
  doc.addEventListener('neko-native-tools-navigate', showNativeToolsPage);
  function renderStartup() {
    if (!startupOpen || disposed) return;
    startupRefresh.disabled = listLoading || startupOpening; startupContinue.disabled = startupOpening;
    startupProjects.setAttribute('aria-busy', String(listLoading || startupOpening));
    const rows = (catalog?.sessions || []).filter(row => row.provider !== 'codex' && (row.title + ' ' + row.cwd + ' ' + row.provider).toLowerCase().includes(startupSearchText));
    const groups = new Map();
    for (const row of rows) {
      const key = row.provider + ':' + row.cwd;
      if (!groups.has(key)) groups.set(key, { cwd: row.cwd, provider: row.provider, sessions: [] });
      groups.get(key).sessions.push(row);
    }
    startupProjects.replaceChildren(...[...groups.entries()].map(([key, group]) => {
      const section = el('section', 'neko-startup__project'), projectRow = el('div', 'neko-startup__project-row');
      // Search results begin expanded even if the project was previously
      // collapsed. Keep normal and search-time choices independent so clearing
      // the search restores the user's project list.
      const collapsed = startupSearchText ? startupSearchCollapsed : startupCollapsed;
      const header = button('', 'neko-startup__project-header', () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); renderStartup(); });
      const expanded = !collapsed.has(key); header.setAttribute('aria-expanded', String(expanded));
      const label = group.cwd?.split(/[\\\\/]/).filter(Boolean).at(-1) || '未指定项目';
      const title = el('strong', '', label); title.title = group.cwd || '未指定项目';
      header.append(title, el('span', 'neko-startup__provider', group.provider.toUpperCase())); projectRow.appendChild(header);
      const projectNew = button('新会话', 'neko-startup__project-new', async () => {
        if (startupOpening) return;
        startupOpening = true; startupOpeningMessage = '正在打开项目…'; startupError = ''; renderStartup();
        try { const scene = doc.body.hasAttribute('data-neko-fixed-scene'), wasFloating = floatingRecordsOpen && !scene; await openProject(group, { preserveSocial:scene }); if (wasFloating) doc.dispatchEvent(new win.Event('neko-workspace-expand')); }
        catch (error) { startupError = error?.message || '项目未能打开，请重试'; }
        finally { startupOpening = false; startupOpeningMessage = ''; renderStartup(); }
      });
      projectNew.setAttribute('aria-label', '在 ' + label + ' 新建工作会话');
      projectNew.disabled = !group.cwd || startupOpening || group.provider === 'codex' && (codexPaused() || catalog?.providers?.codex === 'testing');
      if (!group.cwd) projectNew.title = '该会话未关联项目';
      else if (group.provider === 'codex' && projectNew.disabled) projectNew.title = 'Codex 测试中，暂不可用';
      projectRow.appendChild(projectNew); section.appendChild(projectRow);
      for (const row of expanded ? group.sessions : []) {
        const item = button('', 'neko-startup__session', async () => {
          if (startupOpening) return;
          startupOpening = true; startupOpeningMessage = '正在打开会话…'; startupError = ''; renderStartup();
          try { const scene = doc.body.hasAttribute('data-neko-fixed-scene'), wasFloating = floatingRecordsOpen && !scene; if (await openSession(row, { preserveSocial:scene })) { closeStartup(); if (wasFloating) doc.dispatchEvent(new win.Event('neko-workspace-expand')); } }
          catch (error) { startupError = error?.message || '会话未能打开，请重试'; }
          finally { startupOpening = false; startupOpeningMessage = ''; renderStartup(); }
        });
        item.append(el('span', '', row.title), el('span', 'neko-startup__arrow', '›')); item.title = row.title;
        if (row.provider === 'codex' && (codexPaused() || catalog?.providers?.codex === 'testing')) { item.disabled = true; item.title = 'Codex 测试中，暂不可用'; item.firstChild.textContent += ' · 测试中'; }
        if (startupOpening) item.disabled = true;
        section.appendChild(item);
      }
      return section;
    }));
    if (catalog?.nextDshOffset != null) startupProjects.appendChild(button('加载更多 DSH 会话', 'neko-startup__more', () => refreshCatalog(true, catalog.nextDshOffset)));
    const unavailable = Object.entries(catalog?.providers || {}).filter(([name, status]) => name !== 'codex' && status !== 'ready' && status !== 'testing').map(([name]) => name.toUpperCase());
    const notices = [];
    if (startupOpening) notices.push(startupOpeningMessage);
    else if (startupError || catalogError) notices.push(startupError || catalogError);
    else if (listLoading) notices.push('正在读取本地工作会话…');
    else if (!rows.length) notices.push(startupSearchText ? '没有匹配的项目或会话' : '暂无可显示的工作会话');
    if (startupSearchText && catalog?.nextDshOffset != null) notices.push('仅搜索已加载的会话，可加载更多');
    if (unavailable.length) notices.push(unavailable.join('、') + ' 会话暂不可读取');
    startupStatus.textContent = notices.join(' · ');
  }
  const dock = own(el('section', 'neko-companion-dock')); dock.setAttribute('aria-label', '主 agent 聊天');
  const character = el('div', 'neko-companion-character');
  character.setAttribute('role', 'slider'); character.tabIndex = 0; character.setAttribute('aria-label', typeof bridge.home==='function'?'大肥鱼，点击回到我的小窝，右键互动，左右方向键移动':'大肥鱼，点击打开互动菜单，左右方向键移动'); character.setAttribute('aria-orientation', 'horizontal'); character.title = typeof bridge.home==='function'?'点击回家 · 右键互动 · 左右拖动':'点击互动 · 左右拖动 · Home 回到中间';
  let companionOffset = 0, companionDrag = null, suppressCompanionClick = false, companionInRail = false, dockIntersecting = null, observedDockParent = null;
  let roomCompanionX = 0, roomCompanionY = 0, roomCompanionBounds = null, companionSettingsAway = null;
  // Sprite column width used while 猫猫设置 is open (90px sprite * .844 + gap).
  const ROOM_COMPANION_NARROW = 84;
  function clearRoomCompanionGeometry() {
    roomCompanionBounds = null;
    for (const name of ['--neko-room-companion-sprite-height', '--neko-room-companion-panel-max-height']) if (doc.body.style.getPropertyValue(name)) doc.body.style.removeProperty(name);
  }
  function setRoomCompanionPosition(x, y) {
    const bounds = roomCompanionBounds;
    if (!bounds) return;
    roomCompanionX = Math.round(Math.max(bounds.minX, Math.min(bounds.maxX, Number.isFinite(x) ? x : 0)));
    // Below the resting line she may drop toward the channel input, but only
    // where no public control (modes, reason, dots, assist, form) is beneath.
    const maxY = typeof bounds.maxY === 'function' ? Math.max(0, Math.floor(bounds.maxY(roomCompanionX))) : 0;
    roomCompanionY = Math.round(Math.max(bounds.minY, Math.min(maxY, Number.isFinite(y) ? y : 0)));
    const geometry = { '--neko-companion-left': `${Math.round(bounds.left + roomCompanionX)}px`, '--neko-companion-bottom': `${Math.round(win.innerHeight - bounds.bottom - roomCompanionY)}px` };
    for (const [name, value] of Object.entries(geometry)) if (doc.body.style.getPropertyValue(name) !== value) doc.body.style.setProperty(name, value);
    character.setAttribute('aria-valuemin', String(bounds.minX)); character.setAttribute('aria-valuemax', String(bounds.maxX)); character.setAttribute('aria-valuenow', String(roomCompanionX));
    character.setAttribute('aria-valuetext', roomCompanionX === 0 && roomCompanionY === 0 ? '聊天框上方居中' : `水平 ${roomCompanionX}，垂直 ${roomCompanionY} 像素`);
  }
  function setCompanionOffset(value) {
    if (dock.hasAttribute('data-neko-companion-room-lobby')) {
      character.style.setProperty('--neko-companion-offset', '0px');
      if (doc.body.style.getPropertyValue('--neko-companion-offset') !== '0px') doc.body.style.setProperty('--neko-companion-offset', '0px');
      setRoomCompanionPosition(roomCompanionX, roomCompanionY); return;
    }
    const width = dock.clientWidth || dock.getBoundingClientRect().width;
    const spriteWidth = character.offsetWidth || 76;
    const safeWidth = dock.hasAttribute('data-neko-companion-lobby') ? Math.max(spriteWidth, Math.min(320, width)) : spriteWidth;
    const limit = Math.max(0, Math.floor(dock.hasAttribute('data-neko-companion-expanded') ? (width - safeWidth) / 2 - 8 : Math.min(48, (width - spriteWidth) / 2 - 8)));
    companionOffset = Math.round(Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0)));
    character.style.setProperty('--neko-companion-offset', companionOffset + 'px');
    const sharedOffset = companionOffset + 'px';
    if (doc.body.style.getPropertyValue('--neko-companion-offset') !== sharedOffset) doc.body.style.setProperty('--neko-companion-offset', sharedOffset);
    character.setAttribute('aria-valuemin', String(-Math.floor(limit))); character.setAttribute('aria-valuemax', String(Math.floor(limit))); character.setAttribute('aria-valuenow', String(companionOffset));
    character.setAttribute('aria-valuetext', companionOffset === 0 ? '居中' : (companionOffset < 0 ? '向左 ' : '向右 ') + Math.abs(companionOffset) + ' 像素');
  }
  character.addEventListener('pointerdown', event => {
    if (event.button !== 0 || companionDrag || companionInRail) return;
    suppressCompanionClick = false;
    const room = dock.hasAttribute('data-neko-companion-room-lobby') && !!roomCompanionBounds;
    setCompanionOffset(companionOffset); companionDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: companionOffset, room, roomX: roomCompanionX, roomY: roomCompanionY, moved: false };
    character.dataset.dragging = 'true'; event.preventDefault();
    try { character.setPointerCapture(event.pointerId); } catch {}
  });
  character.addEventListener('pointermove', event => {
    if (!companionDrag || companionDrag.pointerId !== event.pointerId) return;
    if (!companionDrag.moved && Math.hypot(event.clientX - companionDrag.x, event.clientY - companionDrag.y) > 5) { companionDrag.moved = true; closeCompanionMenu(false); }
    if (companionDrag.room) {
      if (companionDrag.moved) setRoomCompanionPosition(companionDrag.roomX + event.clientX - companionDrag.x, companionDrag.roomY + event.clientY - companionDrag.y);
    } else setCompanionOffset(companionDrag.offset + event.clientX - companionDrag.x);
  });
  const finishCompanionDrag = event => { if (!companionDrag || companionDrag.pointerId !== event.pointerId) return; suppressCompanionClick = companionDrag.moved || event.type !== 'pointerup'; companionDrag = null; character.removeAttribute('data-dragging'); try { character.releasePointerCapture(event.pointerId); } catch {} };
  character.addEventListener('pointerup', finishCompanionDrag); character.addEventListener('pointercancel', finishCompanionDrag); character.addEventListener('lostpointercapture', finishCompanionDrag);
  // A failed capture or release outside the window must not leave the pet
  // stuck in drag mode. Keep ordinary clicks and drag suppression unchanged.
  function finishCompanionOnBlur() { if (companionDrag) finishCompanionDrag({ pointerId: companionDrag.pointerId, type: 'blur' }); }
  function finishCompanionOnUnpressedMove(event) { if (companionDrag && event.pointerType === 'mouse' && event.buttons === 0) finishCompanionDrag({ pointerId: event.pointerId, type: 'pointercancel' }); }
  win.addEventListener('pointerup', finishCompanionDrag, true);
  win.addEventListener('pointercancel', finishCompanionDrag, true);
  win.addEventListener('pointermove', finishCompanionOnUnpressedMove, true);
  win.addEventListener('blur', finishCompanionOnBlur);
  character.addEventListener('dragstart', event => event.preventDefault());
  character.addEventListener('click', event => {
    if(isFishDateOpen()){fishDateView.focus();return;}
    if (companionInRail) return;
    if (suppressCompanionClick) { suppressCompanionClick = false; event.preventDefault(); return; }
    if (event.button === 0) {
      if (dock.hasAttribute('data-neko-companion-lobby')) setLobbyChatOpen(!lobbyChatOpen, true);
      else if(typeof bridge.home==='function')void returnCompanionHome(); else toggleCompanionMenu(character);
    }
  });
  character.addEventListener('keydown', event => {
    if (dock.hasAttribute('data-neko-companion-room-lobby') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) {
      event.preventDefault();
      setRoomCompanionPosition(event.key === 'Home' ? 0 : roomCompanionX + (event.key === 'ArrowLeft' ? -8 : event.key === 'ArrowRight' ? 8 : 0), event.key === 'Home' ? 0 : roomCompanionY + (event.key === 'ArrowUp' ? -8 : event.key === 'ArrowDown' ? 8 : 0)); return;
    }
    if(event.key==='ArrowDown'){event.preventDefault();toggleCompanionMenu(character);return;}
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (dock.hasAttribute('data-neko-companion-lobby')) setLobbyChatOpen(!lobbyChatOpen, true); else if(typeof bridge.home==='function')void returnCompanionHome(); else toggleCompanionMenu(character); return; }
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
  const companionReply = el('div', 'pet-bubble is-whisper neko-companion-reply'); companionReply.hidden = true;
  const companionReplyText = el('span', 'neko-companion-reply-text'); companionReply.appendChild(companionReplyText);
  companionReply.setAttribute('role', 'status'); companionReply.setAttribute('aria-live', 'polite');
  let lastReplySignature = null, replySnapshotReady = false, replyTimer = null, replyWasWorking = false, replyWasStreaming = false;
  function hideCompanionReply() { if (replyTimer !== null) win.clearTimeout(replyTimer); replyTimer = null; companionReply.hidden = true; companionReply.classList.remove('is-on'); }
  function updateCompanionReply(companion) {
    if (!companion) return;
    const reply = (companion.messages || []).filter(m => m.role === 'assistant' && typeof m.text === 'string' && m.text.trim()).at(-1);
    const signature = reply ? JSON.stringify([reply.id, reply.text]) : '';
    const changed = replySnapshotReady && signature !== lastReplySignature && !!reply;
    const justFinished = (replyWasWorking && !companion.working) || (replyWasStreaming && !reply?.streaming);
    replySnapshotReady = true; lastReplySignature = signature; replyWasWorking = !!companion.working; replyWasStreaming = !!reply?.streaming;
    if (!dock.hasAttribute('data-neko-companion-lobby')) { hideCompanionReply(); return; }
    if (changed) { companionReplyText.textContent = reply.text; companionReply.hidden = false; companionReply.classList.add('is-on'); }
    if (changed || justFinished) {
      if (replyTimer !== null) win.clearTimeout(replyTimer); replyTimer = null;
      if (!companion.working && !reply?.streaming && !companionReply.hidden) replyTimer = win.setTimeout(hideCompanionReply, 10000);
    }
  }
  const chatStatus = el('div', 'neko-companion-status'); chatStatus.hidden = true;
  const chatStatusText = el('span'); chatStatusText.setAttribute('role', 'status'); chatStatusText.setAttribute('aria-live', 'polite');
  const chatSetup = button('聊天设置', 'neko-companion-setup', async () => { const reconnect = state?.companion?.backend === 'deepseek-account' && state?.companion?.workbenchStatus === 'unavailable'; chatError = ''; try { await bridge.action(reconnect ? 'reconnect-workbench' : 'chat-settings'); } catch (error) { chatError = error.message || (reconnect ? '工作台未能重连，请重试' : '聊天设置未能打开'); renderCompanion(); } });
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
  form.append(historyToggle, chatInput, chatSend, chatStop);
  const companionChatPanel = el('div', 'neko-companion-chat-panel'); companionChatPanel.id = 'neko-companion-chat-panel';
  const companionChatClose=button('×','neko-companion-chat-close',()=>setLobbyChatOpen(false,true));companionChatClose.hidden=true;companionChatClose.setAttribute('aria-label','收起主 agent 聊天');companionChatClose.title='收起聊天';
  companionChatPanel.append(companionChatClose,history, form, chatStatus);
  let lobbyChatOpen = false;
  function setLobbyChatOpen(open, focus = false) {
    lobbyChatOpen = !!open;
    const inLobby = dock.hasAttribute('data-neko-companion-lobby');
    dock.toggleAttribute('data-neko-companion-chat-open', inLobby && lobbyChatOpen);
    companionChatPanel.hidden = inLobby && !lobbyChatOpen;
    companionChatClose.hidden=!inLobby;
    character.setAttribute('aria-expanded', String(inLobby && lobbyChatOpen));
    if (focus) (lobbyChatOpen ? chatInput : character).focus();
    schedule();
  }
  dock.append(character, companionChatPanel, companionReply);
  // Move the existing animated character, rather than creating another pet.
  // The chat and its draft stay mounted in the original dock throughout.
  function focusCompanionChat() {
    const expand = doc.querySelector('.neko-side-rail__expand');
    if (expand && !expand.hidden) expand.click();
    if (dock.hasAttribute('data-neko-companion-lobby')) setLobbyChatOpen(true);
    dock.scrollIntoView?.({ block: 'nearest' }); chatInput.focus();
  }
  const railCompanion = own(button('', 'neko-side-rail__button neko-rail-companion', () => {
    if (suppressRailClick) { suppressRailClick = false; return; }
    if(typeof bridge.home==='function'){void returnCompanionHome();return;}
    if (sideSocial) { Promise.resolve(bridge.action('open-companion-chat')).catch(showError); return; }
    toggleCompanionMenu(railCompanion);
  }));
  railCompanion.hidden = true; railCompanion.title = '点击聊天 · 拖动位置 · 方向键移动';
  railCompanion.setAttribute('aria-label', '大肥鱼，点击聊天，可拖动，方向键移动');
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
  async function returnCompanionHome(){try{closeCompanionMenu(false);closeSettings();lobby?.hide();hideSocial();if(isOfficeEdition()&&!await saveLayout({workbenchEdition:'daily'}))return;setRoomActive(true);await bridge.home({action:'return-home'});await roomPreview?.openHome?.();}catch(error){showError(error);}}
  const homeButton=button('回家','neko-companion-menu__home',()=>void returnCompanionHome());homeButton.setAttribute('role','menuitem');
  railCompanion.addEventListener('contextmenu',event=>{event.preventDefault();toggleCompanionMenu(railCompanion);});
  character.addEventListener('contextmenu',event=>{event.preventDefault();toggleCompanionMenu(character);});
  const companionChatButton = button('和我聊聊', 'neko-companion-menu__chat', () => { closeCompanionMenu(false); focusCompanionChat(); });
  for (const item of [visitButton, companionChatButton]) item.setAttribute('role', 'menuitem');
  const companionMenuStatus = el('p', 'neko-companion-menu__status'); companionMenuStatus.setAttribute('role', 'status');
  companionMenu.append(homeButton, visitButton, companionChatButton, companionMenuStatus); doc.body.appendChild(companionMenu);
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
    const items = [homeButton,visitButton, companionChatButton].filter(item => !item.disabled);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const index = items.indexOf(doc.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === 'Tab') closeCompanionMenu(false);
  });
  function dismissCompanionMenu(event) { if (!companionMenu.contains(event.target) && !character.contains(event.target) && !railCompanion.contains(event.target)) closeCompanionMenu(false); }
  doc.addEventListener('pointerdown', dismissCompanionMenu, true);
  function syncCompanionPlacement(rail) {
    if (!rail) return;
    if(isFishDateOpen()){
      dock.hidden=true;railCompanion.hidden=true;companionInRail=false;stopRailWalking();
      character.removeAttribute('aria-hidden');
      if(character.parentNode!==fishDateView.petSlot)fishDateView.petSlot.append(character);
      return;
    }
    if (dock.hidden !== sideSocial) dock.hidden = sideSocial;
    const railLabel = typeof bridge.home==='function'?'大肥鱼，点击回到我的小窝，右键互动，可拖动':sideSocial ? '大肥鱼，点击聊天，可拖动，方向键移动' : '大肥鱼互动菜单，可拖动，方向键移动';
    if (railCompanion.getAttribute('aria-label') !== railLabel) railCompanion.setAttribute('aria-label', railLabel);
    railCompanion.title = typeof bridge.home==='function'?'点击回家 · 右键互动 · 拖动位置':sideSocial ? '点击聊天 · 拖动位置 · 方向键移动' : '点击互动 · 拖动位置 · 方向键移动';
    if (sideSocial) railCompanion.removeAttribute('aria-haspopup');
    else if (railCompanion.getAttribute('aria-haspopup') !== 'menu') railCompanion.setAttribute('aria-haspopup', 'menu');
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
    // A portalled room dock owns the character independently of the hidden
    // native DSH sidebar and its stale intersection results. Explicit social
    // surfaces still hand the same character to the rail fallback.
    const roomOwnsCompanion = connected && roomActive && !sideSocial && dock.hasAttribute('data-neko-companion-expanded') && !doc.body.hasAttribute('data-neko-flex-social-hidden');
    const needsRail = !isOfficeEdition() && (sideSocial || !roomOwnsCompanion && !visible);
    const changed = needsRail !== companionInRail || character.parentNode !== (needsRail ? railCompanion : dock);
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
    if (!state?.companion?.ready) { if (state?.companion?.backend === 'deepseek-account' && state?.companion?.workbenchStatus !== 'ready') { renderCompanion(); return; } try { await bridge.action('chat-settings'); } catch (error) { chatError = error.message || '请从左上角设置连接聊天'; } renderCompanion(); return; }
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
  // Keep the legacy adapter detached; its local data remains owned by its
  // original engine, while the workbench presents DSH only.
  panel.append(officeHeader, officeHistory, officeError, officeApprovals, officeForm);
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
  const floatingRecords = own(button('项目记录', 'neko-floating-records-control', () => {
    floatingRecordsOpen = !floatingRecordsOpen;
    floatingRecords.setAttribute('aria-expanded', String(floatingRecordsOpen));
    if (floatingRecordsOpen) { startupOpen = true; renderStartup(); }
    schedule();
  }));
  floatingRecords.hidden = true; floatingRecords.setAttribute('aria-expanded', String(floatingRecordsOpen));
  floatingRecords.setAttribute('aria-controls', 'neko-floating-projects'); startup.id = 'neko-floating-projects'; doc.body.appendChild(floatingRecords);
  const collapseNotice = own(el('p', 'neko-workspace-collapse-notice')); collapseNotice.setAttribute('role', 'status'); collapseNotice.hidden = true; doc.body.appendChild(collapseNotice);
  let collapsedComposer = null, collapsedPopover = false, collapseGeometry = '', collapseNoticeTimer = null;
  let floatingComposer = null, floatingGeometry = '', floatingState = '', floatingRecoveryPending = false, floatingInitialized = false;
  let questionController=null,nativeQuestionOpen=false,nativeQuestionIdentity='';
  let floatingPosition = null;
  let nativeRecordsOpen = false, nativeRecordsWidth = 480, nativeRecordsHeight = 360, nativeOpening = false, nativeRecordsOffset = 0;
  let nativeModelOpen=false,nativeDefaultPreparing=false,nativeDefaultPrepared=false,nativeCompactError=false;
  // Project chooser and current-project details of the creation desk. The
  // details height is the user's drag result; null uses a compact 320px panel.
  let nativeProjectOpen=false,nativeDetailsOpen=false,nativeDetailsHeight=null,nativeProjectHint=null;
  let creationPositionKey='default',creationLobbySeen=false,creationResetPosition=false;
  const creationModeState={default:null,lobby:null};
  // Daily three-pane split: the room selector keeps a roughly constant share
  // of the content width, so maximizing grows both columns instead of only
  // the channel. The 64px rail is excluded and the channel keeps >=240px.
  const roomSelectorWidth = width => Math.round(Math.min(Math.max(144, width - 240), Math.max(220, width * .27)));
  const creationLobbyInsets={left:12,widthLoss:24,bottom:12};
  function creationRoomGeometry(){const rail=doc.querySelector('[data-neko-side-rail]')?.getBoundingClientRect(),left=Math.max(0,rail?.width>0?rail.right:64),width=Math.max(0,win.innerWidth-left);return {left,width,selectorWidth:roomSelectorWidth(width)};}
  function splitLobbyActive(){return isDailyEdition()&&roomActive&&!sideSocial&&(!!lobby?.isOpen()||isFishDateOpen())&&!doc.body.hasAttribute('data-neko-flex-social-hidden');}
  function syncCreationMode(){
    const next=splitLobbyActive()?'lobby':'default';if(next===creationPositionKey)return;
    creationModeState[creationPositionKey]={position:floatingPosition,recordsOpen:nativeRecordsOpen,recordsWidth:nativeRecordsWidth,recordsHeight:nativeRecordsHeight};
    // The lobby desk uses the selector column's own width with a small fixed
    // margin, instead of inheriting the narrower main-chat form insets.
    creationPositionKey=next;const saved=creationModeState[next];floatingPosition=saved?.position||null;nativeRecordsOpen=saved?.recordsOpen??false;if(saved){nativeRecordsWidth=saved.recordsWidth;nativeRecordsHeight=saved.recordsHeight;}
    if(next==='lobby'&&!creationLobbySeen){creationLobbySeen=true;creationResetPosition=true;}
    floatingGeometry='';
  }
  function nativeRecordRows() { return (catalog?.sessions || []).filter(row => row && typeof row.id === 'string' && typeof row.title === 'string' && row.provider === 'dsh'); }
  const nativeRecordId = row => row.provider + ':' + row.id;
  function nativeTargetLabel(state) {
    const id = state?.sessionId;
    if (!state?.available || !id || nativeSelection()?.sessionId !== id || !hasActiveDshSession()) return '';
    if(state.defaultWorkspace===true)return '默认工作区';
    const row = nativeRecordRows().find(item => item.provider === 'dsh' && item.id === id);
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    const project = typeof row?.cwd === 'string' ? row.cwd.split(/[\\/]/).filter(Boolean).at(-1) : '';
    return title && project ? `${project} · ${title}` : '';
  }
  const projectBase = cwd => typeof cwd === 'string' ? cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd : '';
  // Real DSH projects from the trusted catalog only. Registered rows and
  // history-only roots are both selectable; the host re-verifies every id.
  function nativeProjects() { return (catalog?.projects || []).filter(p => p && p.provider === 'dsh' && typeof p.id === 'string' && p.id && p.id.length <= 2048 && typeof p.cwd === 'string' && p.cwd); }
  const sameRoot = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
  function currentNativeProject(snap) {
    const id = snap?.sessionId, projects = nativeProjects();
    if (!id || !projects.length) return null;
    let found = projects.find(p => Array.isArray(p.sessions) && p.sessions.some(s => s?.provider === 'dsh' && s.id === id));
    const workspace = !found && (catalog?.workspaces || []).find(w => w?.provider === 'dsh' && Array.isArray(w.sessionIds) && w.sessionIds.includes(id));
    if (workspace) found = projects.find(p => p.id === workspace.id || !!workspace.workspaceId && p.workspaceId === workspace.workspaceId);
    if (!found) { let registry; try { registry = floatingComposer?.workspaces?.(); } catch {} const row = registry?.phase === 'ready' && Array.isArray(registry.items) ? registry.items.find(item => Array.isArray(item?.sessionIds) && item.sessionIds.includes(id)) : null; if (row?.workspaceId) found = projects.find(p => p.workspaceId === row.workspaceId); }
    // A just-confirmed open is real until the catalog lists the new session.
    if (!found && nativeProjectHint?.sessionId === id) found = projects.find(p => p.id === nativeProjectHint.projectId);
    if (!found && snap.defaultWorkspace === true) found = projects.find(p => sameRoot(p.cwd, state?.workspaceRoot));
    return found || null;
  }
  function nativeProjectState(snap) {
    const current = currentNativeProject(snap), sessionId = snap?.sessionId;
    const projects = nativeProjects().slice(0, 200).map(p => ({ id:p.id, name:String(p.name || projectBase(p.cwd)).slice(0, 120), path:p.cwd.slice(0, 1024), sessions:Array.isArray(p.sessions) ? p.sessions.length : 0, current:p.id === current?.id, registered:p.needsRegistration !== true }));
    const sessions = current && Array.isArray(current.sessions) ? current.sessions.filter(s => s?.provider === 'dsh' && typeof s.id === 'string' && typeof s.title === 'string').slice(0, 100) : [];
    const currentProject = current ? { id:current.id, name:String(current.name || projectBase(current.cwd)).slice(0, 120), path:current.cwd.slice(0, 1024), registered:current.needsRegistration !== true, sessions:sessions.map(s => ({ id:nativeRecordId(s), title:s.title.slice(0, 160), updatedAt:Number.isFinite(s.updatedAt) ? s.updatedAt : 0, active:s.status === 'active', current:s.id === sessionId })) } : null;
    return { projects, currentProject, projectsStatus:listLoading && !projects.length ? '正在读取项目…' : catalogError || (!projects.length ? '暂无已登记或有记录的项目' : '') };
  }

  const hasNativeComposerBridge = typeof bridge.nativeComposer === 'function' && typeof bridge.subscribeNativeComposer === 'function';
  function recoverFloatingComposer() {
    if (disposed || floatingRecoveryPending || !(doc.body.hasAttribute('data-neko-flex-workspace-collapsed') || doc.body.hasAttribute('data-neko-workspace-collapsed'))) return;
    floatingRecoveryPending = true;
    collapseNotice.textContent = isDailyEdition() ? '悬浮聊天暂不可用，请切换办公版继续；草稿仍保留在原会话中' : '浮动输入暂不可用，已展开工作区'; collapseNotice.hidden = false;
    if (collapseNoticeTimer) win.clearTimeout(collapseNoticeTimer);
    collapseNoticeTimer = win.setTimeout(() => { collapseNotice.hidden = true; }, 3500);
    if (!isDailyEdition()) doc.dispatchEvent(new win.Event('neko-workspace-expand'));
  }
  function floatingCall(request) {
    if (!hasNativeComposerBridge) return;
    try { Promise.resolve(bridge.nativeComposer(request)).then(result => { if (request.action === 'place' && result?.ok === false) recoverFloatingComposer(); }).catch(() => { if (request.action === 'place') recoverFloatingComposer(); }); }
    catch { if (request.action === 'place') recoverFloatingComposer(); }
  }
  function updateFloatingComposer(state, extra = {}) {
    if (!floatingInitialized || !hasNativeComposerBridge) return;
    const available = layout?.officeMode === 'dsh' && state?.available === true;
    const allRecords = nativeRecordRows();
    const records = allRecords.slice(nativeRecordsOffset,nativeRecordsOffset + 100).map(row => ({ id:nativeRecordId(row), title:row.title, project:row.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '未指定项目', enabled:row.provider === 'dsh' }));
    const targetLabel = nativeTargetLabel(state), targetRequired = !!lobby?.isOpen();
    const next = { records, recordsOpen:nativeRecordsOpen, recordsHasMore:nativeRecordsOffset + 100 < allRecords.length || catalog?.nextDshOffset != null, recordsLoading:listLoading, recordsStatus:listLoading ? '正在读取会话…' : catalogError || (!allRecords.length ? '暂无会话' : nativeRecordsOffset ? '显示较早记录；刷新可返回最新记录' : ''), targetLabel, targetRequired, value:typeof state?.draft === 'string' ? state.draft.slice(0, 30000) : '', enabled:available, busy:state?.phase != null && state.phase !== 'plain', sessionToken:typeof state?.sessionId === 'string' ? state.sessionId : '', revision:Number.isSafeInteger(state?.revision) && state.revision >= 0 ? state.revision : 0, placeholder:available ? '发消息或创建任务…' : '请先打开可用的工作会话', status:state?.reason || state?.status || '', ...extra };
    for(const key of ['modelOptions','modelId','modelLabel','reasoningId','reasoningLabel','modelBusy','modelError','defaultErrorCode','workContent'])if(state?.[key]!==undefined)next[key]=state[key];
    Object.assign(next,nativeProjectState(state),{projectOpen:nativeProjectOpen,detailsOpen:nativeDetailsOpen});
    next.question=questionController?.current(state?.sessionId)||null;
    Object.assign(next,extra);
    next.modelOpen=nativeModelOpen;
    next.chatOnly = isDailyEdition();
    if (isDailyEdition() && !available) { next.placeholder = '创造台'; next.status = state?.reason || ''; }
    const compactError=!!next.modelError||!!next.status&&!/^(?:正在|已交给|准备|连接)/.test(next.status);
    if(compactError!==nativeCompactError){nativeCompactError=compactError;floatingGeometry='';schedule();}
    const key = JSON.stringify(next); if (key === floatingState && !Object.keys(extra).length) return;
    floatingState = key; floatingCall({action:'update',state:next});
  }
  if (typeof createNativeComposerAdapter === 'function' && options.nativeComposerBindings) {
    floatingComposer = createNativeComposerAdapter({ ...options.nativeComposerBindings, getDefaultWorkspaceRoot:()=>state?.workspaceRoot, onReady:schedule, onChange: state => updateFloatingComposer(state) });
  }
  if(typeof createWorkbenchQuestionController==='function'&&options.nativeComposerBindings?.getQuestionStatusSource){
    questionController=createWorkbenchQuestionController({getSource:options.nativeComposerBindings.getQuestionStatusSource,
      openSession:async id=>{if(typeof options.openDshSession!=='function')throw Error('工作区暂不可用');await options.openDshSession(id);if(!isOfficeEdition()&&!await saveLayout({workbenchEdition:'office'}))throw Error('版本切换未完成');},
      onChange:items=>{
        if(disposed)return;const q=items.find(q=>q.sessionId===floatingComposer?.snapshot()?.sessionId),identity=q?JSON.stringify([q.sessionId,q.key,q.revision]):'';
        if(identity!==nativeQuestionIdentity){nativeQuestionIdentity=identity;nativeQuestionOpen=!!q;floatingGeometry='';}
        if(typeof bridge.questions==='function')void Promise.resolve(bridge.questions({action:'publish',items})).catch(()=>{});
        updateFloatingComposer(floatingComposer?.snapshot());schedule();
      }});
    if(typeof bridge.subscribeQuestionEvents==='function')releases.push(bridge.subscribeQuestionEvents(async event=>{
      if(!event||!Number.isSafeInteger(event.requestId)||disposed)return;
      const result=await questionController.perform(event);
      if(!disposed)void Promise.resolve(bridge.questions({action:'result',requestId:event.requestId,ok:result.ok===true})).catch(()=>{});
    }));
    questionController.refresh();
  }
  function prepareNativeDefault({retry=false}={}){
    if(nativeDefaultPreparing||nativeDefaultPrepared&&!retry||typeof floatingComposer?.ensureDefaultSession!=='function'||typeof options.nativeComposerBindings?.ensureDefaultSession!=='function')return;
    nativeDefaultPreparing=true;
    let waitingForReady=false;
    Promise.resolve(floatingComposer.ensureDefaultSession({retry})).then(result=>{waitingForReady=result?.code==='not_ready';if(!waitingForReady)nativeDefaultPrepared=true;if(result?.ok&&!['retained','already_attempted'].includes(result.code))void refreshCatalog(true);}).catch(()=>{nativeDefaultPrepared=true;}).finally(()=>{nativeDefaultPreparing=false;updateFloatingComposer(floatingComposer?.snapshot());if(!waitingForReady)schedule();});
  }
  if (hasNativeComposerBridge) {
    try {
      const off = bridge.subscribeNativeComposer(event => {
        if (!floatingInitialized || !event || typeof event.type !== 'string') return;
        if(event.type==='question-visibility'){const q=questionController?.current(floatingComposer?.snapshot()?.sessionId);if(q&&(event.sessionId!==q.sessionId||event.key!==q.key||event.revision!==q.revision))return;nativeQuestionOpen=event.open===true&&!!q;floatingGeometry='';schedule();return;}
        if(event.type==='question-action'){
          if(event.sessionId!==floatingComposer?.snapshot()?.sessionId)return;
          void Promise.resolve(questionController?.perform({...event,type:event.questionAction})).then(()=>updateFloatingComposer(floatingComposer?.snapshot(),{settledQuestionSelectionId:event.questionSelectionId,settledQuestionKey:event.key,settledQuestionRevision:event.revision}));return;
        }
        if (event.type === 'move') {
          const current=floatingBounds();if(!current)return;
          if(event.reset===true)floatingPosition=null;
          else if([event.dx,event.dy].every(n=>Number.isFinite(n)&&Math.abs(n)<=4000))floatingPosition={x:current.x+event.dx,y:current.y+event.dy,height:current.height};
          floatingGeometry='';schedule();return;
        }
        if (isDailyEdition() && ['expand','files'].includes(event.type)) return;
        if (event.type === 'expand') { if (doc.body.hasAttribute('data-neko-flex-workspace-collapsed') || doc.body.hasAttribute('data-neko-workspace-collapsed')) doc.dispatchEvent(new win.Event('neko-workspace-expand')); return; }
        if (event.type === 'files') {
          const sessionId = event.sessionToken;
          const current = floatingComposer?.snapshot();
          if (!(doc.body.hasAttribute('data-neko-flex-workspace-collapsed') || doc.body.hasAttribute('data-neko-workspace-collapsed')) || !current?.available || current.sessionId !== sessionId || current.revision !== event.revision || nativeSelection()?.sessionId !== sessionId || !hasActiveDshSession()) { updateFloatingComposer(current, {status:'会话已变化，请展开工作区重试'}); return; }
          doc.dispatchEvent(new win.Event('neko-workspace-expand'));
          const frame = win.requestAnimationFrame || (fn => win.setTimeout(fn, 16));
          frame(() => frame(() => {
            if (disposed || (doc.body.hasAttribute('data-neko-flex-workspace-collapsed') || doc.body.hasAttribute('data-neko-workspace-collapsed')) || nativeSelection()?.sessionId !== sessionId || !hasActiveDshSession()) return;
            try { if (typeof options.openDshFiles !== 'function') throw Error('missing file service'); options.openDshFiles(directoryButton, sessionId); }
            catch { collapseNotice.textContent = '项目目录暂不可用，请在工作区重试'; collapseNotice.hidden = false; if (collapseNoticeTimer) win.clearTimeout(collapseNoticeTimer); collapseNoticeTimer = win.setTimeout(() => { collapseNotice.hidden = true; }, 3500); }
          }));
          return;
        }
        if(event.type==='model-toggle'){nativeModelOpen=event.open===true;if(nativeModelOpen){nativeRecordsOpen=nativeProjectOpen=nativeDetailsOpen=false;void floatingComposer?.loadModels?.();}floatingGeometry='';updateFloatingComposer(floatingComposer?.snapshot());schedule();return;}
        if(event.type==='model-refresh'){prepareNativeDefault({retry:true});Promise.resolve(floatingComposer?.loadModels?.({refresh:true})).then(()=>{const state=floatingComposer?.snapshot();updateFloatingComposer(state,Number.isSafeInteger(event.selectionId)&&!state?.modelBusy?{settledModelSelectionId:event.selectionId}:{});});return;}
        if(event.type==='model-select'){
          const request={sessionId:event.sessionToken,revision:event.revision,modelId:event.modelId,reasoningId:event.reasoningId};
          Promise.resolve(floatingComposer?.selectModel?.(request)).then(()=>updateFloatingComposer(floatingComposer?.snapshot(),{settledModelSelectionId:event.selectionId})).catch(()=>updateFloatingComposer(floatingComposer?.snapshot(),{settledModelSelectionId:event.selectionId,modelError:'模型切换失败，请刷新后重试'}));return;
        }
        if (event.type === 'records-toggle') { nativeRecordsOpen = event.open === true;if(nativeRecordsOpen)nativeModelOpen=nativeProjectOpen=nativeDetailsOpen=false; floatingGeometry = ''; updateFloatingComposer(floatingComposer?.snapshot()); schedule(); return; }
        if (event.type === 'project-toggle' || event.type === 'details-toggle') {
          const open = event.open === true;
          if (event.type === 'project-toggle') nativeProjectOpen = open; else nativeDetailsOpen = open;
          if (open) { nativeModelOpen = nativeRecordsOpen = false; if (event.type === 'project-toggle') nativeDetailsOpen = false; else nativeProjectOpen = false; void refreshCatalog(true, 0, { quiet:true }); }
          floatingGeometry = ''; updateFloatingComposer(floatingComposer?.snapshot()); schedule(); return;
        }
        if (event.type === 'project-refresh') { void refreshCatalog(true, 0, { quiet:true }); return; }
        if (event.type === 'details-resize') {
          const current = floatingBounds(), limit = detailsHeightLimit();
          if (!current || !Number.isFinite(event.delta)) return;
          if (!nativeDetailsOpen) { if (event.delta <= 0) return; nativeDetailsOpen = true; nativeModelOpen = nativeRecordsOpen = nativeProjectOpen = false; nativeDetailsHeight = current.height; }
          nativeDetailsHeight = Math.round(Math.max(160, Math.min(limit, (nativeDetailsHeight ?? current.height) + event.delta)));
          floatingGeometry = ''; updateFloatingComposer(floatingComposer?.snapshot()); schedule(); return;
        }
        if (event.type === 'project-select') {
          const reply = (status, extra = {}) => updateFloatingComposer(floatingComposer?.snapshot(), { settledProjectSelectId:event.selectId, status, ...extra });
          const before = floatingComposer?.snapshot(), project = nativeProjects().find(p => p.id === event.projectId);
          if (!Number.isSafeInteger(event.selectId) || event.selectId <= 0) return;
          if (nativeOpening || !project || typeof floatingComposer?.openWorkspace !== 'function' || layout?.officeMode !== 'dsh') { reply(!project ? '项目已变化，请刷新后重新选择' : nativeOpening ? '正在切换，请稍候' : '项目选择暂不可用'); return; }
          if (before?.sessionId && currentNativeProject(before)?.id === project.id) { nativeProjectOpen = false; floatingGeometry = ''; reply(''); schedule(); return; }
          nativeOpening = true;
          // The host resolves the catalog id to a verified registry workspace;
          // the bindings then refuse a changed draft, attachment or revision.
          Promise.resolve(call({ action:'resolve-project', projectId:project.id })).then(async resolved => {
            if (resolved?.projectId !== project.id || typeof resolved.workspaceId !== 'string' || !resolved.workspaceId) throw Error('DSH 未能确认所选项目，原会话已保留');
            await floatingComposer.openWorkspace({ sessionToken:event.sessionToken, revision:event.revision, workspaceId:resolved.workspaceId });
            nativeProjectHint = { projectId:project.id, sessionId:floatingComposer.snapshot()?.sessionId || null };
            const patch = sessionPatch({ provider:'dsh', cwd:project.cwd });
            if (patch.activeSeatId !== layout?.activeSeatId) await saveLayout(patch);
            nativeProjectOpen = false; reply('');
          }).catch(error => reply(error?.message || '项目未能切换，原会话和草稿已保留')).finally(() => { nativeOpening = false; floatingGeometry = ''; void refreshCatalog(true, 0, { quiet:true }); schedule(); });
          return;
        }
        if (event.type === 'records-refresh') { void refreshCatalog(true, 0, { resetRecordsOnSuccess: true }); return; }
        if (event.type === 'records-more') {
          if (listLoading) return;
          if (nativeRecordsOffset + 100 < nativeRecordRows().length) { nativeRecordsOffset += 100; updateFloatingComposer(floatingComposer?.snapshot()); }
          else if (catalog?.nextDshOffset != null) { const nextOffset = catalog.nextDshOffset, advance = Math.min(nativeRecordsOffset + 100, nativeRecordRows().length); void refreshCatalog(true,nextOffset).then(() => { if (advance < nativeRecordRows().length) nativeRecordsOffset = advance; updateFloatingComposer(floatingComposer?.snapshot()); }); }
          return;
        }
        if (event.type === 'records-resize') { nativeRecordsWidth = Math.max(280,Math.min(1100,nativeRecordsWidth + (event.dx || 0))); nativeRecordsHeight = Math.max(160,Math.min(950,nativeRecordsHeight + event.delta)); floatingGeometry = ''; schedule(); return; }
        if (event.type === 'record-open') {
          const current = floatingComposer?.snapshot(), row = nativeRecordRows().find(item => nativeRecordId(item) === event.id && item.provider === 'dsh');
          // A revision changed after the child request or an existing draft is
          // present: refuse the switch until the user has handled that draft.
          const selection = nativeSelection();
          const unbound = !!selection && !current?.sessionId && !selection.sessionId && event.sessionToken === '' && event.revision === 0;
          const sameCleanSession = current?.available && current.sessionId === event.sessionToken && current.revision === event.revision && !current.draft && current.phase === 'plain';
          if (nativeOpening || !row || !(unbound || sameCleanSession) || typeof options.openDshSession !== 'function') { const status = !selection ? '会话状态暂不可读取，请展开工作区重试' : current?.draft ? '请先处理当前草稿，再切换工作会话' : '会话状态已变化或暂不可用，请检查后重试'; updateFloatingComposer(current, {settledRecordOpenId:event.openId,status}); return; }
          nativeOpening = true;
          Promise.resolve(openSession(row, { preserveSocial:true })).then(opened => { updateFloatingComposer(floatingComposer?.snapshot(), {settledRecordOpenId:event.openId}); if (!opened) return; nativeRecordsOpen = false; closeStartup(); if (!isDailyEdition() && !doc.body.hasAttribute('data-neko-fixed-scene')) doc.dispatchEvent(new win.Event('neko-workspace-expand')); }).catch(() => updateFloatingComposer(floatingComposer?.snapshot(), {settledRecordOpenId:event.openId,status:'会话未能打开，请重试'})).finally(() => { nativeOpening = false; schedule(); });
          return;
        }
        if (event.type === 'unavailable') { recoverFloatingComposer(); return; }
        if (!['edit','submit'].includes(event.type)) return;
        if (!(doc.body.hasAttribute('data-neko-flex-workspace-collapsed') || doc.body.hasAttribute('data-neko-workspace-collapsed'))) {
          updateFloatingComposer(floatingComposer?.snapshot(), event.type === 'edit' ? {settledEditId:event.editId,editConflict:true,status:'工作区已展开，请核对草稿'} : {settledSubmitId:event.submissionId,status:'工作区已展开，请核对会话后重试'});
          return;
        }
        const request = {sessionId:event.sessionToken, revision:event.revision, text:event.value};
        let result;
        if (!floatingComposer || layout?.officeMode !== 'dsh') result = {ok:false,code:'unavailable',state:floatingComposer?.snapshot()};
        else if (event.type === 'edit') result = floatingComposer.write(request);
        else if (lobby?.isOpen() && !nativeTargetLabel(floatingComposer.snapshot())) result = {ok:false,code:'target_unconfirmed',state:floatingComposer.snapshot()};
        else {
          const state = floatingComposer.snapshot();
          result = state.draft !== event.value ? {ok:false,code:'draft_changed',state} : floatingComposer.submit(request);
        }
        const state = result.state || floatingComposer?.snapshot();
        if (event.type === 'edit') updateFloatingComposer(state, {settledEditId:event.editId, editConflict:!result.ok, status:result.ok ? '' : '原工作区草稿已变化，请展开工作区处理'});
        else updateFloatingComposer(state, {settledSubmitId:event.submissionId, submitUnknown:result.code === 'submit_unknown', status:result.ok ? (state?.status || '已交给工作区处理') : result.code === 'submit_unknown' ? '发送结果未确认，可能已发送；请展开工作区核对，勿重复发送' : result.code === 'target_unconfirmed' ? '创造台会话未确认，请展开工作区核对' : result.code==='model_unconfirmed'?'模型尚未确认，请刷新并确认模型后再发送':result.code === 'already_submitted' ? '这条消息已交给工作区，请展开查看或重试' : '会话或草稿已变化，请检查后重试'});
      });
      if (typeof off === 'function') releases.push(off);
    } catch { /* Missing bridge is handled as unavailable. */ }
  }
  function floatingBounds() {
    syncCreationMode();
    const flex = doc.body.hasAttribute('data-neko-flex-workspace-collapsed');
    if (!flex && !doc.body.hasAttribute('data-neko-workspace-collapsed')) return null;
    const style = doc.body.style;
    const right = flex ? parseFloat(style.getPropertyValue('--neko-flex-compact-right')) || 0 : 16;
    const bottom = flex ? parseFloat(style.getPropertyValue('--neko-flex-compact-bottom')) || 0 : 16;
    // Keep a usable strip for main-agent chat alongside the floating work area.
    const limitWidth = Math.max(0, Math.min(win.innerWidth-right-(isDailyEdition() ? 80 : 240), flex ? parseFloat(style.getPropertyValue('--neko-flex-compact-width')) || 0 : win.innerWidth));
    const room=creationPositionKey==='lobby'?creationRoomGeometry():null;
    const width = room?Math.max(100,room.selectorWidth-creationLobbyInsets.widthLoss):Math.min(nativeRecordsOpen ? nativeRecordsWidth : 480, limitWidth);
    // The selector-column desk is a little taller so two lines stay visible.
    const compactHeight = (room?84:64)+(nativeCompactError?24:0);
    const minX=Math.max(8,Math.round(doc.querySelector('[data-neko-side-rail]')?.getBoundingClientRect().right||64)+8);
    const minY=floatingTop();
    const panelOpen=nativeQuestionOpen||nativeRecordsOpen||nativeModelOpen||nativeProjectOpen||nativeDetailsOpen;
    const panelHeight=nativeQuestionOpen?360:nativeDetailsOpen?(nativeDetailsHeight??Math.min(320,detailsHeightLimit())):nativeProjectOpen?360:nativeModelOpen?320:nativeRecordsHeight;
    const height = panelOpen ? Math.max(compactHeight,Math.min(panelHeight,nativeDetailsOpen?detailsHeightLimit():Math.max(compactHeight,win.innerHeight-bottom-32))) : compactHeight;
    // A dragged desk keeps its bottom edge when a panel opens or closes, so
    // collapsing the details returns the input to where the person left it.
    const desired=floatingPosition?{x:floatingPosition.x,y:floatingPosition.y+(Number.isFinite(floatingPosition.height)?floatingPosition.height-height:0)}:(room?{x:room.left+creationLobbyInsets.left,y:win.innerHeight-creationLobbyInsets.bottom-height}:{x:win.innerWidth-right-width,y:win.innerHeight-bottom-height});
    return width >= 100 ? {x:Math.round(Math.max(minX,Math.min(win.innerWidth-width-8,desired.x))),y:Math.round(Math.max(minY,Math.min(win.innerHeight-height-8,desired.y))),width:Math.round(width),height:Math.round(height)} : null;
  }
  function floatingTop(){const title=doc.querySelector('.neko-window-titlebar')?.getBoundingClientRect();return title?.height>0?Math.round(title.bottom)+8:8;}
  function detailsHeightLimit(){return Math.max(160,Math.min(1000,win.innerHeight-floatingTop()-8));}
  function syncFloatingComposer() {
    questionController?.refresh();
    const state=floatingComposer?.snapshot(),q=questionController?.current(state?.sessionId),identity=q?JSON.stringify([q.sessionId,q.key,q.revision]):'';
    if(identity!==nativeQuestionIdentity){nativeQuestionIdentity=identity;nativeQuestionOpen=!!q;floatingGeometry='';}
    const flex = doc.body.hasAttribute('data-neko-flex-workspace-collapsed');
    const collapsed = doc.body.hasAttribute('data-neko-workspace-collapsed');
    // The creation desk belongs to the daily edition. Office keeps its native
    // DSH input; the hidden desk retains its per-mode position and its draft
    // stays in the DSH session, so returning to daily places it back as it was.
    if (isOfficeEdition() || !flex && !collapsed) { floatingComposer?.watchWorkContent?.(false); if (floatingGeometry) floatingCall({action:'remove'}); floatingGeometry = ''; floatingState = ''; floatingRecoveryPending = false; return; }
    if (!hasNativeComposerBridge) { if (flex) recoverFloatingComposer(); return; }
    const rect = floatingBounds();
    if (!rect) {
      floatingComposer?.watchWorkContent?.(false);
      if (floatingGeometry) floatingCall({action:'remove'});
      floatingGeometry = ''; floatingState = '';
      recoverFloatingComposer(); return;
    }
    if(layout?.officeMode==='dsh')prepareNativeDefault();
    const key = JSON.stringify([creationPositionKey,rect]); if (key !== floatingGeometry) { floatingInitialized = true; floatingGeometry = key; floatingCall({action:'place',rect,positionKey:creationPositionKey,...(creationResetPosition?{resetPosition:true}:{})});creationResetPosition=false; }
    // Real session content is read only while the details are on screen.
    floatingComposer?.watchWorkContent?.(nativeDetailsOpen&&!nativeQuestionOpen);
    updateFloatingComposer(state);
  }
  const collapseResize = win.ResizeObserver ? new win.ResizeObserver(() => schedule()) : null;
  function notifyCollapseGeometry() {
    const rect = node => { const r = node.getBoundingClientRect(); return [r.left,r.top,r.width,r.height].map(Math.round); };
    const floating = hasNativeComposerBridge ? floatingBounds() : null;
    const key = JSON.stringify([collapsedComposer && rect(collapsedComposer), !expandWorkspace.hidden && rect(expandWorkspace), floating]);
    if (key !== collapseGeometry) { collapseGeometry = key; doc.dispatchEvent(new win.CustomEvent('neko-collapsed-composer-geometry', {detail:{floating}})); }
  }
  const requestCollapseGeometry = () => { collapseGeometry = ''; notifyCollapseGeometry(); };
  doc.addEventListener('neko-request-composer-geometry', requestCollapseGeometry);
  function clearCollapsedComposer() {
    if (collapsedComposer) {
      collapseResize?.unobserve(collapsedComposer);
      if (collapsedPopover) { try { collapsedComposer.hidePopover(); } catch {} collapsedComposer.removeAttribute('popover'); }
      collapsedComposer.removeAttribute('data-neko-collapsed-composer'); collapsedComposer = null; collapsedPopover = false;
    }
    expandWorkspace.hidden = true; floatingRecords.hidden = true; notifyCollapseGeometry();
  }
  function syncCollapsedComposer() {
    const flexCollapsed = doc.body.hasAttribute('data-neko-flex-workspace-collapsed');
    syncFloatingComposer();
    if (!isOfficeEdition() && (flexCollapsed || (doc.body.hasAttribute('data-neko-workspace-collapsed') && hasNativeComposerBridge))) { clearCollapsedComposer(); return; }
    if (!doc.body.hasAttribute('data-neko-workspace-collapsed') && !flexCollapsed) { clearCollapsedComposer(); return; }
    if (!layout) return;
    const center = doc.querySelector(flexCollapsed ? '[data-neko-flex-coding]' : '[data-neko-chat-center]');
    const next = layout.officeMode === 'codex' ? (codexPaused() ? null : officeForm) : center?.querySelector('[data-composer-seat]');
    const editor = next?.querySelector('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    if (!next || !editor || next.closest('[inert]')) {
      clearCollapsedComposer();
      if (isDailyEdition()) { recoverFloatingComposer(); return; }
      collapseNotice.textContent = '暂时无法显示工作输入框，已展开工作区'; collapseNotice.hidden = false;
      if (collapseNoticeTimer) win.clearTimeout(collapseNoticeTimer);
      collapseNoticeTimer = win.setTimeout(() => { collapseNotice.hidden = true; }, 3500);
      doc.dispatchEvent(new win.Event('neko-workspace-expand')); return;
    }
    if (next !== collapsedComposer) {
      clearCollapsedComposer(); collapsedComposer = next; next.setAttribute('data-neko-collapsed-composer', '');
      // The native coding column can establish a clipped containing block. A
      // manual popover promotes the existing input to the browser top layer
      // without moving it out of React or replacing its draft and handlers.
      if (!next.hasAttribute('popover') && typeof next.showPopover === 'function') {
        try { next.setAttribute('popover', 'manual'); next.showPopover(); collapsedPopover = true; }
        catch { next.removeAttribute('popover'); }
      }
      collapseResize?.observe(next);
    }
    expandWorkspace.hidden = isDailyEdition(); floatingRecords.hidden = false;
    floatingRecords.setAttribute('aria-expanded', String(floatingRecordsOpen));
    const r = next.getBoundingClientRect();
    const top = Math.max(12, Math.round(r.top - 42));
    if (expandWorkspace.style.top !== `${top}px`) expandWorkspace.style.top = `${top}px`;
    if (floatingRecords.style.top !== `${top}px`) floatingRecords.style.top = `${top}px`;
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
    layout = visibleLayout(layout);
    const edition = isOfficeEdition() ? 'office' : 'daily';
    const editionAvatar = avatar(isOfficeEdition() ? 'devcat' : 'bigfish'); if (officeImage.getAttribute('src') !== editionAvatar) officeImage.src = editionAvatar;
    officeButton.title = isOfficeEdition() ? '开发喵 · 点击切换日常版' : '大肥鱼 · 点击切换办公版';
    officeButton.setAttribute('aria-label', '当前' + (isOfficeEdition() ? '办公版' : '日常版') + '，切换工作台版本');
    doc.body.toggleAttribute('data-neko-daily-compact', isDailyEdition());
    if (isOfficeEdition()) doc.body.removeAttribute('data-neko-workspace-collapsed');
    if (workButton) { workButton.hidden = isDailyEdition(); workButton.disabled = isDailyEdition(); }
    doc.body.setAttribute('data-neko-workbench-edition', edition);
    if (edition !== appliedEdition) {
      const firstEdition = appliedEdition === null;
      appliedEdition = edition;
      if (isOfficeEdition()) {
        dailyRoom = {active:roomActive, selection:roomSelection};
        closeSettings(); lobby?.hide(); hideSocial(); sideSocial = false;
        setRoomActive(false, {closeSocial:false}); releaseRoomInert();
      } else if (dailyRoom) {
        roomSelection = isDailyEdition() || dailyRoom.selection; setRoomActive(isDailyEdition() || dailyRoom.active, {closeSocial:false}); dailyRoom = null;
      }
      if (isDailyEdition() && firstEdition) nativeRecordsOpen = false;
      doc.dispatchEvent(new win.CustomEvent('neko-workbench-edition-change', {detail:{edition}}));
      win.dispatchEvent(new win.Event('resize'));
    }
    doc.body.setAttribute('data-neko-office-mode', layout.officeMode);
    const active = layout.activeSeatId;
    seats.replaceChildren(...visibleSeats().map(seat => {
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
    const seat = visibleSeats().find(s => s.id === layout.activeSeatId);
    allButton.textContent = seat ? seat.name + ' 的工作项目' : '全部工作会话'; allButton.setAttribute('aria-pressed', String(!seat));
    const rows = (catalog?.sessions || []).filter(s => s.provider !== 'codex' && (!seat || s.provider === seat.provider && (!seat.projectRoot || s.cwd === seat.projectRoot)) && (!searchText || (s.title + ' ' + s.cwd + ' ' + s.provider).toLowerCase().includes(searchText)));
    const groups = new Map();
    for (const item of rows) { const key = item.provider + ':' + item.cwd; if (!groups.has(key)) groups.set(key, { provider: item.provider, cwd: item.cwd, sessions: [] }); groups.get(key).sessions.push(item); }
    const activeDshSession = layout.officeMode === 'dsh' ? nativeSelection()?.sessionId : null;
    // A background refresh with identical rows must not rebuild the list:
    // rebuilding resets scroll, focus and the visible open/closed groups.
    const listKey = JSON.stringify([[...groups].map(([key, group]) => [key, (searchText ? groupSearchCollapsed : groupOpen).has(key), group.sessions.map(row => [row.provider, row.id, row.title])]), activeDshSession, layout.officeMode, selectedId, sidebarOpening, codexPaused(), catalog?.providers?.codex, catalog?.nextDshOffset ?? null, searchText]);
    if (listKey !== projectListKey) {
    projectListKey = listKey;
    const scroller = projectList.parentElement, scroll = [projectList.scrollTop, scroller?.scrollTop || 0];
    projectList.replaceChildren(...[...groups].map(([key, group]) => {
      const section = el('section', 'neko-workspace-project'), heading = el('div', 'neko-workspace-project__heading');
      const name = group.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '未指定项目';
      const collapsed = searchText ? groupSearchCollapsed : groupOpen;
      const expanded = !collapsed.has(key);
      const folder = button((expanded ? '▾ ' : '▸ ') + name, 'neko-workspace-project__name', () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); renderCatalog(); });
      folder.setAttribute('aria-expanded', String(expanded));
      folder.title = group.cwd || '未指定项目';
      heading.append(folder, el('span', 'neko-workspace-project__provider', group.provider.toUpperCase())); section.appendChild(heading);
      if (expanded) for (const row of group.sessions) {
        const opening = sidebarOpening === row.provider + ':' + row.id;
        const link = button(opening ? row.title + ' · 正在打开…' : row.title, 'neko-workspace-session', async () => {
          if (sidebarOpening) return;
          sidebarOpening = row.provider + ':' + row.id; sidebarOpenError = ''; renderCatalog();
          try { await openSession(row); }
          catch (error) { sidebarOpenError = error?.message || '会话未能打开，请重试'; }
          finally { sidebarOpening = null; if (!disposed) renderCatalog(); }
        });
        const selected = row.provider === 'dsh' ? !!activeDshSession && row.id === activeDshSession : layout.officeMode === 'codex' && row.id === selectedId;
        link.title = row.title; link.dataset.selected = String(selected);
        if (selected) link.setAttribute('aria-current', 'page');
        if (sidebarOpening) link.disabled = true;
        if (row.provider === 'codex' && codexPaused()) { link.disabled = true; link.title = 'Codex 测试中，暂不可用'; link.textContent += ' · 测试中'; }
        section.appendChild(link);
      }
      return section;
    }));
    if (catalog?.nextDshOffset != null) projectList.appendChild(button('加载更多 DSH 会话', 'neko-workspace-more', () => refreshCatalog(true, catalog.nextDshOffset)));
    projectList.scrollTop = scroll[0]; if (scroller) scroller.scrollTop = scroll[1];
    }
    const unavailable = Object.entries(catalog?.providers || {}).filter(([name, status]) => name !== 'codex' && status !== 'ready' && status !== 'testing').map(([name]) => name.toUpperCase());
    refreshButton.setAttribute('aria-busy', String(listLoading)); projectList.setAttribute('aria-busy', String(listLoading || !!sidebarOpening));
    const notices = [];
    if (sidebarOpening) notices.push('正在打开会话…');
    else if (sidebarOpenError) notices.push(sidebarOpenError);
    else if (listLoading) notices.push('正在读取本地工作会话…');
    else if (catalogError) notices.push(catalogError);
    else if (!rows.length) notices.push(seat && !seat.provider ? '请配置这个工作 agent' : '暂无匹配的工作会话');
    if (searchText && catalog?.nextDshOffset != null) notices.push('仅搜索已加载的会话，可加载更多');
    if (unavailable.length) notices.push(unavailable.join('、') + ' 会话暂不可读取，可刷新重试');
    listStatus.textContent = notices.join(' · ');
    renderStartup();
  }
  async function refreshCatalog(force = false, dshOffset = 0, { resetRecordsOnSuccess = false, quiet = false } = {}) {
    if (disposed || listLoading) return;
    // The native catalog replaces its accumulated pages when refreshed from
    // offset zero. Do not invalidate a history page while it is being viewed.
    if (!dshOffset && nativeRecordsOffset > 0 && nativeRecordsOpen && !resetRecordsOnSuccess) return;
    const resetRecords = !dshOffset && nativeRecordsOffset > 0;
    // Background refreshes stay invisible: no loading text, no rebuilt list.
    listLoading = true; if (!quiet) { catalogError = ''; renderCatalog(); updateFloatingComposer(floatingComposer?.snapshot()); }
    try { const next = await call({ action: 'catalog', force, dshOffset }); if (!disposed) { catalog = next; catalogError = ''; if (resetRecords) nativeRecordsOffset = 0; } }
    catch (error) { catalogError = '工作会话读取失败，请刷新重试'; if (!quiet) showError(error); }
    finally { listLoading = false; if (!disposed) { renderCatalog(); updateFloatingComposer(floatingComposer?.snapshot()); } }
  }
  function sessionPatch(row) {
    // Keep the selected sidebar agent compatible with the chosen session.
    // Prefer the current compatible seat, then a project-specific or general
    // seat. If none is bound, show all sessions instead of a misleading filter.
    const seatsForProvider = (layout?.seats || []).filter(seat => seat.provider === row.provider && (!seat.projectRoot || seat.projectRoot === row.cwd));
    const selectedSeat = seatsForProvider.find(seat => seat.id === layout?.activeSeatId) || seatsForProvider.find(seat => seat.projectRoot === row.cwd) || seatsForProvider.find(seat => !seat.projectRoot);
    return { officeMode: row.provider, activeSeatId: selectedSeat?.id || null };
  }
  async function openProject(group, { preserveSocial = false } = {}) {
    if (!group.cwd) throw Error('该项目没有可用目录');
    if (group.provider === 'codex' && codexPaused()) throw Error('Codex 测试中，暂不可用');
    if (!preserveSocial) leaveViews(); closeSettings();
    if (!await saveLayout(sessionPatch(group))) throw Error('无法切换工作界面，请重试');
    if (group.provider === 'dsh') {
      if (typeof options.openDshNew !== 'function') throw Error('无法打开 DSH 工作项目，请重试');
      beginNativeNew(); try { await options.openDshNew(group.cwd); closeStartup(); } catch (error) { stopNativeNew(); throw error; }
    } else if (group.provider === 'codex') { selectedProject = group.cwd; newOffice(); }
    else throw Error('不支持的工作平台');
  }
  async function openSession(row, { preserveSocial = false } = {}) {
    if (row.provider === 'codex' && codexPaused()) { showError(Error('Codex 测试中，暂不可用')); return false; }
    if (!preserveSocial) leaveViews(); closeSettings();
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
    fishDateView?.update(state?.companion);
    const c = state?.companion || {}, open = !!layout?.companionHistoryOpen || historyPeek, wasHidden = history.hidden;
    updateCompanionReply(state?.companion);
    history.hidden = !open; historyToggle.setAttribute('aria-expanded', String(open)); historyToggle.setAttribute('aria-label', open ? '收起聊天记录' : '展开聊天记录'); historyToggle.title = open ? '收起聊天记录' : '展开聊天记录';
    chatSend.hidden = !!c.working; chatStop.hidden = !c.working; chatSend.disabled = sending; chatSend.title = c.ready ? '发送消息' : '连接聊天设置';
    const status = !state?.companion ? '正在检查聊天连接…' : sending ? '正在发送…' : c.working ? '大肥鱼正在回复…' : chatError || c.error || (!c.ready ? '聊天尚未连接，请先设置' : '');
    chatStatusText.textContent = status;
    chatSetup.textContent = c.backend === 'deepseek-account' && c.workbenchStatus === 'unavailable' ? '重连工作台' : '聊天设置';
    chatSetup.hidden = !state?.companion || !!c.ready || sending || !!c.working || (c.backend === 'deepseek-account' && c.workbenchStatus === 'starting');
    chatRecover.hidden = !c.failedText || sending || !!c.working;
    chatRecover.disabled = !!chatInput.value.trim();
    chatRecover.title = chatRecover.disabled ? '请先保留或清空当前草稿，再恢复失败的消息' : '将失败的消息放回输入框，不会自动发送';
    chatStatus.hidden = !status && chatSetup.hidden && chatRecover.hidden;
    const key = JSON.stringify(c.messages || []);
    if (key !== historyKey) {
      const bottom = history.scrollHeight - history.scrollTop - history.clientHeight < 30; historyKey = key;
      history.replaceChildren(...(c.messages || []).map(m => { const line = el('p', 'neko-companion-message'); line.dataset.role = m.role;const mediaText=(m.attachments||[]).map(a=>'['+(a.kind==='sticker'?'表情包':'图片')+'：'+a.name+']').join(' '); line.append(el('strong', '', m.role === 'user' ? '你：' : m.role === 'error' ? '提示：' : m.streaming ? '回复中：' : m.partial ? '未完成回复：' : '回复：'), doc.createTextNode([m.text,mediaText].filter(Boolean).join(' '))); return line; }));
      if (!history.children.length) history.appendChild(el('p', 'neko-companion-empty', '暂无聊天记录'));
      if (bottom) history.scrollTop = history.scrollHeight;
    }
    if (wasHidden && open) history.scrollTop = history.scrollHeight;
    lobby?.renderStatus();
  }
  function renderOffice() {
    if (!layout || !panel.isConnected) return;
    panel.hidden = isOfficeEdition() || layout.officeMode !== 'codex' || socialOpen;
    if (!panel.hidden && !codexPaused() && modelsState === 'idle') refreshModels();
    for (const main of doc.querySelectorAll('main')) { if (socialOpen) continue; if (main.closest('[data-neko-workspace-owned]')) continue; if (!panel.hidden && !main.contains(dock)) markNative(main, 'inert'); else if (nativeMarks.get(main)?.has('inert')) { const before = nativeMarks.get(main).get('inert'); if (before === null) main.removeAttribute('inert'); else main.setAttribute('inert', before); nativeMarks.get(main).delete('inert'); } }
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
  function closeSettings() { if (modal.hidden) return; modal.hidden = true;if(lobby?.isOpen()){lobby.panel.style.visibility='';lobby.panel.removeAttribute('inert');}schedule();const target = settingsReturnFocus; settingsReturnFocus = null; if (target?.isConnected && typeof target.focus === 'function') target.focus(); else (doc.querySelector('.neko-side-rail__account')||officeButton).focus(); }
  function accountSettings(event){if(disposed)return;const detail=event.detail||{};detail.handled=true;const target=detail.returnFocus;openSettings('general');if(target?.isConnected)settingsReturnFocus=target;}
  doc.addEventListener('neko-workbench-open-settings',accountSettings);releases.push(()=>doc.removeEventListener('neko-workbench-open-settings',accountSettings));
  function accountLobby(event){if(disposed||!lobby)return;const detail=event.detail||{};detail.handled=true;detail.promise=(async()=>{if(isOfficeEdition()&&!await saveLayout({workbenchEdition:'daily'}))throw Error('版本切换未完成');closeSettings();hideSocial();setRoomActive(true);lobby.show({connect:detail.connect!==false});})();}
  doc.addEventListener('neko-account-open-lobby',accountLobby);releases.push(()=>doc.removeEventListener('neko-account-open-lobby',accountLobby));
  function officeChoices() {
    const choices = el('div', 'neko-office-choices');
    for (const [id, name, pic] of [['dsh', 'DSH', 'bigfish']]) {
      const b = button('', 'neko-office-choice', async () => { leaveViews(); await saveLayout({ officeMode: id }); closeSettings(); });
      b.setAttribute('aria-pressed', String(layout?.officeMode === id)); b.append(image(avatar(pic)), el('span', '', name)); choices.appendChild(b);
    }
    return choices;
  }
  function connectionSummary() { const connected = phase => ['ready', 'connected'].includes(phase) ? '已连接' : phase === 'error' ? '连接出错' : '未连接'; return 'N.E.K.O.：' + connected(state?.neko?.connection) + ' · 工作台：' + connected(state?.workbench?.connection); }
  function openSettings(kind = 'general', id) {
    if (modal.hidden) settingsReturnFocus = doc.activeElement;
    hideSocial(); modalBody.replaceChildren(); modalTitle.textContent = kind === 'seat' ? '自定义工作 agent' : '工作台设置'; modal.setAttribute('aria-label', modalTitle.textContent); modal.hidden = false;
    if(lobby?.panel){lobby.panel.style.visibility='hidden';lobby.panel.setAttribute('inert','');}
    if (kind !== 'seat') {
      modalBody.append(el('h3', '', '右侧工作界面'), officeChoices());
      if (kind === 'general') {
        modalBody.append(el('h3', '', '头像与配色'));
        const palette = el('div', 'neko-workspace-palettes');
        for (const [id, name] of [['yui','Yui'],['devcat','开发喵'],['bigfish','大肥鱼'],['gemini','Gemini 小猫']]) { const b = button('', '', () => bridge.setAvatar(id).catch(showError)); b.setAttribute('aria-label', '配色：' + name); b.title = name; b.appendChild(image(avatar(id))); palette.appendChild(b); }
        modalBody.appendChild(palette);
        modalBody.append(el('h3', '', '常用设置'));
        const common = el('div', 'neko-workspace-common');
        common.append(button('主 agent 聊天设置', 'neko-workspace-setting-link', () => { closeSettings(); Promise.resolve(bridge.action('chat-settings')).catch(showError); }), button('账号、隐私 / 高级设置', 'neko-workspace-setting-link', () => { closeSettings(); options.openNativeSettings?.(); }));
        modalBody.appendChild(common);
        const more = el('details', 'neko-workspace-more-settings'); const summary = el('summary', '', '更多工具与连接'); more.appendChild(summary);
        const connections = el('p', 'neko-workspace-connections', connectionSummary());
        connections.setAttribute('role', 'status'); more.appendChild(connections);
        const actions = el('div', 'neko-workspace-actions'), actionError = el('p', 'neko-workspace-form-error'); actionError.setAttribute('role', 'status');
        for (const [action, label] of options.settingsActions || []) {
          if (action === 'neko-settings') continue; // The main-chat settings entry above opens the same native window.
          if (/codex|claude/i.test(action + ' ' + label)) continue;
          const item = button(label, 'neko-workspace-setting-link', async () => {
            const controls = [...actions.querySelectorAll('button')]; controls.forEach(b => b.disabled = true); item.setAttribute('aria-busy', 'true'); actionError.textContent = '';
            try { const result = await bridge.action(action); if (result?.ok === false) throw Error('操作未完成，请重试'); if (!['connect-neko', 'reconnect-workbench', 'connection-status'].includes(action)) closeSettings(); }
            catch (error) { actionError.textContent = error.message || '操作未完成，请重试'; }
            finally { controls.forEach(b => b.disabled = false); item.removeAttribute('aria-busy'); }
          }); item.dataset.workbenchAction = action; actions.appendChild(item);
        }
        more.append(actions, actionError, el('p', 'neko-workspace-note', 'DSH 沿用本机登录；主 agent 陪伴聊天单独连接。')); modalBody.appendChild(more);
      }
    } else {
      const seat = layout?.seats.find(s => s.id === id); if (!seat) return;
      const edit = el('form', 'neko-seat-editor');
      const nameLabel = el('label', '', '名称'), name = el('input'); name.value = seat.name; name.maxLength = 24; nameLabel.appendChild(name);
      const providerLabel = el('label', '', '执行平台'), provider = el('select');
      for (const [value, label] of [['', '暂不绑定'], ['dsh', 'DSH']]) { const option = el('option', '', label); option.value = value; provider.appendChild(option); } provider.value = seat.provider || ''; providerLabel.appendChild(provider);
      const projectLabel = el('label', '', '工作项目范围'), project = el('select'); const all = el('option', '', '全部项目'); all.value = ''; project.appendChild(all);
      for (const cwd of [...new Set((catalog?.projects || []).map(p => p.cwd).filter(Boolean))]) { const option = el('option', '', cwd); option.value = cwd; project.appendChild(option); } project.value = seat.projectRoot || ''; projectLabel.appendChild(project);
      const avatarLabel = el('label', '', '头像'), pick = el('select');
      const initialAvatar = seat.avatarId === 'claude' && !isOfficeEdition() ? 'bigfish' : seat.avatarId; let avatarChanged = false;
      for (const id of ['yui', 'devcat', 'bigfish', 'gemini', ...(isOfficeEdition() ? ['claude'] : []), ...(seat.customDataUrl ? ['custom'] : [])]) { const option = el('option', '', ({ yui: 'Yui', devcat: '开发喵', bigfish: '大肥鱼', gemini: 'Gemini小猫', claude: 'Claude娘', custom: '自定义头像' })[id]); option.value = id; pick.appendChild(option); } pick.value = initialAvatar; pick.addEventListener('change',()=>{avatarChanged=true;}); avatarLabel.appendChild(pick);
      const upload = button('上传头像…', 'neko-workspace-setting-link', async () => { try { layout = await call({ action: 'upload-seat', id: seat.id }); renderLayout(); openSettings('seat', seat.id); } catch (e) { error.textContent = e.message || '上传未完成'; } });
      const error = el('p', 'neko-workspace-form-error'); error.setAttribute('role', 'status');
      const save = el('button', 'neko-seat-save', '保存'); save.type = 'submit';
      edit.append(nameLabel, providerLabel, projectLabel, avatarLabel, upload, error, save);
      edit.addEventListener('submit', async e => { e.preventDefault(); try { layout = await call({ action: 'update-seat', id: seat.id, patch: { name: name.value, provider: provider.value || null, projectRoot: project.value || null, ...(avatarChanged?{avatarId:pick.value}:{}) } }); renderLayout(); closeSettings(); } catch (e) { error.textContent = e.message || '未能保存'; } });
      modalBody.appendChild(edit);
    }
    modalClose.focus();
  }
  function place() {
    if (disposed) return;
    if (isDailyEdition()) {
      if (!doc.body.hasAttribute('data-neko-workspace-collapsed')) doc.body.setAttribute('data-neko-workspace-collapsed', '');
      if (roomPreview && !sideSocial && !roomActive) setRoomActive(true, {closeSocial:false});
    }
    // A valid selection snapshot with no session plus a visible DSH hero means
    // the native workspace was cleared. Global tool pages do not mount it.
    const selection = nativeSelection();
    startupContinue.hidden = !hasActiveDshSession();
    if (nativeNewPending && selection?.sessionId && selection.sessionId !== nativeNewBefore) stopNativeNew();
    const hero = doc.querySelector('.neko-gallery');
    if (!isOfficeEdition() && !startupOpen && !nativeNewPending && layout?.officeMode === 'dsh' && selection && !selection.sessionId && hero && !hero.closest('[hidden],[inert]')) {
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
    // The native sidebar is only a narrow navigation strip inside the much
    // wider chat track. Portal the companion out of that strip while the room
    // is shown: otherwise its ancestors clip both the sprite and pointer hits.
    // The real center-column edge is the boundary, not the window edge.
    const sidebar = doc.querySelector('[data-slot="sidebar"]');
    const centerRect = doc.querySelector('[data-neko-chat-center]')?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    const splitRooms=isDailyEdition()&&roomActive&&!sideSocial&&!doc.body.hasAttribute('data-neko-flex-social-hidden');
    const splitLobby=splitRooms&&!!lobby?.isOpen();syncCreationMode();
    roomPreview?.setSplit?.(isDailyEdition());
    doc.body.toggleAttribute('data-neko-room-columns',splitRooms);
    const titlebarRect=doc.querySelector('.neko-window-titlebar')?.getBoundingClientRect();
    const roomLeft=Math.max(0,railRect?.width>0?railRect.right:sidebarRect?.left||64),roomTop=Math.max(0,sidebarRect?.top||0,titlebarRect?.bottom||0),roomWidth=Math.max(0,win.innerWidth-roomLeft);
    const selectorWidth=roomSelectorWidth(roomWidth);
    const dailyRoomRect=splitRooms?{left:roomLeft,top:roomTop,right:win.innerWidth,bottom:win.innerHeight,width:roomWidth,height:Math.max(0,win.innerHeight-roomTop)}:null;
    if (isOfficeEdition()) {
      releaseRoomInert();
      if (roomPreview) roomPreview.hidden = true;
      if (lobby?.panel) { lobby.panel.style.visibility = 'hidden'; lobby.panel.setAttribute('inert', ''); }
      for (const node of [startup, sessionBrowser, seats, sceneProjects, directoryControl]) node.hidden = true;
      if (nativeBrowser && nativeMarks.get(nativeBrowser)?.has('data-neko-session-browser-original')) {
        const before = nativeMarks.get(nativeBrowser).get('data-neko-session-browser-original');
        if (before === null) nativeBrowser.removeAttribute('data-neko-session-browser-original'); else nativeBrowser.setAttribute('data-neko-session-browser-original', before);
        nativeMarks.get(nativeBrowser).delete('data-neko-session-browser-original');
      }
      if (companionDrag?.room) finishCompanionDrag({ pointerId: companionDrag.pointerId, type: 'pointercancel' });
      clearRoomCompanionGeometry();
      const wasLobby=dock.hasAttribute('data-neko-companion-lobby');dock.removeAttribute('data-neko-companion-expanded'); dock.removeAttribute('data-neko-companion-lobby');dock.removeAttribute('data-neko-companion-room-lobby');if(wasLobby)setLobbyChatOpen(false);
      dock.toggleAttribute('data-neko-office-floating', !!sidebar?.closest('[data-sidebar-collapsed="true"]'));
      if (account && (dock.parentNode !== account.parentNode || dock.nextSibling !== account)) account.before(dock);
      syncCompanionPlacement(rail); setCompanionOffset(companionOffset); watchDockAncestors(); syncCollapsedComposer(); positionCompanionMenu(); return;
    }
    sessionBrowser.hidden = seats.hidden = false; dock.removeAttribute('data-neko-office-floating');
    const sceneLobby = !!account && !!flexSocialRect && roomActive && !sideSocial && !!lobby?.isOpen() &&
      doc.body.hasAttribute('data-neko-fixed-scene') && doc.body.hasAttribute('data-neko-flex-workspace-collapsed') &&
      !doc.body.hasAttribute('data-neko-flex-social-hidden') && !sidebar?.closest('[data-sidebar-collapsed="true"]');
    const left = Math.max(0,splitLobby?roomLeft+selectorWidth+12:splitRooms?roomLeft+12:sceneLobby ? flexSocialRect.x : railRect?.width > 0 ? railRect.right : sidebarRect?.left || 0);
    const right = Math.min(win.innerWidth,splitLobby?win.innerWidth-12:splitRooms?roomLeft+selectorWidth-12:sceneLobby ? flexSocialRect.x + flexSocialRect.width : centerRect && centerRect.left > left ? centerRect.left : 0);
    const expanded = !!account && roomActive && !sideSocial &&
      (splitRooms || sceneLobby || !doc.body.hasAttribute('data-neko-flex-mode')) &&
      !doc.body.hasAttribute('data-neko-flex-social-hidden') &&
      (splitRooms || !sidebar?.closest('[data-sidebar-collapsed="true"]')) && right - left >= 80;
    const fullLobby = !splitRooms && !sceneLobby && expanded && !!lobby?.isOpen() && doc.body.hasAttribute('data-neko-workspace-collapsed');
    const activeLobby = expanded && (splitLobby || !splitRooms && (fullLobby || sceneLobby));
    const wasFullLobby = dock.hasAttribute('data-neko-companion-lobby');
    if (dock.hasAttribute('data-neko-companion-room-lobby') !== splitLobby && companionDrag) finishCompanionDrag({ pointerId: companionDrag.pointerId, type: 'pointercancel' });
    dock.toggleAttribute('data-neko-companion-room-lobby',splitLobby);
    if (!splitLobby) clearRoomCompanionGeometry();
    if (lobby?.panel) lobby.panel.toggleAttribute('data-neko-lobby-full', fullLobby);
    if (fullLobby) {
      const floating = hasNativeComposerBridge ? floatingBounds() : null;
      const reserved = floating && floating.y+floating.height>win.innerHeight-220 ? Math.max(0,Math.min(win.innerWidth*.55,Math.round(win.innerWidth-floating.x+12))) : 0;
      const value = `${reserved}px`;
      if (doc.body.style.getPropertyValue('--neko-lobby-floating-reserve') !== value) doc.body.style.setProperty('--neko-lobby-floating-reserve', value);
    } else if (doc.body.style.getPropertyValue('--neko-lobby-floating-reserve')) doc.body.style.removeProperty('--neko-lobby-floating-reserve');
    if (activeLobby !== wasFullLobby) {
      dock.toggleAttribute('data-neko-companion-lobby', activeLobby);
      if (!activeLobby) hideCompanionReply();
      if (activeLobby) {
        closeCompanionMenu(false);
        character.removeAttribute('aria-haspopup'); character.setAttribute('aria-controls', companionChatPanel.id);
        character.setAttribute('aria-label', splitLobby ? '大肥鱼，点击展开或收起聊天，拖动或方向键移动' : '大肥鱼，点击展开或收起聊天，左右方向键移动');
        character.title = splitLobby ? '点击聊天 · 自由拖动 · 方向键移动 · Home 还原位置' : '点击聊天 · 左右拖动 · Home 回到中间';
      } else {
        character.setAttribute('aria-haspopup', 'menu'); character.setAttribute('aria-controls', companionMenu.id);
        character.setAttribute('aria-label', typeof bridge.home==='function'?'大肥鱼，点击回到我的小窝，右键互动，左右方向键移动':'大肥鱼，点击打开互动菜单，左右方向键移动');
        character.title = typeof bridge.home==='function'?'点击回家 · 右键互动 · 左右拖动':'点击互动 · 左右拖动 · Home 回到中间';
      }
      if (activeLobby) lobbyChatOpen = true;
      setLobbyChatOpen(lobbyChatOpen);
    }
    // 猫猫设置 stays below her, but its fields must stay usable: while it is
    // open her private chat folds away and (in the split room) she steps to the
    // right edge beside the card. Closing restores both exactly.
    const settingsOpen = activeLobby && !!lobby?.dialogOpen?.(), settingsAway = settingsOpen && splitLobby;
    if (settingsOpen !== !!companionSettingsAway) {
      if (settingsOpen) { companionSettingsAway = { chat:lobbyChatOpen, x:roomCompanionX, y:roomCompanionY }; if (lobbyChatOpen) setLobbyChatOpen(false); }
      else { const saved = companionSettingsAway; companionSettingsAway = null; roomCompanionX = saved.x; roomCompanionY = saved.y; if (activeLobby && saved.chat !== lobbyChatOpen) setLobbyChatOpen(saved.chat); }
    }
    dock.toggleAttribute('data-neko-companion-settings-away', settingsAway);
    const chatHeight = activeLobby && lobbyChatOpen ? Math.ceil(companionChatPanel.getBoundingClientRect().height + 8) : 0;
    const chatHeightValue = `${chatHeight}px`;
    if (doc.body.style.getPropertyValue('--neko-companion-chat-height') !== chatHeightValue) doc.body.style.setProperty('--neko-companion-chat-height', chatHeightValue);
    if (expanded) {
      const accountRect = account.getBoundingClientRect();
      const bottom = splitRooms?win.innerHeight-12:accountRect.height > 0 && accountRect.top > 60 ? accountRect.top : win.innerHeight;
      const floating = hasNativeComposerBridge ? floatingBounds() : null;
      const safeRight = !splitRooms && floating && floating.y+floating.height>bottom-160 && floating.x>left+220 ? Math.min(right, floating.x - 12) : right;
      const chatWidth=splitLobby?Math.min(settingsAway?ROOM_COMPANION_NARROW:320,Math.max(0,safeRight-left)):Math.max(0,safeRight-left),chatLeft=splitLobby?left+(safeRight-left-chatWidth)/2:left;
      const geometry = { '--neko-companion-width': `${Math.floor(chatWidth)}px` };
      if (!splitLobby) geometry['--neko-companion-left'] = `${Math.round(chatLeft)}px`;
      if (!splitLobby && (!activeLobby || !doc.body.style.getPropertyValue('--neko-companion-bottom'))) geometry['--neko-companion-bottom'] = `${Math.max(0, Math.round(win.innerHeight - bottom))}px`;
      for (const [name, value] of Object.entries(geometry)) if (doc.body.style.getPropertyValue(name) !== value) doc.body.style.setProperty(name, value);
      if (!dock.hasAttribute('data-neko-companion-expanded')) dock.setAttribute('data-neko-companion-expanded', '');
      if (dock.parentNode !== doc.body) { dockIntersecting = null; doc.body.appendChild(dock); }
    } else {
      dock.removeAttribute('data-neko-companion-expanded');
      if (account && (dock.parentNode !== account.parentNode || dock.nextSibling !== account)) { dockIntersecting = null; account.before(dock); }
    }
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
      const side = dailyRoomRect || (flexSocialRect ? {left:flexSocialRect.x,top:flexSocialRect.y,right:flexSocialRect.x+flexSocialRect.width,bottom:flexSocialRect.y+flexSocialRect.height,width:flexSocialRect.width,height:flexSocialRect.height} : slotRect?.width > 0 && slotRect?.height > 0 ? slotRect : track?.getBoundingClientRect());
      let bottom = side?.bottom;
      for (const node of splitRooms||activeLobby ? [] : flexSocialRect ? [account?.parentElement] : [account?.parentElement, dock, account]) {
        const r = node?.getBoundingClientRect();
        if (r && r.height > 0 && r.top > (side?.top || 0) + 60) bottom = Math.min(bottom, r.top);
      }
      const visible = !!side && side.width >= 80 && bottom - side.top >= 80 && (splitRooms || !sidebar?.closest('[data-sidebar-collapsed="true"]'));
      if (visible) {
        const values = { left: `${Math.round(side.left)}px`, top: `${Math.round(side.top)}px`, width: `${Math.round(side.width)}px`, height: `${Math.round(bottom - side.top)}px` };
        const paneHeight = `${Math.round(side.height)}px`;
        if (roomPreview.style.getPropertyValue('--neko-chatroom-pane-height') !== paneHeight) roomPreview.style.setProperty('--neko-chatroom-pane-height', paneHeight);
        for (const [key, value] of Object.entries(values)) if (roomPreview.style[key] !== value) roomPreview.style[key] = value;
        if(splitRooms){const width=selectorWidth+'px';if(roomPreview.style.getPropertyValue('--neko-room-selector-width')!==width)roomPreview.style.setProperty('--neko-room-selector-width',width);const reserve=Math.max(180,Math.min(420,splitLobby?(floatingBounds()?.height||120)+24:Math.ceil(dock.getBoundingClientRect().height||0)+140))+'px';if(roomPreview.style.getPropertyValue('--neko-room-chat-reserve')!==reserve)roomPreview.style.setProperty('--neko-room-chat-reserve',reserve);}
        lobby?.panel.toggleAttribute('data-neko-room-column',splitRooms);
        if(lobby?.panel){const floating=splitRooms&&hasNativeComposerBridge?floatingBounds():null,contentLeft=side.left+selectorWidth,nearForm=floating&&floating.x+floating.width>contentLeft&&floating.x<side.right&&floating.y+floating.height>bottom-160&&floating.y<bottom;const reserve=nearForm?Math.min(Math.max(0,bottom-side.top-180),Math.max(0,bottom-floating.y+12)):0,value=Math.round(reserve)+'px';if(lobby.panel.style.getPropertyValue('--neko-room-work-reserve')!==value)lobby.panel.style.setProperty('--neko-room-work-reserve',value);}
        lobby?.place(splitRooms?{...values,left:Math.round(side.left+selectorWidth)+'px',width:Math.max(0,Math.round(side.width-selectorWidth))+'px'}:values);
        if(lobby?.panel){const reserve=splitLobby?Math.ceil(dock.getBoundingClientRect().height||0)+12:0,value=reserve+'px';if(lobby.panel.style.getPropertyValue('--neko-room-companion-reserve')!==value)lobby.panel.style.setProperty('--neko-room-companion-reserve',value);}
        if (activeLobby) {
          const formRect = lobby.panel.querySelector('.neko-lobby-form')?.getBoundingClientRect();
          const modeRect = lobby.panel.querySelector('.neko-lobby-modebar')?.getBoundingClientRect();
          const top = modeRect?.height > 0 ? modeRect.top : formRect?.top;
          if (splitLobby) {
            const middleRect = lobby.panel.querySelector('.neko-lobby-middle')?.getBoundingClientRect(), headerRect = lobby.panel.querySelector('.neko-lobby-header')?.getBoundingClientRect();
            const areaLeft = side.left + selectorWidth + 12, areaRight = side.right - 12, width = Math.max(0, Math.min(settingsAway ? ROOM_COMPANION_NARROW : 320, areaRight - areaLeft));
            const areaTop = Math.max(side.top + 8, middleRect?.height > 0 ? middleRect.top + 4 : headerRect?.height > 0 ? headerRect.bottom + 4 : side.top + 8);
            // Keep the whole dock above every lower public control, including
            // participation choices and a wrapped sign-in/connection reason.
            const controlsTop = Math.min(...[modeRect, formRect].filter(rect => rect?.height > 0).map(rect => rect.top));
            const areaBottom = Math.min(side.bottom - 12, controlsTop - 4), available = Math.max(0, areaBottom - areaTop);
            const spriteHeight = Math.min(90, Math.max(24, available - (lobbyChatOpen ? Math.min(60, available * .6) : 0) - 4));
            const sizes = { '--neko-room-companion-sprite-height': `${spriteHeight}px`, '--neko-room-companion-panel-max-height': `${Math.max(0, available - spriteHeight - 4)}px` };
            for (const [name, value] of Object.entries(sizes)) if (doc.body.style.getPropertyValue(name) !== value) doc.body.style.setProperty(name, value);
            const height = dock.getBoundingClientRect().height || spriteHeight + 4 + (lobbyChatOpen ? companionChatPanel.getBoundingClientRect().height : 0), centeredLeft = areaLeft + (areaRight - areaLeft - width) / 2;
            // Public controls beneath her: she may sink into gaps between
            // them, never onto them, and never below the channel form's top.
            const measured = nodes => nodes.filter(node => node && !node.hidden).map(node => node.getBoundingClientRect()).filter(rect => rect?.height > 0).map(rect => ({ left:Number.isFinite(rect.left) ? rect.left : -Infinity, right:Number.isFinite(rect.right) ? rect.right : Infinity, top:rect.top }));
            const modeParts = measured([...(lobby.panel.querySelector('.neko-lobby-modebar')?.children || [])]);
            const obstacles = [...(modeParts.length ? modeParts : measured([lobby.panel.querySelector('.neko-lobby-modebar')])), ...measured([lobby.panel.querySelector('.neko-lobby-error'), lobby.panel.querySelector('.neko-lobby-assist'), lobby.panel.querySelector('.neko-lobby-form')])];
            const floor = Math.min(side.bottom - 12, formRect?.height > 0 ? formRect.top - 4 : side.bottom - 12);
            const maxY = x => { const l = centeredLeft + x, r = l + width; let limit = floor; for (const rect of obstacles) if (rect.left < r && rect.right > l) limit = Math.min(limit, rect.top - 4); return limit - areaBottom; };
            roomCompanionBounds = { left: centeredLeft, bottom: areaBottom, width, maxY, minX: Math.ceil(areaLeft - centeredLeft), maxX: Math.floor(areaRight - width - centeredLeft), minY: Math.min(0, Math.ceil(areaTop + height - areaBottom)) };
            if (settingsAway) { roomCompanionX = roomCompanionBounds.maxX; roomCompanionY = 0; }
            setRoomCompanionPosition(roomCompanionX, roomCompanionY);
            const dialogReserve = settingsAway ? Math.ceil(width + 24) + 'px' : '';
            if (lobby.panel.style.getPropertyValue('--neko-lobby-dialog-companion-reserve') !== dialogReserve) { if (dialogReserve) lobby.panel.style.setProperty('--neko-lobby-dialog-companion-reserve', dialogReserve); else lobby.panel.style.removeProperty('--neko-lobby-dialog-companion-reserve'); }
          } else if (formRect?.height > 0 && top > 60) {
            const value = `${Math.max(0, Math.round(win.innerHeight - top + 4))}px`;
            if (doc.body.style.getPropertyValue('--neko-companion-bottom') !== value) doc.body.style.setProperty('--neko-companion-bottom', value);
          }
        }
        protectRoomFooter(sidebar, account);
      } else releaseRoomInert();
      const showRoom = visible && roomActive && !sideSocial && !doc.body.hasAttribute('data-neko-flex-social-hidden');
      const showLobby = showRoom && !!lobby?.isOpen() && modal.hidden;
      if (roomPreview.hidden !== (!showRoom || showLobby&&!splitRooms)) roomPreview.hidden = !showRoom || showLobby&&!splitRooms;
      if (lobby) { lobby.panel.style.visibility = showLobby ? '' : 'hidden'; lobby.panel.toggleAttribute('inert', !showLobby); }
    }
    if (!roomPreview && lobby?.isOpen() && root) {
      const r=root.getBoundingClientRect();
      lobby.place({left:`${Math.round(r.left||0)}px`,top:`${Math.round(r.top||0)}px`,width:`${Math.round(r.width||r.right||0)}px`,height:`${Math.round(r.height||win.innerHeight)}px`});
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
      const contentTop = Math.max(0, doc.querySelector('[data-neko-window-titlebar]')?.getBoundingClientRect().bottom || 0);
      panel.toggleAttribute('data-neko-compact', win.innerWidth - x <= 400);
      Object.assign(panel.style, { left: x + 'px', top: contentTop + 'px', width: Math.max(0, win.innerWidth - x) + 'px', height: Math.max(0, bottom - contentTop) + 'px' });
      // In unified mode only cover the actual coding track, never a native
      // community or video WebContentsView. The hidden track keeps the chooser
      // pending so it returns when the user switches back to coding.
      const unified = doc.body.hasAttribute('data-neko-unified-enabled') && !doc.body.hasAttribute('data-neko-side-social-active');
      const coding = unified ? doc.querySelector('[data-neko-unified-coding]') : null;
      const codeRect = coding?.getBoundingClientRect();
      const codeVisible = !!coding && coding.getAttribute('data-neko-unified-coding') !== 'hidden' && !coding.hasAttribute('inert') && codeRect?.width > 0 && codeRect?.height > 0;
      const px = unified && codeVisible ? Math.ceil(codeRect.left) : x;
      const py = unified && codeVisible ? Math.max(contentTop + 56, Math.ceil(codeRect.top)) : contentTop + 56;
      const pw = unified && codeVisible ? Math.floor(codeRect.width) : Math.max(0, win.innerWidth - x);
      const ph = unified && codeVisible ? Math.max(0, Math.min(bottom, Math.floor(codeRect.bottom)) - py) : Math.max(0, bottom - py);
      const sceneCoding = doc.body.hasAttribute('data-neko-fixed-scene') && codeVisible && !doc.body.hasAttribute('data-neko-flex-workspace-collapsed');
      sceneProjects.hidden = !sceneCoding;
      if (sceneCoding) Object.assign(sceneProjects.style, {left: Math.max(px, px + pw - 112) + 'px', top: (py + 4) + 'px'});
      const floatRecords = doc.body.hasAttribute('data-neko-workspace-collapsed');
      startup.toggleAttribute('data-neko-floating-records', floatRecords);
      if (floatRecords) {
        startup.hidden = !floatingRecordsOpen;
        Object.assign(startup.style, { left: 'auto', top: 'auto', right: '16px', bottom: '120px' });
        if (!startup.dataset.nekoFloatingSized) { startup.style.width = 'min(480px, calc(100vw - 96px))'; startup.style.height = 'min(520px, calc(100vh - 160px))'; startup.dataset.nekoFloatingSized = ''; }
      } else {
        floatingRecordsOpen = false; startup.removeAttribute('data-neko-floating-sized'); startup.style.right = ''; startup.style.bottom = '';
        startup.hidden = !startupOpen || doc.body.hasAttribute('data-neko-flex-workspace-collapsed') || (unified && !codeVisible);
        Object.assign(startup.style, { left: px + 'px', top: py + 'px', width: pw + 'px', height: ph + 'px' });
      }
      // Position above the composer so the native send/model controls retain
      // their hit targets, and follow the actual coding pane during resizing.
      const visible = !doc.body.hasAttribute('data-neko-workspace-collapsed') && !doc.body.hasAttribute('data-neko-flex-workspace-collapsed') && (!unified || codeVisible) && pw >= 100 && ph >= 100;
      directoryControl.hidden = !visible;
      if (visible) {
        const composer = startupOpen ? null : doc.querySelector('[data-neko-chat-center] [data-composer-card]');
        const composerRect = composer?.getBoundingClientRect();
        const top = composerRect?.height > 0 && composerRect.top > py + 40 ? composerRect.top - 40 : py + ph - 48;
        const left = Math.round(px + pw - 44) + 'px', y = Math.round(Math.max(py + 4, Math.min(py + ph - 40, top))) + 'px';
        if (directoryControl.style.left !== left) directoryControl.style.left = left;
        if (directoryControl.style.top !== y) directoryControl.style.top = y;
        const statusWidth = Math.max(0, Math.min(220, pw - 8)) + 'px';
        if (directoryStatus.style.maxWidth !== statusWidth) directoryStatus.style.maxWidth = statusWidth;
      }
    } else { directoryControl.hidden = true; sceneProjects.hidden = true; }
    if (isDailyEdition()) for (const node of [startup, sessionBrowser, seats, sceneProjects, directoryControl]) node.hidden = true;
    syncCollapsedComposer(); positionCompanionMenu();
  }
  function schedule() { if (!disposed && !queued) { queued = true; Promise.resolve().then(() => { queued = false; place(); positionCompanionMenu(); }); } }
  function nativeNew(event) {
    if (isOfficeEdition()) return;
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
  function escape(event) { if (event.key !== 'Escape') return; if (!companionMenu.hidden) { event.preventDefault(); event.stopPropagation(); closeCompanionMenu(); } else if (!modal.hidden) { event.stopPropagation(); closeSettings(); } else if ((layout?.companionHistoryOpen || historyPeek) && dock.contains(doc.activeElement)) { event.preventDefault(); historyPeek = false; saveLayout({ companionHistoryOpen: false }); historyToggle.focus(); } else if (dock.hasAttribute('data-neko-companion-lobby') && lobbyChatOpen && dock.contains(doc.activeElement)) { event.preventDefault(); event.stopPropagation(); setLobbyChatOpen(false, true); } }
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
  resize?.observe(companionChatPanel);
  if (lobby?.panel) resize?.observe(lobby.panel.querySelector('.neko-lobby-form'));
  doc.body.setAttribute('data-neko-workspace-shell', '');
  function openAccountCommunity(event) {
    const detail=event.detail;if(!detail||disposed)return;detail.handled=true;
    detail.promise=(async()=>{if(isOfficeEdition()&&!await saveLayout({workbenchEdition:'daily'}))throw Error('版本切换未完成');closeSettings();lobby?.hide();await options.openCommunity?.();if(typeof detail.isCurrent==='function'&&!detail.isCurrent())return;if(detail.login!==false){const signIn=bridge.nekoSignIn||bridge.communityLogin;return await signIn?.call(bridge,{source:detail.source||'account'});}})().catch(error=>{showError(error);throw error;});
  }
  function openHomeWork(event){const detail=event.detail;if(!detail||disposed)return;detail.handled=true;detail.promise=(async()=>{const draft=floatingComposer?.snapshot?.(),selection=nativeSelection(),unbound=!draft?.sessionId&&!selection?.sessionId&&options.hasDshActiveSession?.()===false;const clean=draft?.available&&draft.phase==='plain'&&!draft.draft;if(!unbound&&!clean)throw Error(draft?.draft?'当前工作会话有未发送的输入，请先保留后再打开共建会话': draft?.reason||'请先完成当前工作输入后再打开共建会话');const result=await call({action:'home-session'});if(typeof options.openDshSession!=='function')throw Error('共建工作会话暂不可用');const current=floatingComposer?.snapshot?.(),now=nativeSelection();if(disposed||current?.draft!==draft?.draft||current?.sessionId!==draft?.sessionId||now?.sessionId!==selection?.sessionId)throw Error('当前工作输入已变化，请保留后重新打开共建会话');await options.openDshSession(result.sessionId);catalog=null;refreshCatalog(true);schedule();})();}
  doc.addEventListener('neko-home-build-workspace',openHomeWork);releases.push(()=>doc.removeEventListener('neko-home-build-workspace',openHomeWork));
  doc.addEventListener('neko-account-open-community',openAccountCommunity);
  releases.push(()=>doc.removeEventListener('neko-account-open-community',openAccountCommunity));
  if (typeof options.subscribeDshSelection === 'function') {
    try {
      let lastSessionId = nativeSelection()?.sessionId || null;
      const releaseSelection = options.subscribeDshSelection(() => {
        const nextSessionId = nativeSelection()?.sessionId || null;
        if (nextSessionId !== lastSessionId) { lastSessionId = nextSessionId; directoryStatus.textContent = ''; directoryStatus.hidden = true; renderCatalog(); }
        schedule();
      });
      if (typeof releaseSelection === 'function') releases.push(releaseSelection);
    } catch { /* Older DSH versions may not expose selection subscriptions. */ }
  }
  if (typeof bridge.subscribe === 'function') releases.push(bridge.subscribe(next => {
    if (disposed) return; state = next; const connections = modalBody.querySelector('.neko-workspace-connections'); if (connections) connections.textContent = connectionSummary(); if (!selectedProject) selectedProject = next.workspaceRoot || '';
    renderCompanion(); if (next.workspaceRevision !== layoutVersion) { layoutVersion = next.workspaceRevision; call({ action: 'state' }).then(value => { if (!disposed) { layout = value; renderLayout(); } }).catch(showError); }
  }));
  if (typeof bridge.subscribeOffice === 'function') releases.push(bridge.subscribeOffice(next => { if (disposed) return; if (next.thread?.id === selectedId || sendContext?.version === readVersion && sendContext.id === null) { office = next; } else { office.approvals = next.approvals || []; } renderOffice(); }));
  if (typeof bridge.subscribeCommunity === 'function') releases.push(bridge.subscribeCommunity(next => { if (disposed || next?.slot) return; socialOpen = next.status !== 'hidden'; if (socialOpen) lobby?.hide(); renderOffice(); }));
  Promise.all([bridge.getState(), call({ action: 'state' })]).then(([s, l]) => { if (!disposed) { state = s; layout = l; selectedProject ||= s.workspaceRoot || ''; renderLayout(); refreshCatalog(); } }).catch(error => { catalogError = '工作会话读取失败，请刷新重试'; renderStartup(); showError(error); });
  syncCharacter();
  const interval = win.setInterval(() => { if (doc.visibilityState !== 'hidden') refreshCatalog(false, 0, { quiet:true }); }, 60000);
  place();
  return () => {
    questionController?.dispose();if(typeof bridge.questions==='function')void Promise.resolve(bridge.questions({action:'publish',items:[]})).catch(()=>{});
    doc.removeEventListener('neko-request-composer-geometry', requestCollapseGeometry);
    clearCollapsedComposer(); collapseResize?.disconnect(); if (collapseNoticeTimer) win.clearTimeout(collapseNoticeTimer);
    if (disposed) return; disposed = true; hideCompanionReply(); floatingComposer?.dispose(); if (floatingGeometry) floatingCall({action:'remove'}); stopNativeNew(); motion?.removeEventListener?.('change', syncCharacter); motion?.removeEventListener?.('change', syncRailWalking); doc.removeEventListener('visibilitychange', syncCharacter); doc.removeEventListener('visibilitychange', syncRailWalking); stopRailWalking(); if (railClickTimer !== null) win.clearTimeout(railClickTimer); if (railSpace) { if (railSpaceBeforeAria === null) railSpace.removeAttribute('aria-hidden'); else railSpace.setAttribute('aria-hidden', railSpaceBeforeAria); } if (characterVideo) { characterVideo.pause(); characterVideo.removeAttribute('src'); characterVideo.load(); } observer.disconnect(); ancestorObserver.disconnect(); intersection?.disconnect(); resize?.disconnect(); win.clearInterval(interval);
    win.removeEventListener('resize', place); win.removeEventListener('pointerup', finishCompanionDrag, true); win.removeEventListener('pointercancel', finishCompanionDrag, true); win.removeEventListener('pointermove', finishCompanionOnUnpressedMove, true); win.removeEventListener('blur', finishCompanionOnBlur); doc.removeEventListener('scroll', schedule, true); doc.removeEventListener('click', nativeNew, true); doc.removeEventListener('keydown', escape, true);
    doc.removeEventListener('pointerdown', dismissCompanionMenu, true);
    doc.removeEventListener('neko-native-tools-navigate', showNativeToolsPage);
    doc.removeEventListener('neko-fixed-scene-enter', onFixedSceneEnter); doc.removeEventListener('neko-fixed-scene-exit', onFixedSceneExit);
    doc.removeEventListener('neko-side-surface-change', sideSurfaceChanged);
    doc.removeEventListener('neko-flex-social-geometry', onFlexSocialGeometry);
    if (roomPreview) { doc.removeEventListener('neko-chatroom-show-workspace', showWorkspaceFromLayout); doc.body.removeAttribute('data-neko-chatroom-active'); releaseRoomInert(); doc.dispatchEvent(new win.Event('neko-chatroom-mode-change')); }
    for (const release of releases) if (typeof release === 'function') release();
    for (const [node, attrs] of nativeMarks) for (const [name, before] of attrs) { if (node.getAttribute(name) === '') { if (before === null) node.removeAttribute(name); else node.setAttribute(name, before); } }
    if (doc.body.hasAttribute('data-neko-daily-compact')) doc.body.removeAttribute('data-neko-workspace-collapsed');
    doc.body.removeAttribute('data-neko-daily-compact');
    doc.body.removeAttribute('data-neko-room-columns');
    clearRoomCompanionGeometry();
    doc.body.removeAttribute('data-neko-workspace-shell'); doc.body.removeAttribute('data-neko-office-mode'); doc.body.removeAttribute('data-neko-workbench-edition');
    for (const n of nodes) n.remove(); style.remove();
  };
}

// Lobby (频道) view. Renderer only: every value from the lobby snapshot is written with textContent or DOM
// calls, never parsed as HTML. Drafts, the reply target and picked mentions stay in this closure.
// It never hides, inerts or rebuilds the companion dock, and degrades to nothing when bridge.lobby fails.
function createLobbyView({ doc, bridge, el, button, image, avatar, composer, companion, onOpen, onBack, onChange }) {
  const MAX_TEXT = 2000, TIME_GAP_MS = 5 * 60 * 1000, MENTION = /<@([uc]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;
  const MODES = [['off', '她不参与'], ['assist', '一起回复'], ['independent', '她自己说话']];
  let snap = null, open = false, joined = false, disposed = false, error = '', replyToId = null, picked = [], picker = null, sending = false;
  let loginEpoch=0,localSigningIn=false,loginCancelPending=false,unifiedAttempt=false,unifiedLoginState=null,loginReturn=null,pauseJoin=false;
  // Draft state (text, reply target, 人＋AI marker, undo) lives in lobby-composer.js; without it the assist flow is off.
  const C = composer && typeof composer.create === 'function' ? composer : null;
  const TRIGGERS = [['mention', '只在被 @ 时'], ['owner_or_mention', '主人说话或被 @ 时'], ['free', '自由发言']];
  const CAT_AVATARS = [['bigfish', '大肥鱼'], ['yui', 'YUi'], ['devcat', '开发喵'], ['gemini', 'Gemini小猫']];
  const SLOW = [[0, '关闭'], [5, '5 秒'], [10, '10 秒'], [30, '30 秒'], [60, '60 秒']];
  const MUTES = [[10, '禁言 10 分钟'], [60, '禁言 1 小时'], [1440, '禁言 24 小时']];
  let draft = C ? C.create() : null, assistOpen = false, menuFor = null, dialog = null, lastMode = null, nudgeSeen = null, membersKey = '', cardKey = '';
  let browsingHistory = false, loadingOlder = false, messageMenuAnchor = null;
  const rows = new Map();
  const svg = (tag, attrs) => { const n = doc.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const railButton = button('', 'neko-side-rail__button neko-lobby-switch', () => toggle());
  railButton.setAttribute('aria-label', '频道 · 公共大厅'); railButton.title = '频道 · 公共大厅'; railButton.setAttribute('aria-expanded', 'false');
  const icon = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  icon.appendChild(svg('path', { d: 'M4 6h16v10H10l-4 3v-3H4V6Zm4 4h8M8 13h5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  railButton.appendChild(icon);
  const panel = el('section', 'neko-lobby-panel'); panel.hidden = true; panel.setAttribute('aria-label', '频道 · 公共大厅');
  const header = el('header', 'neko-lobby-header'), title = el('strong', 'neko-lobby-title', '频道'), topic = el('span', 'neko-lobby-topic'), onlineCount = el('span', 'neko-lobby-online');
  const back = button('← 返回', 'neko-lobby-back', () => { hide(); onBack?.(); }); back.setAttribute('aria-label', '返回聊天室列表');
  onlineCount.setAttribute('aria-live', 'polite');
  const signOut = button('退出登录', 'neko-lobby-sign-out', () => call({ action: 'sign-out' }));
  const headerActions = el('div', 'neko-lobby-header__actions');
  const membersToggle = button('成员', 'neko-lobby-members-toggle', () => { const expanded = panel.toggleAttribute('data-members-open'); membersToggle.setAttribute('aria-expanded', String(expanded)); });
  membersToggle.setAttribute('aria-controls', 'neko-lobby-members'); membersToggle.setAttribute('aria-expanded', 'false');
  const gameShareButton = button('分享游戏', 'neko-lobby-game-share', () => openDialog('game')); gameShareButton.setAttribute('aria-haspopup', 'dialog');
  const catSettingsButton = button('猫猫设置', 'neko-lobby-cat-settings', () => openDialog('cat')); catSettingsButton.setAttribute('aria-haspopup', 'dialog');
  const adminButton = button('管理', 'neko-lobby-admin-open', () => openDialog('admin')); adminButton.setAttribute('aria-haspopup', 'dialog'); adminButton.dataset.admin = '';
  const historyButton = button('', 'neko-lobby-history', () => {
    if (browsingHistory) {
      browsingHistory = false;
      log.scrollTop = log.scrollHeight;
      renderHistory();
    } else {
      log.scrollTop = 0;
      void loadOlder();
    }
  });
  const historyIcon = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  historyIcon.appendChild(svg('path', { d: 'M3 10a9 9 0 1 1 1 7M3 5v5h5m4-3v5l3 2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  historyButton.appendChild(historyIcon);
  headerActions.append(membersToggle, gameShareButton, catSettingsButton, signOut, historyButton);
  header.append(back, title, topic, onlineCount, headerActions);
  const gate = el('div', 'neko-lobby-gate'), gateText = el('p', 'neko-lobby-gate__text');
  const signIn = button(typeof bridge.nekoSignIn==='function'?'一键登录 N.E.K.O.':'登录频道', 'neko-lobby-sign-in', () => {void beginSignIn();});
  const signInCancel = button('取消登录', 'neko-lobby-sign-in-cancel', () => {void cancelSignIn();});
  const reconnect = button('重新连接', 'neko-lobby-reconnect', () => join(true));
  gate.append(gateText, signIn, signInCancel, reconnect);
  const historyStatus = el('div', 'neko-lobby-history-status'); historyStatus.setAttribute('role', 'status'); historyStatus.hidden = true;
  const log = el('div', 'neko-lobby-log'); log.id = 'neko-lobby-log'; log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-label', '频道消息'); log.tabIndex = 0;
  historyButton.setAttribute('aria-controls', log.id);
  log.addEventListener('scroll', () => {
    closeMessageMenu();
    if (log.scrollTop <= 12 && log.scrollHeight > log.clientHeight && snap?.hasMore) void loadOlder();
  });
  log.addEventListener('wheel', event => { if (event.deltaY < 0 && log.scrollTop <= 12 && snap?.hasMore) void loadOlder(); }, { passive: true });
  log.addEventListener('keydown', event => {
    if (event.target === log && ['ArrowUp', 'PageUp', 'Home'].includes(event.key) && log.scrollTop <= 12 && snap?.hasMore) void loadOlder();
  });
  const empty = el('p', 'neko-lobby-empty', '还没有消息，来打个招呼吧');
  const middle = el('div', 'neko-lobby-middle'), stream = el('div', 'neko-lobby-stream');
  const members = el('aside', 'neko-lobby-members'); members.id = 'neko-lobby-members'; members.setAttribute('aria-label', '频道成员');
  const membersTitle = el('h3', 'neko-lobby-members__title', '成员'), memberList = el('ul', 'neko-lobby-member-list');
  members.append(membersTitle, memberList); stream.append(log, historyStatus); middle.append(stream, members);
  const messageMenu = el('div', 'neko-lobby-message-menu'); messageMenu.id = 'neko-lobby-message-menu'; messageMenu.hidden = true;
  messageMenu.setAttribute('role', 'group'); messageMenu.setAttribute('aria-label', '消息操作');
  const dismissMessageMenu = event => {
    if (!messageMenu.hidden && !messageMenu.contains(event.target) && !messageMenuAnchor?.contains(event.target)) closeMessageMenu();
  };
  doc.addEventListener('pointerdown', dismissMessageMenu);
  doc.addEventListener('focusin', dismissMessageMenu);
  messageMenu.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); closeMessageMenu(true);
  });
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
  panel.append(header, gate, middle, notice, modeBar, assist, form, messageMenu); doc.body.appendChild(panel);

  const connection = () => snap?.connection || 'unconfigured';
  const connected = () => !['unconfigured', 'signed-out'].includes(connection());
  const meId = () => snap?.me?.user_id || null;
  const ownCat = author => author?.kind === 'cat' && !!meId() && author.owner_user_id === meId();
  const ownHuman = author => author?.kind === 'human' && !!meId() && author.user_id === meId();
  const isAdmin = () => connection() === 'online' && !!snap?.me?.is_admin;
  const assistOn = () => !!C && connection() === 'online' && !!snap?.participation?.available && snap.participation.mode === 'assist' && !!snap?.me?.cat?.id;
  // The main-agent route is ready (independent of a server cat profile).
  // Older snapshots without providerAvailable fall back to cat.available.
  const lineReady = () => { const part = snap?.participation; return connection() === 'online' && (typeof part?.providerAvailable === 'boolean' ? part.providerAvailable : snap?.cat?.available === true || part?.available === true); };
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
  function renderHistory() {
    const label = browsingHistory ? '返回最新消息' : '聊天记录';
    historyButton.title = label;
    historyButton.setAttribute('aria-label', label);
    historyButton.setAttribute('aria-pressed', String(browsingHistory));
    historyButton.hidden = connection() !== 'online';
    historyStatus.textContent = loadingOlder ? '正在加载更早的消息…' : snap?.historyCapped ? '已达到本次浏览上限' : '';
    historyStatus.hidden = !browsingHistory || !historyStatus.textContent;
  }
  async function loadOlder() {
    if (!open || connection() !== 'online') return;
    browsingHistory = true;
    if (loadingOlder || !snap?.hasMore || snap.historyCapped) { renderHistory(); return; }
    loadingOlder = true;
    renderHistory();
    try { await call({ action: 'load-older' }); }
    finally { loadingOlder = false; if (!disposed) renderHistory(); }
  }
  const unifiedBusy=()=>['checking','community','chatroom'].includes(unifiedLoginState?.status);
  // connected: both official grants exist but one principal is unproven. It is
  // a usable, non-error end state and must not prompt another authorization.
  const loginTerminal=status=>['signed-in','connected','partial','error','canceled'].includes(status);
  const loginUsable=status=>status==='signed-in'||status==='connected';
  const loginRank=status=>({checking:0,community:1,chatroom:2,'signed-in':3,connected:3,partial:3,error:3,canceled:3})[status]??-1;
  function join(force = false) { if (!open || unifiedBusy() || pauseJoin&&!force || (!force && joined) || !connected()) return;pauseJoin=false; joined = true; call({ action: 'open' }); }
  function restoreLoginLobby(){
    const pending=loginReturn;if(!pending?.terminal||pending.navigating||disposed)return;
    loginReturn=null;pauseJoin=!(pending.terminal.lobbyAvailable===true||loginUsable(pending.terminal.status));
    if(!loginUsable(pending.terminal.status))error=pending.terminal.error||pending.terminal.message||error;
    if(pending.relayStarted){const detail={connect:!pauseJoin,returnFocus:input};doc.dispatchEvent(new doc.defaultView.CustomEvent('neko-account-open-lobby',{detail}));if(!detail.handled)show({connect:!pauseJoin});else Promise.resolve(detail.promise).catch(()=>{if(!disposed){error='聊天室暂未恢复，请重新打开';render();}});}
    else if(!pauseJoin&&open)join();
    render();
  }
  function observeUnifiedLogin(flow){
    if(disposed||!flow||typeof flow!=='object')return;
    if(unifiedLoginState?.flowId>flow.flowId)return;
    if(unifiedLoginState?.flowId===flow.flowId&&loginRank(unifiedLoginState.status)>loginRank(flow.status))return;
    unifiedLoginState=flow;
    const pending=loginReturn;
    if(pending&&flow.source==='lobby'&&flow.flowId===pending.flowId){
      if(loginTerminal(flow.status)){pending.terminal=flow;restoreLoginLobby();}
      else if(flow.status==='community'&&!pending.relayStarted){
        pending.relayStarted=true;pending.navigating=true;
        const detail={login:false,source:'lobby',isCurrent:()=>!disposed&&loginReturn===pending};
        doc.dispatchEvent(new doc.defaultView.CustomEvent('neko-account-open-community',{detail}));
        Promise.resolve(detail.handled?detail.promise:Promise.reject(Error('登录页面暂不可用'))).catch(()=>{if(!disposed){error='N.E.K.O. 登录页面未能打开，请重试';void bridge.nekoSignInCancel?.();}}).finally(()=>{pending.navigating=false;restoreLoginLobby();});
      }
    }
    render();
  }
  async function beginSignIn(){
    if(disposed||localSigningIn||loginCancelPending||unifiedBusy())return;
    const epoch=++loginEpoch,isCurrent=()=>!disposed&&epoch===loginEpoch;localSigningIn=true;unifiedAttempt=false;error='';render();
    try{
      if(typeof bridge.nekoSignIn==='function'){
        unifiedAttempt=true;const result=await bridge.nekoSignIn({source:'lobby'});if(!isCurrent())return;if(result?.ok===false)throw Error(result.error||'N.E.K.O. 登录未能完成，请重试。');
        const flow=result?.state;
        if(flow?.source==='lobby'&&Number.isSafeInteger(flow.flowId))loginReturn={flowId:flow.flowId,relayStarted:false,navigating:false,terminal:null};
        observeUnifiedLogin(unifiedLoginState?.flowId===flow?.flowId&&loginRank(unifiedLoginState?.status)>=loginRank(flow?.status)?unifiedLoginState:flow);
        await call({action:'state'});
      }else await call({action:'sign-in'});
      if(isCurrent()&&open&&connected())join();
    }catch(failure){if(isCurrent()){error=failure?.message||'N.E.K.O. 登录未能完成，请重试。';render();}}
    finally{if(isCurrent()){localSigningIn=false;unifiedAttempt=false;render();}}
  }
  async function cancelSignIn(){
    if(disposed||loginCancelPending)return;const cancelUnified=(unifiedAttempt||!localSigningIn&&typeof bridge.nekoSignIn==='function')&&typeof bridge.nekoSignInCancel==='function';++loginEpoch;localSigningIn=false;loginCancelPending=true;render();
    try{if(cancelUnified){const result=await bridge.nekoSignInCancel();if(result?.ok===false)throw Error('cancel failed');observeUnifiedLogin(result?.state);}else await call({action:'sign-in-cancel'});}
    catch{if(!disposed)error='授权暂未取消，请重试或关闭授权窗口。';}
    finally{unifiedAttempt=false;loginCancelPending=false;if(!disposed)render();}
  }
  function show({connect=true}={}) { if(disposed)return;if(open){if(connect&&pauseJoin){pauseJoin=false;join();}return;}pauseJoin=!connect;onOpen?.(); open = true; panel.hidden = false; railButton.setAttribute('aria-expanded', 'true'); render(); log.scrollTop = log.scrollHeight; join(); onChange?.(); input.focus?.(); }
  function hide() { if (!open) return; open = false; browsingHistory = false; closeMessageMenu(); panel.hidden = true; panel.removeAttribute('data-members-open'); membersToggle.setAttribute('aria-expanded', 'false'); railButton.setAttribute('aria-expanded', 'false'); closePicker(); if (joined) { joined = false; call({ action: 'close' }); } onChange?.(); }
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
    if (author) {
      const name = authorName(author);
      return origin === 'human_ai' ? name + '与' + (author.assist_cat?.name || '猫猫') : name;
    }
    return typeof label === 'string' && label ? label.replace(/^(?:AI 独立发言|人＋AI 共同回复)\s*·\s*/, '') : '成员';
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
    body.appendChild(meta);
    const bubble = el('div', 'neko-lobby-bubble');
    if (Number.isFinite(m.created_at)) bubble.title = new Date(m.created_at).toLocaleString('zh-CN', { hour12: false });
    if (m.reply_to) {
      const quote = el('blockquote', 'neko-lobby-quote'), source = findMessage(m.reply_to.id);
      quote.dataset.origin = m.reply_to.origin || 'human';
      quote.append(el('span', 'neko-lobby-quote__label', '回复 ' + quoteLabel(m.reply_to)));
      if (source) quote.appendChild(source.deleted ? el('span', 'neko-lobby-deleted', '消息已删除') : richText(Array.from(source.text || '').slice(0, 80).join(''), 'neko-lobby-quote__text'));
      bubble.appendChild(quote);
    }
    bubble.appendChild(m.deleted ? el('p', 'neko-lobby-deleted', '消息已删除') : richText(m.text, 'neko-lobby-text'));
    body.appendChild(bubble);
    const pic = avatarNode(m.author);
    if (m.deleted) row.append(pic, body);
    else {
      const anchor = button('', 'neko-lobby-message-avatar', () => openMessageMenu(m.id, anchor));
      anchor.setAttribute('aria-label', authorName(m.author) + '的消息操作');
      anchor.setAttribute('aria-controls', messageMenu.id);
      anchor.setAttribute('aria-expanded', 'false');
      anchor.appendChild(pic);
      anchor.addEventListener('contextmenu', event => { event.preventDefault(); openMessageMenu(m.id, anchor); });
      anchor.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault(); openMessageMenu(m.id, anchor);
      });
      const invite = /^来一起玩「[^\r\n]{1,80}」：(https:\/\/[a-z0-9-]+\.trycloudflare\.com\/\?room=[A-Za-z0-9_-]{24})$/.exec(m.text || '');
      if (invite && typeof bridge.gameHub === 'function') body.appendChild(button('在工作台加入', 'neko-lobby-game-join', () => openDialog('game-room', invite[1])));
      row.append(anchor, body);
    }
    return row;
  }
  function outboxRow(entry) {
    const row = el('article', 'neko-lobby-message neko-lobby-message--outbox'); row.dataset.outbox = entry.status; row.dataset.mine = 'true'; row.dataset.origin = entry.origin || 'human';
    const body = el('div', 'neko-lobby-message__body'), meta = el('div', 'neko-lobby-message__meta');
    meta.appendChild(el('span', 'neko-lobby-label', entry.origin === 'human_ai' ? '我与' + (snap?.me?.cat?.name || '猫猫') : '我'));
    if (entry.origin === 'human_ai') meta.appendChild(el('span', 'neko-lobby-badge neko-lobby-badge--assist', '人＋AI 🐾'));
    const bubble = el('div', 'neko-lobby-bubble'); bubble.appendChild(richText(entry.text, 'neko-lobby-text'));
    body.append(meta, bubble);
    const state = el('div', 'neko-lobby-actions');
    if (entry.status === 'failed') {
      state.append(el('span', 'neko-lobby-failed', entry.error || '发送失败'),
        button('重试', 'neko-lobby-retry', () => call({ action: 'send-retry', clientMessageId: entry.clientMessageId })),
        button('放弃', 'neko-lobby-discard', () => call({ action: 'send-discard', clientMessageId: entry.clientMessageId })));
    } else state.appendChild(el('span', 'neko-lobby-pending', '发送中…'));
    bubble.appendChild(state); row.append(avatarNode({ kind: 'human', avatar: snap?.me?.avatar }), body);
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
    insertMention(item, picker.start, picker.end);
  }
  function insertMention(item, start, end) {
    const prefix = start > 0 && !/\s/.test(input.value[start - 1]) ? ' ' : '';
    const text = prefix + '@' + item.name + ' ', value = input.value.slice(0, start) + text + input.value.slice(end);
    closePicker();
    if (Array.from(value).length > MAX_TEXT) return;
    input.value = value; const caret = start + text.length; input.setSelectionRange?.(caret, caret);
    if (!picked.some(p => p.kind === item.kind && p.id === item.id)) picked.push(item);
    if (C) { draft = C.edit(draft, input.value); renderDraft(); }
    renderCounter();
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
    const b = confirmButton('删除消息', '确认删除', 'neko-lobby-delete', () => { closeMessageMenu(true); void call({ action: 'admin-delete', messageId: m.id }); });
    if (!own) b.dataset.admin = '';
    b.setAttribute('aria-label', '删除这条消息');
    return b;
  }
  function closeMessageMenu(restoreFocus = false) {
    const anchor = messageMenuAnchor;
    if (!anchor) return;
    messageMenuAnchor = null;
    messageMenu.hidden = true;
    messageMenu.replaceChildren();
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }
  function openMessageMenu(id, anchor) {
    const wasOpen = messageMenuAnchor === anchor;
    closeMessageMenu();
    const m = findMessage(id);
    if (wasOpen || !m || m.deleted || connection() !== 'online') return;
    if (!input.disabled) {
      messageMenu.appendChild(button('回复', 'neko-lobby-reply-to', () => { closeMessageMenu(); setReply(id); }));
      const cat = m.author?.kind === 'cat', memberId = cat ? m.author.cat_id : m.author?.user_id;
      const member = memberId && (snap?.members || []).find(person => cat ? person.cat_id === memberId : person.kind === 'human' && person.user_id === memberId);
      if (member && (cat || !ownHuman(member))) {
        messageMenu.appendChild(button('@ 提及', 'neko-lobby-mention-to', () => {
          closeMessageMenu();
          insertMention({ kind: cat ? 'c' : 'u', id: memberId, name: authorName(member) }, input.selectionStart, input.selectionEnd);
          input.focus();
        }));
      }
      if (assistOn() && !ownHuman(m.author) && !ownCat(m.author)) {
        messageMenu.appendChild(button('请她帮我回', 'neko-lobby-assist-this', () => { closeMessageMenu(); requestAssist(id); }));
      }
    }
    const remove = deleteButton(m);
    if (remove) messageMenu.appendChild(remove);
    if (!messageMenu.childElementCount) return;
    messageMenuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    messageMenu.hidden = false;
    const bounds = panel.getBoundingClientRect(), at = anchor.getBoundingClientRect();
    const left = ownHuman(m.author) ? at.right - messageMenu.offsetWidth : at.left;
    const top = at.bottom + messageMenu.offsetHeight + 10 <= bounds.bottom ? at.bottom + 4 : at.top - messageMenu.offsetHeight - 4;
    messageMenu.style.left = Math.max(6, Math.min(left - bounds.left, panel.clientWidth - messageMenu.offsetWidth - 6)) + 'px';
    messageMenu.style.top = Math.max(6, top - bounds.top) + 'px';
    messageMenu.firstElementChild.focus({ preventScroll: true });
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
    members.hidden = connection() !== 'online'; membersToggle.hidden = members.hidden; if (key === membersKey) return; membersKey = key;
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
  function closeDialog() { if (!dialog) return; const from = dialog.from; dialog.cleanup?.(); dialog.node.remove(); dialog = null; from?.focus?.(); onChange?.(); }
  function openDialog(kind, inviteUrl) {
    closeMessageMenu();
    closeDialog();
    if (kind === 'admin' && !isAdmin()) return;
    const node = el('div', 'neko-lobby-dialog'), box = el('form', 'neko-lobby-dialog__card');
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.dataset.dialog = kind;
    if (kind === 'admin') node.dataset.admin = '';
    const game = kind === 'game' || kind === 'game-room';
    const heading = el('h2', 'neko-lobby-dialog__title', kind === 'cat' ? '猫猫设置' : kind === 'game' ? '分享游戏' : kind === 'game-room' ? '秘密规则棋局' : '频道管理'); heading.id = 'neko-lobby-dialog-title'; node.setAttribute('aria-labelledby', heading.id);
    const status = el('p', 'neko-lobby-dialog__error'); status.setAttribute('role', 'status'); status.hidden = true;
    const save = el('button', 'neko-lobby-dialog-save', '保存'); save.type = 'submit';
    if (game) save.textContent = '发送到聊天室';
    const footer = el('div', 'neko-lobby-dialog__footer'); footer.append(button(kind === 'game-room' ? '关闭棋局窗口' : '取消', 'neko-lobby-dialog-cancel', () => closeDialog()), save);
    const build = kind === 'cat' ? catFields() : kind === 'game' ? gameFields() : kind === 'game-room' ? gameRoomFields(inviteUrl) : adminFields();
    box.append(heading, ...build.nodes, status, footer); node.appendChild(box);
    box.addEventListener('submit', async event => {
      event.preventDefault();
      // The form belongs to the account that opened it. After a switch it is
      // discarded; it must never be saved through another account's session.
      if (!dialog || dialog.node !== node || dialog.owner !== meId()) { closeDialog(); return; }
      const request = build.request();
      if (typeof request === 'string') { status.textContent = request; status.hidden = false; return; }
      if (!request) { closeDialog(); return; }
      save.disabled = true;
      let result;
      if (game) {
        try { result = await bridge.gameHub(request); } catch { result = {ok:false,error:'游戏链接无法分享，请检查链接及频道连接'}; }
      } else result = await call(request);
      if (!dialog || dialog.node !== node) return;
      save.disabled = false;
      if (result?.ok === false || (game && result?.ok !== true)) { status.textContent = result?.error || (game ? '没有收到发送确认，请检查聊天室' : '保存失败'); status.hidden = false; return; }
      if (kind === 'game-room') { status.textContent='邀请已发送到聊天室。'; status.hidden=false; }
      else closeDialog();
    });
    node.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); } });
    node.addEventListener('mousedown', event => { if (event.target === node) closeDialog(); });
    dialog = { kind, node, from: doc.activeElement, owner: meId(), cleanup:build.cleanup };
    panel.appendChild(node); (box.querySelector('input,textarea,button:not(:disabled)'))?.focus?.(); onChange?.();
    build.open?.();
  }
  async function callGame(request) {
    try { return await bridge.gameHub(request); }
    catch { return {ok:false,error:'游戏服务暂不可用，请检查 DeepSeek 登录和服务器连接。'}; }
  }
  function gameRoomFields(inviteUrl) {
    const win=doc.defaultView;
    const state=el('p','neko-lobby-game-status','正在核对邀请并加入棋局…');state.setAttribute('role','status');
    const feedback=el('p','neko-lobby-game-status');feedback.setAttribute('role','status');
    const controls=el('section','neko-lobby-game-room-controls');controls.hidden=true;
    const rule=el('input','neko-lobby-game-own-rule');rule.type='password';rule.autocomplete='off';rule.maxLength=80;
    const seatRequest=(action,extra)=>callGame({action,inviteUrl,...extra});
    let view=null,timer=null,closed=false,refreshing=false,submitting=false,playing=false;
    const board=el('iframe','neko-lobby-game-board');board.title='国际象棋棋盘';board.setAttribute('sandbox','allow-scripts');board.hidden=true;
    const publish=()=>{if(view)board.contentWindow?.postMessage({type:'nekofans:state',seat:view.seat,actions:view.actions,ready:view.ready&&view.agent?.status!=='running'},'*');};
    const submitRule=button('提交本方秘密规则','neko-lobby-game-submit-rule',async()=>{
      if(submitting||submitRule.disabled)return;
      submitting=true;submitRule.disabled=true;
      try{
        const result=await seatRequest('private-submit-own-rule',{text:rule.value});
        if(closed)return;
        if(result.status==='ready')rule.value='';
        feedback.textContent=({ready:'本方规则已就绪。',unsupported:'暂不支持这条规则。',invalid:'请填写有效规则。','waiting-for-player':'等朋友入座后再提交。','reconciliation-required':'规则提交结果需要核对。','submission-unknown':'规则提交结果未知，请勿重复提交。'})[result.status]||result.error||'规则暂未提交。';
      }finally{submitting=false;void refresh();}
    });
    const start=button('让本方队友接手','neko-lobby-game-agent-start',async()=>{
      if(start.disabled)return;start.disabled=true;
      const result=await seatRequest('private-agent-start');
      if(closed)return;
      feedback.textContent=({started:'本方队友已启动。','account-unavailable':'请先登录自己的 DeepSeek 账号。','own-agent-unavailable':'请先配置本机主伙伴。','own-rule-unavailable':'请在自己的工作台提交本方规则。','reconciliation-required':'上次走子结果不明，请先核对棋局。',busy:'队友或手动走子正在运行。'})[result.status]||result.error||'队友暂时无法启动。';
      void refresh();
    });
    const stop=button('接回手动操作','neko-lobby-game-agent-stop',async()=>{
      await seatRequest('private-agent-stop');
      if(closed)return;feedback.textContent='已请求停止队友，正在核对棋局。';void refresh();
    });
    controls.append(field('本方秘密规则',rule,'双方各一条，规则效果会在棋局中体现。'),submitRule,start,stop,el('p','neko-lobby-field__hint','启动队友会使用自己的 DeepSeek 额度。关闭窗口后，队友会继续行动。'));
    async function refresh(){
      if(closed||refreshing)return;
      refreshing=true;clearTimeout(timer);
      try{
        const next=await seatRequest('private-seat-view');
        if(closed)return;
        if(next.status!=='ready'){state.textContent='暂时无法同步棋局。';if(view){view={...view,ready:false};publish();}submitRule.disabled=true;start.disabled=true;return;}
        view=next;
        const agentRunning=view.agent?.status==='running';
        const roomText=view.players<2?'等待朋友加入':view.decisionRequired?'等待双方商定如何继续':view.ready?'棋局已就绪':!view.executorOnline?'女神暂未连接':'等待双方提交规则';
        const agentText=({running:'队友行动中','model-timeout':'队友推理超时','model-unavailable':'队友模型暂不可用','submission-unknown':'队友走子结果待核对',rejected:'队友的走法未通过校验',conflict:'队友已停，棋局有更新','invalid-action':'队友未给出合法走法'})[view.agent?.status];
        state.textContent=(view.seat===0?'白方':'黑方')+' · '+roomText+(agentText?' · '+agentText:'');
        rule.disabled=submitting||view.ownRuleStatus!=='empty'||view.players<2;
        submitRule.disabled=rule.disabled;
        start.disabled=agentRunning||view.ownRuleStatus!=='ready';
        stop.disabled=!agentRunning;
        publish();
      }finally{refreshing=false;if(!closed)timer=setTimeout(refresh,3000);}
    }
    async function fromBoard(event){
      if(closed||event.source!==board.contentWindow||event.origin!=='null'||!event.data)return;
      if(event.data.type==='nekofans:ready'){publish();return;}
      const move=event.data.action;
      if(event.data.type!=='nekofans:action'||playing||!view?.ready||typeof move!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))return;
      if(event.data.expectedVersion!==view.actions.length){publish();return;}
      playing=true;
      try{
        const result=await seatRequest('private-seat-move',{move,expectedVersion:view.actions.length});
        if(closed)return;
        feedback.textContent=({applied:'',rejected:'这一步暂时不可用。',conflict:'棋局已变化，已请求同步。',busy:'队友或另一手正在行动。','submission-unknown':'走子结果未知，请先核对棋局。','reconciliation-required':'请先核对上一次走子。'})[result.status]??'走子未确认。';
        await refresh();
      }finally{playing=false;}
    }
    async function open(){
      const result=await seatRequest('private-open-seat');
      if(closed)return;
      if(result.status!=='paired'){
        state.textContent=({'invalid-invite':'这不是受支持的棋局邀请。','room-not-found':'房间不存在或已过期。','room-full':'房间已满。若你已在浏览器入座，请用原来的配对码关联。','join-unknown':'入座结果暂时无法确认，请先向房主核对。',busy:'另一个入座请求正在处理。','seat-limit':'本次工作台会话的棋局数已达上限。'})[result.status]||result.error||'暂时无法加入。';return;
      }
      controls.hidden=false;
      const content=await seatRequest('private-seat-board');
      if(closed)return;
      if(content.status==='ready'&&typeof content.html==='string'){
        win.addEventListener('message',fromBoard);
        board.srcdoc="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:\">"+content.html;
        board.hidden=false;
      }else feedback.textContent='棋盘资源暂不可用。';
      await refresh();
    }
    return {nodes:[state,controls,feedback,board],open,cleanup(){closed=true;clearTimeout(timer);win.removeEventListener('message',fromBoard);},
      request:()=>view?{action:'share',title:'双人国际象棋',roomUrl:inviteUrl}:'请先确认已加入棋局。'};
  }
  function gameFields() {
    const title = el('input', 'neko-lobby-game-title'); title.maxLength = 80; title.setAttribute('aria-label', '游戏名称'); title.placeholder = '例如：双人国际象棋';
    const url = el('input', 'neko-lobby-game-url'); url.type = 'url'; url.setAttribute('aria-label', '游戏邀请链接'); url.placeholder = 'https://…/?room=…';
    const server = el('input','neko-lobby-game-server'); server.type='url'; server.setAttribute('aria-label','游戏服务器'); server.placeholder='https://…trycloudflare.com';
    const roleNote=el('p','neko-lobby-game-role-note','你和本机主伙伴（如大肥鱼）组成对局队伍。女神负责创作游戏和处理规则；双方通过各自入口参与同一局游戏。');
    const goddessHeading=el('h3','neko-lobby-game-goddess-heading','女神 · 游戏创作与规则处理');
    const teammateHeading=el('h3','neko-lobby-game-teammate-heading','我与决策队友 · 参与对局');
    const gameState=el('p','neko-lobby-game-status','先连接女神的规则处理服务。连接使用你的 DeepSeek 工作台账号额度。');gameState.setAttribute('role','status');
    const publicKey=el('textarea','neko-lobby-game-public-key');publicKey.readOnly=true;publicKey.rows=3;publicKey.hidden=true;publicKey.setAttribute('aria-label','游戏配对公钥');
    const pairing=button('显示配对公钥','neko-lobby-game-pair',async()=>{const result=await callGame({action:'private-public-key'});if(result.ok){publicKey.value=result.publicKey;publicKey.hidden=false;gameState.textContent='将公钥配置到你的游戏服务器；私钥只保存在本机加密存储中。';}else gameState.textContent=result.error||'无法获取配对公钥';});
    const connect=button('连接女神的规则服务','neko-lobby-game-connect',async()=>{connect.disabled=true;try{const result=await callGame({action:'private-start',url:server.value.trim().replace(/\/$/,'')});gameState.textContent=result.connected?'女神的规则处理服务已连接。':'暂时未连接，请检查服务器配对。';}finally{connect.disabled=false;}});
    const create=button('创建秘密规则棋局','neko-lobby-game-create',async()=>{create.disabled=true;try{const result=await callGame({action:'private-create',url:server.value.trim().replace(/\/$/,'')});if(!create.isConnected)return;if(result.ok){openDialog('game-room',result.inviteUrl);}else gameState.textContent=result.error||'创建失败，请检查连接。';}finally{create.disabled=false;}});
    const openRoom=button('在工作台打开棋局','neko-lobby-game-open-room',()=>openDialog('game-room',url.value.trim()));
    const pairCode=el('input','neko-lobby-game-seat-code');pairCode.setAttribute('aria-label','自己的席位配对码');pairCode.autocomplete='off';pairCode.maxLength=24;
    const pairSeat=button('关联我的席位','neko-lobby-game-seat-pair',async()=>{let invite;try{invite=new URL(url.value.trim());if(invite.hash||invite.pathname!=='/'||!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(invite.origin)||!/^[A-Za-z0-9_-]{24}$/.test(invite.searchParams.get('room')||''))throw Error();}catch{gameState.textContent='请先填写自己的游戏邀请链接。';return;}pairSeat.disabled=true;try{const result=await callGame({action:'private-pair-seat',url:invite.origin,roomId:invite.searchParams.get('room'),code:pairCode.value.trim()});if(result.status==='paired'){pairCode.value='';gameState.textContent='已关联自己的'+(result.seat===0?'白方':'黑方')+'席位；决策队友尚未开始行动。';}else gameState.textContent=result.error||'配对失败，请重新生成配对码。';}finally{pairSeat.disabled=false;}});
    const ownRule=el('input','neko-lobby-game-own-rule');ownRule.type='password';ownRule.autocomplete='off';ownRule.maxLength=80;ownRule.setAttribute('aria-label','本方秘密规则');
    const submitRule=button('私密提交本方规则','neko-lobby-game-submit-rule',async()=>{submitRule.disabled=true;try{const result=await callGame({action:'private-submit-own-rule',text:ownRule.value});if(result.status==='ready'){ownRule.value='';gameState.textContent='规则已确认，本方决策队友可以读取自己的规则。';}else gameState.textContent=({unsupported:'暂不支持该规则，请换一种写法。',invalid:'请填写有效规则。',busy:'正在处理规则。',unavailable:'DeepSeek 暂时不可用。','not-paired':'请先关联自己的席位。','already-submitted':'这方已经提交规则。','submission-unknown':'提交结果不确定，请勿重复提交。','reconciliation-required':'规则状态需要核对，请勿重复提交。'})[result.status]||result.error||'提交未完成，请检查状态。';}finally{submitRule.disabled=false;}});
    const startAgent=button('让决策队友参与','neko-lobby-game-agent-start',async()=>{const result=await callGame({action:'private-agent-start'});gameState.textContent=({started:'已启动本方决策队友，最多走 100 步、运行 1 小时；会消耗自己的 DeepSeek 额度。',busy:'本方决策队友已在运行。','not-paired':'请先关联自己的席位。','own-rule-unavailable':'请先在自己的工作台提交本方规则。','account-unavailable':'请先登录自己的 DeepSeek 账号。','own-agent-unavailable':'请先配置本机主伙伴作为决策队友。','reconciliation-required':'上次走子结果不确定，请先核对棋局。'})[result.status]||result.error||'决策队友暂时无法启动。';});
    const agentStatus=button('查看决策队友状态','neko-lobby-game-agent-status',async()=>{const result=await callGame({action:'private-agent-status'});const statuses={running:'运行中',finished:'棋局结束','move-limit':'达到走子上限','wait-limit':'等待对手超时',cancelled:'已停止','room-unavailable':'读取棋局失败','room-timeout':'读取棋局超时','model-unavailable':'DeepSeek 请求失败','model-timeout':'DeepSeek 请求超时','submission-unknown':'提交结果不确定，请先核对棋局','invalid-action':'模型未返回合法走法',rejected:'走法被服务器拒绝',conflict:'棋局已更新，请核对后重新启动'};gameState.textContent='本方决策队友状态：'+(statuses[result.status]||result.status||'未知')+'，已走 '+(result.moves||0)+' 步。';});
    const stopAgent=button('停止决策队友','neko-lobby-game-agent-stop',async()=>{await callGame({action:'private-agent-stop'});gameState.textContent='已请求停止本方决策队友。';});
    // 本地棋局原型 · 真实账号模型桥: the renderer receives only the ephemeral
    // start command and plain status text; never persona or rule bodies.
    const relayHeading=el('h3','neko-lobby-game-prototype-heading','本地棋局原型 · 真实账号模型桥');
    const relayState=el('p','neko-lobby-game-status','一键启动会打开已绑定模型桥的本机剧情棋局。');relayState.setAttribute('role','status');
    const relayRoom=el('input','neko-lobby-game-prototype-room');relayRoom.maxLength=10;relayRoom.setAttribute('aria-label','本地原型房间码');relayRoom.placeholder='8 位房间码或 r-xxxxxxxx';relayRoom.autocomplete='off';
    const relayOrigin=el('input','neko-lobby-game-prototype-origin');relayOrigin.type='url';relayOrigin.setAttribute('aria-label','本地原型地址');relayOrigin.value='http://127.0.0.1:8787';
    const relayCommand=el('textarea','neko-lobby-game-prototype-command');relayCommand.readOnly=true;relayCommand.rows=3;relayCommand.hidden=true;relayCommand.setAttribute('aria-label','本地原型启动命令');
    const relayWarning=el('p','neko-lobby-game-prototype-warning','命令含一次性桥接令牌，只在本次启动有效；不要发给别人或投屏。');relayWarning.hidden=true;
    const loopbackOrigin=value=>{let parsed;try{parsed=new URL(value);}catch{return null;}if((parsed.protocol!=='http:'&&parsed.protocol!=='https:')||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/')return null;return ['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)?parsed.origin:null;};
    const relayStart=button('启动受控适配器','neko-lobby-game-prototype-start',async()=>{relayStart.disabled=true;try{const result=await callGame({action:'prototype-relay-start'});if(result.ok&&result.baseUrl&&result.token&&result.model&&result.label){relayCommand.value='NEKO_AI_BRIDGE_URL='+result.baseUrl+' NEKO_AI_BRIDGE_TOKEN='+result.token+' NEKO_AI_MODEL='+result.model+' NEKO_AI_BRIDGE_LABEL="'+String(result.label).replace(/"/gu,'')+'" npm start';relayCommand.hidden=false;relayWarning.hidden=false;relayState.textContent='适配器已启动（限时有效，最多 '+(Number.isFinite(result.maxCalls)?result.maxCalls:0)+' 次调用）。把命令粘贴到本地原型终端，创建房间后填写房间码并绑定。';}else if(result.ok&&result.status==='running'){relayState.textContent='适配器已在运行；如需新的启动命令，请先停止再启动。';}else relayState.textContent='适配器暂时无法启动，请检查 DeepSeek 登录后重试。';}finally{relayStart.disabled=false;}});
    const storyStart=button('一键启动剧情对局','neko-lobby-game-story-start',async()=>{
      storyStart.disabled=true;relayState.textContent='正在启动、建房并绑定模型桥…';
      try{
        const result=await callGame({action:'prototype-story-start'});
        relayState.textContent=({opened:'已打开并绑定本机剧情棋局。',busy:'正在打开剧情棋局，请稍候。','already-bound':'适配器已绑定其他房间。可以继续原房间，或停止后另开一局。','missing-project':'请先设置 NEKO_STORY_PROJECT_DIR，指向含有 server.js 的剧情工程。','bridge-unavailable':'模型适配器未就绪，请检查 DeepSeek 登录。','room-unavailable':'暂时无法打开本机剧情棋局。',timeout:'本机剧情服务启动超时。'})[result.status]||'剧情棋局未打开。';
      }finally{storyStart.disabled=false;}
    });
    const relayBind=button('绑定原型房间','neko-lobby-game-prototype-bind',async()=>{const roomId=relayRoom.value.trim().toUpperCase(),origin=loopbackOrigin(relayOrigin.value.trim());if(!/^(?:[A-HJ-NP-Z2-9]{8}|R-[0-9A-F]{8})$/.test(roomId)){relayState.textContent='请输入原型房间码或剧情房间 r-xxxxxxxx。';return;}if(!origin){relayState.textContent='原型地址只允许本机回环地址。';return;}relayBind.disabled=true;try{const result=await callGame({action:'prototype-relay-bind',roomId,prototypeOrigin:origin});relayState.textContent=({bound:'已绑定房间 '+(result.roomId||roomId)+'。女神可读取双方规则，决策队友只读取本方规则。','room-not-found':'原型里找不到这个房间，请先在原型里创建房间。','prototype-unavailable':'无法连接本地原型，请确认已用上面的命令启动。','invalid-room':'请输入原型房间码或剧情房间 r-xxxxxxxx。','invalid-origin':'原型地址只允许本机回环地址。','account-unavailable':'请先登录 DeepSeek 工作台账号。','already-bound':'适配器已经绑定房间。',busy:'正在核对原型房间，请稍候。',locked:'已经发生过模型调用，不能改绑房间；请停止后重新启动。','not-running':'适配器未运行或已过期，请重新启动。',expired:'适配器未运行或已过期，请重新启动。'})[result.status]||'绑定未完成，请检查原型和适配器状态。';}finally{relayBind.disabled=false;}});
    const relayStatus=button('查看适配器状态','neko-lobby-game-prototype-status',async()=>{const result=await callGame({action:'prototype-relay-status'});if(result.ok===false){relayState.textContent='暂时无法读取适配器状态，请稍后重试。';return;}relayState.textContent='适配器：'+(result.status==='running'?'运行中':'未运行')+'，已绑定房间 '+(result.roomId||'-')+'，已调用 '+(Number.isFinite(result.calls)?result.calls:0)+'/'+(Number.isFinite(result.maxCalls)?result.maxCalls:0)+' 次。';});
    const relayStop=button('停止适配器','neko-lobby-game-prototype-stop',async()=>{let result;try{result=await callGame({action:'prototype-relay-stop'});}catch{result={ok:false};}if(result&&result.ok===false){relayState.textContent='停止未确认，请检查适配器状态或稍后重试。';return;}relayCommand.value='';relayCommand.hidden=true;relayWarning.hidden=true;relayState.textContent='已停止；启动命令立即失效。';});
    const prompt=el('textarea','neko-lobby-game-prompt');prompt.rows=2;prompt.maxLength=2000;prompt.setAttribute('aria-label','游戏制作要求');prompt.placeholder='告诉女神想创建或怎样修改游戏';let revisionId;
    const draft=button('让女神生成或修改草稿','neko-lobby-game-draft',async()=>{draft.disabled=true;gameState.textContent='女神正在制作游戏草稿…';try{const result=await callGame({action:'draft-game',prompt:prompt.value,revisionId});if(result.status==='draft'){revisionId=result.revisionId;gameState.textContent='草稿已生成，可继续输入修改要求。草稿尚未通过隔离验证，暂不能发布。';}else gameState.textContent='草稿生成失败或内容过长，请检查账号后重试。';}finally{draft.disabled=false;}});
    const advanced=el('details','neko-lobby-game-advanced');
    advanced.append(el('summary','','高级设置与旧版配对'),pairing,publicKey,connect,field('自己的席位配对码',pairCode,'已在浏览器入座时使用。'),pairSeat,field('本方秘密规则',ownRule,'请在此提交，本机队友才能读取。'),submitRule,startAgent,agentStatus,stopAgent,field('本地原型房间码',relayRoom),field('本地原型地址',relayOrigin),relayStart,relayBind,relayStatus,relayCommand,relayWarning);
    return { nodes: [roleNote,goddessHeading,field('游戏服务器',server),create,gameState,field('制作游戏',prompt),draft,teammateHeading,field('游戏名称',title),field('游戏邀请链接',url,'只填写公开邀请链接。'),openRoom,relayHeading,relayState,storyStart,relayStop,advanced], request() {
      if (!title.value.trim() || !url.value.trim()) return '请填写游戏名称和邀请链接';
      return {action:'share',title:title.value.trim(),roomUrl:url.value.trim()};
    } };
  }
  function catFields() {
    const settings = snap?.catSettings || {}, part = snap?.participation || {}, own = snap?.me?.cat;
    const myName = snap?.me?.display_name || snap?.me?.name || '我';
    const startName = settings.name || own?.name || '大肥鱼', savedAvatar = settings.avatarKey && settings.avatarKey !== 'default' ? settings.avatarKey : own?.avatar_key || 'bigfish', startAvatar=savedAvatar==='claude'?'bigfish':savedAvatar; let avatarChanged=false;
    const startMode = settings.mode || part.mode || 'assist';
    // Configuration needs only the main-agent route, not an existing server
    // cat profile: saving is what creates that profile the first time.
    const needsApi = !lineReady();
    const api = el('p', 'neko-lobby-cat-api'); api.dataset.ready = String(!needsApi);
    api.textContent = needsApi ? (part.reason || '主 agent 聊天线路暂不可用') + '。现在只能选「她不参与」，你自己照常聊天，私聊不受影响。' : part.available ? '已连接主 agent 聊天线路' : '已连接主 agent 聊天线路。' + (part.reason ? '她现在还不能参与：' + part.reason + '。' : '') + '选好方式后保存即可。';
    const mode = choiceGroup('参与方式', MODES, needsApi ? 'off' : startMode, value => value !== 'off' && needsApi); mode.classList.add('neko-lobby-cat-mode');
    const name = el('input', 'neko-lobby-cat-name'); name.maxLength = 32; name.value = startName; name.setAttribute('aria-label', '猫娘名字');
    const preview = el('span', 'neko-lobby-cat-preview');
    const sync = () => { const n = name.value.trim() || '大肥鱼'; preview.textContent = '你看到「我的' + n + '」，别人看到「' + myName + '的' + n + '」'; };
    name.addEventListener('input', sync); sync();
    const avatars = el('div', 'neko-lobby-cat-avatars'); avatars.setAttribute('role', 'radiogroup'); avatars.setAttribute('aria-label', '猫娘头像'); avatars.dataset.value = startAvatar;
    const avatarButtons = CAT_AVATARS.map(([id, label]) => {
      const b = button('', 'neko-lobby-cat-avatar', () => { avatarChanged=true;avatars.dataset.value = id; for (const x of avatarButtons) x.setAttribute('aria-checked', String(x === b)); });
      b.dataset.value = id; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', label); b.setAttribute('aria-checked', String(id === startAvatar));
      b.appendChild(image(avatar(id), 'neko-lobby-cat-avatar__img')); return b;
    });
    avatars.append(...avatarButtons);
    const trigger = choiceGroup('她自己说话时什么时候开口', TRIGGERS, settings.independentTrigger || 'mention'); trigger.classList.add('neko-lobby-cat-trigger');
    const note = el('textarea', 'neko-lobby-cat-note'); note.maxLength = 500; note.rows = 3; note.value = settings.note || '';
    note.placeholder = '可选：大厅里所有人都可能读到她按这段说明说的话'; note.setAttribute('aria-label', '频道补充说明');
    const usage = snap?.cat?.usage;
    const cost = el('p', 'neko-lobby-cat-cost', '猫猫回复复用主 agent 的 DeepSeek 账号额度或 API，自由发言会消耗更多额度。' + (usage && Number.isFinite(usage.today) ? '今日已用 ' + usage.today + ' / ' + usage.limit + ' 次。' : ''));
    const triggerHint = snap?.channel?.cat_free_mode_allowed === false
      ? '此频道限制自由发言。选了自由发言时，她会在你发言或她被 @ 时开口。' : '';
    const nodes = [api, field('参与方式', mode), field('名字', name, ''), preview, field('头像', avatars), field('她自己说话时', trigger, triggerHint), field('频道补充说明（公开）', note, '最多 500 字。别写私事，这段会影响她在公共频道里的发言。'), cost];
    function request() {
      const out = { action: 'cat-save' }, n = name.value.trim();
      if (!n || Array.from(n).length > 32) return '猫娘名字 1–32 字';
      if (n !== startName) out.name = n;
      if (avatarChanged && avatars.dataset.value !== savedAvatar) out.avatarKey = avatars.dataset.value;
      if (!needsApi && mode.dataset.value !== startMode) out.mode = mode.dataset.value;   // without a provider only 她不参与 is possible; keep the saved choice
      if (trigger.dataset.value !== (settings.independentTrigger || 'mention')) out.independentTrigger = trigger.dataset.value;
      if (note.value !== (settings.note || '')) out.note = note.value;
      // An unchanged save is still meaningful once the route is ready: the
      // host idempotently creates the first server profile (initially disabled).
      return Object.keys(out).length > 1 || !needsApi ? out : null;
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
    // Choices unlock with the route; whether she actually takes part is still
    // part.available (a missing profile is created by choosing a mode).
    const ready = lineReady(), current = ready ? part.mode || 'off' : 'off';
    for (const b of modeButtons) { b.setAttribute('aria-pressed', String(b.dataset.mode === current)); b.disabled = b.dataset.mode !== 'off' && !ready; }
    reason.textContent = part.available ? '' : part.reason || ''; reason.hidden = !reason.textContent;
  }
  let identityKey = '';
  function timeGroup(timestamp) {
    const date = new Date(timestamp), today = new Date(), yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    let day = '';
    if (date.toDateString() === yesterday.toDateString()) day = '昨天 ';
    else if (date.toDateString() !== today.toDateString()) {
      day = (date.getFullYear() !== today.getFullYear() ? date.getFullYear() + '年' : '') + (date.getMonth() + 1) + '月' + date.getDate() + '日 ';
    }
    return day + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  function renderLog() {
    const key = JSON.stringify([meId(), isAdmin(), assistOn(), (snap?.members || []).map(m => [m.kind, m.user_id || m.cat_id, m.name, m.display_name])]);
    if (key !== identityKey) { identityKey = key; rows.clear(); closeMessageMenu(); }
    const messages = snap?.messages || [], outbox = (snap?.outbox || []).filter(e => e.kind === 'human');
    const oldNodes = [...log.children];
    const oldTimes = new Map(oldNodes.filter(node => node.dataset.before).map(node => [node.dataset.before, node]));
    const nodes = [];
    const live = new Set();
    let previous = null;
    for (const m of messages) {
      const rowKey = JSON.stringify(m) + (m.reply_to ? JSON.stringify(findMessage(m.reply_to.id)) : '');
      let cached = rows.get(m.id);
      if (!cached || cached.key !== rowKey) { cached = { key: rowKey, node: messageRow(m) }; rows.set(m.id, cached); }
      const stamp = m.created_at;
      if (Number.isFinite(stamp)) {
        if (previous === null || stamp - previous >= TIME_GAP_MS || new Date(stamp).toDateString() !== new Date(previous).toDateString()) {
          const time = oldTimes.get(m.id) || el('time', 'neko-lobby-time');
          const label = timeGroup(stamp);
          if (time.textContent !== label) time.textContent = label;
          time.dataset.before = m.id;
          time.dateTime = new Date(stamp).toISOString();
          nodes.push(time);
        }
        previous = stamp;
      }
      live.add(m.id); nodes.push(cached.node);
    }
    for (const id of [...rows.keys()]) if (!live.has(id)) rows.delete(id);
    for (const entry of outbox) nodes.push(outboxRow(entry));
    if (!nodes.length) nodes.push(empty);
    if (nodes.length === oldNodes.length && nodes.every((node, index) => node === oldNodes[index])) return;
    const bottom = !browsingHistory && log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const wanted = new Set(nodes), top = log.getBoundingClientRect().top;
    const anchor = !bottom && oldNodes.find(node => node.dataset.id && wanted.has(node) && node.getBoundingClientRect().bottom > top);
    const anchorTop = anchor && anchor.getBoundingClientRect().top;
    for (const node of oldNodes) if (!wanted.has(node)) node.remove();
    let cursor = log.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else log.insertBefore(node, cursor);
    }
    if (bottom) log.scrollTop = log.scrollHeight;
    else if (anchor) log.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    if (messageMenuAnchor && !messageMenuAnchor.isConnected) closeMessageMenu();
  }
  function render() {
    if (disposed) return;
    const conn = connection(), auth = snap?.auth || {}, channel = snap?.channel;
    title.textContent = channel?.name || '频道'; topic.textContent = channel?.topic || ''; topic.hidden = !topic.textContent;
    const humans = (snap?.members || []).filter(m => m.kind === 'human' && m.online).length;
    onlineCount.textContent = conn === 'online' ? humans + ' 人在线' : ''; onlineCount.hidden = !onlineCount.textContent;
    signOut.hidden = conn === 'unconfigured' || conn === 'signed-out';
    gate.hidden = conn === 'online';
    const signingIn=!!auth.signingIn||localSigningIn||loginCancelPending||unifiedBusy();
    gateText.textContent = conn === 'unconfigured' ? (auth.message || '频道服务未配置。') : conn === 'signed-out' ? (signingIn ? (unifiedBusy()&&unifiedLoginState.message|| (typeof bridge.nekoSignIn==='function'?'请完成 N.E.K.O. 官方登录与聊天室授权…':'请在浏览器里完成社区账号授权…')) : auth.message || '登录后即可进入频道。')
      : conn === 'connecting' ? '正在连接频道…' : '频道暂时连不上，私聊不受影响。';
    signIn.hidden = conn !== 'signed-out' || signingIn;signIn.disabled=signingIn;signInCancel.hidden = !(conn === 'signed-out' && signingIn);signInCancel.disabled=loginCancelPending; reconnect.hidden = conn !== 'offline';
    if (conn !== 'online') { browsingHistory = false; closeMessageMenu(); }
    renderHistory();
    renderLog();
    const muted = Number.isFinite(snap?.me?.muted_until) && snap.me.muted_until > Date.now(), banned = !!snap?.me?.banned_at;
    input.disabled = conn !== 'online' || muted || banned; send.disabled = input.disabled || sending;
    input.placeholder = banned ? '你已被频道封禁' : muted ? '你正在禁言中' : conn === 'online' ? '在频道里说点什么… Enter 发送，Shift+Enter 换行，@ 提及成员' : '连接频道后才能发言';
    if (replyToId && !findMessage(replyToId)) setReply(null);
    gameShareButton.hidden = conn !== 'online' || !snap?.me || typeof bridge.gameHub !== 'function';
    notice.textContent = error || snap?.error || ''; notice.hidden = !notice.textContent;
    // An identity change discards any open form drafted for the previous owner.
    if (dialog && dialog.owner !== meId()) closeDialog();
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
  let release = null,releaseNeko=null;
  if (typeof bridge.subscribeLobby === 'function') {
    try { release = bridge.subscribeLobby(next => { if (disposed || !next || typeof next !== 'object') return; snap = next; render(); if (open && !joined) join(); }); } catch { release = null; }
  }
  if(typeof bridge.subscribeNekoAccount==='function'){try{releaseNeko=bridge.subscribeNekoAccount(value=>observeUnifiedLogin(value?.login));}catch{}}
  call({ action: 'state' });
  render();
  function dispose() {
    if (disposed) return;
    ++loginEpoch;
    if (joined) { joined = false; try { Promise.resolve(bridge.lobby({ action: 'close' })).catch(() => {}); } catch {} }
    disposed = true;loginReturn=null; if (typeof release === 'function') release();if(typeof releaseNeko==='function')releaseNeko(); rows.clear(); if (dialog) { dialog.cleanup?.(); dialog.node.remove(); dialog = null; } doc.removeEventListener('pointerdown', dismissMessageMenu); doc.removeEventListener('focusin', dismissMessageMenu); panel.remove(); railButton.remove();
  }
  return { panel, railButton, show, hide, isOpen: () => open, dialogOpen: () => !!dialog, place, renderStatus, dispose };
}
