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
  const communityButton = button('', 'neko-side-rail__button neko-community neko-community-yui', () => { closeStartup(); closeSettings(); Promise.resolve(options.openCommunity?.()).catch(showError); });
  communityButton.setAttribute('aria-label', 'Yui · N.E.K.O. 社区'); communityButton.title = 'N.E.K.O. 原生社区'; communityButton.appendChild(image(avatar('yui')));
  railTop.append(settingsButton, communityButton);
  // The room is a local visual preview. It never touches the work session or
  // the saved multi-pane layout. The original sidebar stays mounted behind it.
  const previewFactory = options.createChatroomPreview || (typeof createChatroomPreview === 'function' ? createChatroomPreview : null);
  const roomPreview = previewFactory ? own(previewFactory(doc, avatar)) : null;
  let roomActive = !!roomPreview, initialRoomResolved = false;
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
  function setRoomActive(active) {
    if (!roomPreview || disposed) return;
    roomActive = !!active;
    if (roomActive) { doc.body.setAttribute('data-neko-chatroom-active', ''); doc.querySelector('.neko-side-rail__expand:not([hidden])')?.click(); }
    else { doc.body.removeAttribute('data-neko-chatroom-active'); roomPreview.hidden = true; releaseRoomInert(); }
    roomButton.setAttribute('aria-pressed', String(roomActive)); workButton.setAttribute('aria-pressed', String(!roomActive));
    doc.dispatchEvent(new win.Event('neko-chatroom-mode-change'));
    schedule();
  }
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
  const startupContinue = button('继续当前工作', 'neko-startup__continue', () => closeStartup());
  startupHead.append(startupHeading, startupContinue);
  const startupSearch = el('input', 'neko-startup__search'); startupSearch.type = 'search'; startupSearch.placeholder = '搜索项目或会话'; startupSearch.setAttribute('aria-label', '搜索项目或会话');
  startupSearch.addEventListener('input', () => { startupSearchText = startupSearch.value.toLowerCase(); renderStartup(); });
  const startupToolbar = el('div', 'neko-startup__toolbar'), startupTitle = el('strong', '', '本地工作项目');
  const startupRefresh = button('刷新', 'neko-startup__refresh', () => refreshCatalog(true));
  startupToolbar.append(startupTitle, startupRefresh);
  const startupStatus = el('p', 'neko-startup__status', '正在读取本地工作会话…'); startupStatus.setAttribute('role', 'status'); startupStatus.setAttribute('aria-live', 'polite');
  const startupProjects = el('div', 'neko-startup__projects');
  startupInner.append(startupHead, startupSearch, startupToolbar, startupStatus, startupProjects); startup.appendChild(startupInner); doc.body.appendChild(startup);
  function closeStartup() { startupOpen = false; startup.hidden = true; }
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
  const chatStatus = el('p', 'neko-companion-status'); chatStatus.hidden = true; chatStatus.setAttribute('role', 'status');
  const form = el('form', 'neko-companion-form'), chatInput = el('textarea'); chatInput.rows = 1; chatInput.placeholder = '说点什么…'; chatInput.maxLength = 8000; chatInput.setAttribute('aria-label', '给主 agent 的消息');
  const chatSend = el('button', '', '↑'); chatSend.type = 'submit'; chatSend.setAttribute('aria-label', '发送给主 agent');
  const historyToggle = button('', 'neko-companion-history-toggle', () => saveLayout({ companionHistoryOpen: !layout?.companionHistoryOpen }));
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
    try { await bridge.companion({ action: 'send', text }); if (chatInput.value === draft) chatInput.value = ''; }
    catch (error) { chatError = error.message || '消息未发送，请重试'; }
    finally { sending = false; renderCompanion(); }
  });
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
    try {
      if (typeof options.openDshNew !== 'function') throw Error('无法打开 DSH 工作界面，请重试');
      await options.openDshNew(seat.projectRoot); closeStartup();
    } catch (error) { showError(error); }
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
        hideSocial();
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
    hideSocial(); closeSettings();
    if (!await saveLayout(sessionPatch(group))) throw Error('无法切换工作界面，请重试');
    if (group.provider === 'dsh') {
      if (typeof options.openDshNew !== 'function') throw Error('无法打开 DSH 工作项目，请重试');
      await options.openDshNew(group.cwd); closeStartup();
    } else if (group.provider === 'codex') { selectedProject = group.cwd; newOffice(); }
    else throw Error('不支持的工作平台');
  }
  async function openSession(row) {
    if (row.provider === 'codex' && codexPaused()) { showError(Error('Codex 测试中，暂不可用')); return false; }
    hideSocial(); closeSettings();
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
  function newOffice() { ++readVersion; hideSocial(); selectedId = null; officeReading = false; officeErrorText = ''; office = { status: 'idle', thread: null, items: [], approvals: office.approvals || [], error: '' }; officeInput.value = drafts.get('new') || ''; officeRenderKey = ''; renderOffice(); closeStartup(); officeInput.focus(); }
  function renderCompanion() {
    const c = state?.companion || {}, open = !!layout?.companionHistoryOpen, wasHidden = history.hidden;
    history.hidden = !open; historyToggle.setAttribute('aria-expanded', String(open)); historyToggle.setAttribute('aria-label', open ? '收起聊天记录' : '展开聊天记录'); historyToggle.title = open ? '收起聊天记录' : '展开聊天记录';
    chatSend.hidden = !!c.working; chatStop.hidden = !c.working; chatSend.disabled = sending; chatSend.title = c.ready ? '发送消息' : '连接聊天设置';
    chatStatus.textContent = chatError || c.error || ''; chatStatus.hidden = !chatStatus.textContent;
    const key = JSON.stringify(c.messages || []);
    if (key !== historyKey) {
      const bottom = history.scrollHeight - history.scrollTop - history.clientHeight < 30; historyKey = key;
      history.replaceChildren(...(c.messages || []).map(m => { const line = el('p', 'neko-companion-message'); line.dataset.role = m.role; line.append(el('strong', '', m.role === 'user' ? '你：' : m.role === 'error' ? '提示：' : '回复：'), doc.createTextNode(m.text)); return line; }));
      if (!history.children.length) history.appendChild(el('p', 'neko-companion-empty', '暂无聊天记录'));
      if (bottom) history.scrollTop = history.scrollHeight;
    }
    if (wasHidden && open) history.scrollTop = history.scrollHeight;
  }
  function renderOffice() {
    if (!layout) return;
    panel.hidden = layout.officeMode !== 'codex' || socialOpen;
    if (!panel.hidden && !codexPaused() && modelsState === 'idle') refreshModels();
    for (const main of doc.querySelectorAll('main')) { if (socialOpen) continue; if (main.closest('[data-neko-workspace-owned]')) continue; if (!panel.hidden) markNative(main, 'inert'); else if (nativeMarks.get(main)?.has('inert')) { const before = nativeMarks.get(main).get('inert'); if (before === null) main.removeAttribute('inert'); else main.setAttribute('inert', before); nativeMarks.get(main).delete('inert'); } }
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
  function closeSettings() { if (modal.hidden) return; modal.hidden = true; settingsButton.focus(); }
  function officeChoices() {
    const choices = el('div', 'neko-office-choices');
    for (const [id, name, pic] of [['dsh', 'DSH', 'bigfish'], ['codex', codexPaused() ? 'Codex · 测试中' : 'Codex', 'devcat'], ['claude', 'Claude · 待接入', 'claude']]) {
      const b = button('', 'neko-office-choice', async () => { hideSocial(); await saveLayout({ officeMode: id }); closeSettings(); });
      b.disabled = id === 'claude' || id === 'codex' && codexPaused(); b.setAttribute('aria-pressed', String(layout?.officeMode === id)); b.append(image(avatar(pic)), el('span', '', name)); choices.appendChild(b);
    }
    return choices;
  }
  function connectionSummary() { const connected = phase => ['ready', 'connected'].includes(phase) ? '已连接' : phase === 'error' ? '连接出错' : '未连接'; return 'N.E.K.O.：' + connected(state?.neko?.connection) + ' · 工作台：' + connected(state?.workbench?.connection); }
  function openSettings(kind = 'general', id) {
    hideSocial(); modalBody.replaceChildren(); modalTitle.textContent = kind === 'seat' ? '自定义工作 agent' : '工作台设置'; modal.setAttribute('aria-label', modalTitle.textContent); modal.hidden = false;
    if (kind !== 'seat') {
      modalBody.append(el('h3', '', '右侧工作界面'), officeChoices());
      if (kind === 'general') {
        modalBody.append(el('h3', '', '头像与配色'));
        const palette = el('div', 'neko-workspace-palettes');
        for (const id of ['yui', 'devcat', 'bigfish', 'claude', 'gemini']) { const b = button('', '', () => bridge.setAvatar(id).catch(showError)); b.setAttribute('aria-label', '配色：' + id); b.appendChild(image(avatar(id))); palette.appendChild(b); }
        modalBody.append(palette, button('主 agent 聊天设置', 'neko-workspace-setting-link', () => { closeSettings(); bridge.action('chat-settings'); }), button('账号、隐私 / 高级设置', 'neko-workspace-setting-link', () => { closeSettings(); options.openNativeSettings?.(); }));
        modalBody.append(el('h3', '', '连接与工作台'));
        const connections = el('p', 'neko-workspace-connections', connectionSummary());
        connections.setAttribute('role', 'status'); modalBody.appendChild(connections);
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
        modalBody.append(actions, actionError, el('p', 'neko-workspace-note', 'DSH 与 Codex 沿用本机登录；主 agent 陪伴聊天单独连接。'));
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
    // Native embedded pages render in separate views. Once the user chooses a
    // custom multi-pane layout, remove this temporary surface altogether so it
    // cannot overlap any pane or sit behind an Electron child view.
    if (startupOpen && doc.body.hasAttribute('data-neko-unified-enabled')) closeStartup();
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
    if (roomPreview && roomActive) {
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
      const side = slotRect?.width > 0 && slotRect?.height > 0 ? slotRect : track?.getBoundingClientRect();
      let bottom = side?.bottom;
      for (const node of [account?.parentElement, dock, account]) {
        const r = node?.getBoundingClientRect();
        if (r && r.height > 0 && r.top > (side?.top || 0) + 60) bottom = Math.min(bottom, r.top);
      }
      const visible = !!side && side.width >= 80 && bottom - side.top >= 80 && !sidebar?.closest('[data-sidebar-collapsed="true"]');
      if (visible) {
        const values = { left: `${Math.round(side.left)}px`, top: `${Math.round(side.top)}px`, width: `${Math.round(side.width)}px`, height: `${Math.round(bottom - side.top)}px` };
        for (const [key, value] of Object.entries(values)) if (roomPreview.style[key] !== value) roomPreview.style[key] = value;
        protectRoomFooter(sidebar, account);
      } else releaseRoomInert();
      if (roomPreview.hidden === visible) roomPreview.hidden = !visible;
    }
    watchDockAncestors();
    syncCompanionPlacement(rail);
    const bounds = companionInRail ? railBounds() : null, size = bounds ? `${bounds.space.width}:${bounds.space.height}` : '';
    if (bounds && size !== lastRailSize) { lastRailSize = size; setRailPosition(railX, railY); syncRailWalking(); }
    if (!companionInRail) setCompanionOffset(companionOffset);
    if (root) {
      const r = root.getBoundingClientRect(), strip = doc.querySelector('.neko-strip')?.getBoundingClientRect();
      const x = Math.ceil(r.right), bottom = strip?.top > 0 ? strip.top : win.innerHeight;
      Object.assign(panel.style, { left: x + 'px', top: '0px', width: Math.max(0, win.innerWidth - x) + 'px', height: Math.max(0, bottom) + 'px' });
      Object.assign(startup.style, { left: x + 'px', top: '56px', width: Math.max(0, win.innerWidth - x) + 'px', height: Math.max(0, bottom - 56) + 'px' });
    }
    positionCompanionMenu();
  }
  function schedule() { if (!disposed && !queued) { queued = true; Promise.resolve().then(() => { queued = false; place(); positionCompanionMenu(); }); } }
  function nativeNew(event) { if (layout?.officeMode !== 'codex' || !event.target.closest?.('[data-neko-new-session="plus"]')) return; event.preventDefault(); event.stopImmediatePropagation(); newOffice(); }
  function escape(event) { if (event.key !== 'Escape') return; if (!companionMenu.hidden) { event.preventDefault(); event.stopPropagation(); closeCompanionMenu(); } else if (!modal.hidden) { event.stopPropagation(); closeSettings(); } else if (layout?.companionHistoryOpen && dock.contains(doc.activeElement)) { event.preventDefault(); saveLayout({ companionHistoryOpen: false }); historyToggle.focus(); } }
  const observer = new win.MutationObserver(schedule); observer.observe(doc.body, { childList: true, subtree: true, attributes:true, attributeFilter:['data-neko-unified-enabled', 'data-neko-tools'] });
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
  if (typeof bridge.subscribe === 'function') releases.push(bridge.subscribe(next => {
    if (disposed) return; state = next; const connections = modalBody.querySelector('.neko-workspace-connections'); if (connections) connections.textContent = connectionSummary(); if (!selectedProject) selectedProject = next.workspaceRoot || '';
    renderCompanion(); if (next.workspaceRevision !== layoutVersion) { layoutVersion = next.workspaceRevision; call({ action: 'state' }).then(value => { if (!disposed) { layout = value; renderLayout(); } }).catch(showError); }
  }));
  if (typeof bridge.subscribeOffice === 'function') releases.push(bridge.subscribeOffice(next => { if (disposed) return; if (next.thread?.id === selectedId || sendContext?.version === readVersion && sendContext.id === null) { office = next; } else { office.approvals = next.approvals || []; } renderOffice(); }));
  if (typeof bridge.subscribeCommunity === 'function') releases.push(bridge.subscribeCommunity(next => { if (disposed || next?.slot) return; socialOpen = next.status !== 'hidden'; renderOffice(); }));
  Promise.all([bridge.getState(), call({ action: 'state' }), call({ action: 'codex-state' }), call({ action: 'codex-model-choices' }).catch(() => null)]).then(([s, l, c, choices]) => { if (!disposed) { for (const [id, choice] of Object.entries(choices || {})) modelChoices.set(id, choice); state = s; layout = l; office = c; selectedId = c.thread?.id || null; selectedProject ||= s.workspaceRoot || ''; renderLayout(); refreshCatalog(); } }).catch(error => { catalogError = '工作会话读取失败，请刷新重试'; renderStartup(); showError(error); });
  syncCharacter();
  const interval = win.setInterval(() => { if (doc.visibilityState !== 'hidden') refreshCatalog(true); }, 60000);
  place();
  return () => {
    if (disposed) return; disposed = true; motion?.removeEventListener?.('change', syncCharacter); motion?.removeEventListener?.('change', syncRailWalking); doc.removeEventListener('visibilitychange', syncCharacter); doc.removeEventListener('visibilitychange', syncRailWalking); stopRailWalking(); if (railClickTimer !== null) win.clearTimeout(railClickTimer); if (railSpace) { if (railSpaceBeforeAria === null) railSpace.removeAttribute('aria-hidden'); else railSpace.setAttribute('aria-hidden', railSpaceBeforeAria); } if (characterVideo) { characterVideo.pause(); characterVideo.removeAttribute('src'); characterVideo.load(); } observer.disconnect(); ancestorObserver.disconnect(); intersection?.disconnect(); resize?.disconnect(); win.clearInterval(interval);
    win.removeEventListener('resize', place); doc.removeEventListener('scroll', schedule, true); doc.removeEventListener('click', nativeNew, true); doc.removeEventListener('keydown', escape, true);
    doc.removeEventListener('pointerdown', dismissCompanionMenu, true);
    doc.removeEventListener('neko-native-tools-navigate', showNativeToolsPage);
    if (roomPreview) { doc.removeEventListener('neko-chatroom-show-workspace', showWorkspaceFromLayout); doc.body.removeAttribute('data-neko-chatroom-active'); releaseRoomInert(); doc.dispatchEvent(new win.Event('neko-chatroom-mode-change')); }
    for (const release of releases) if (typeof release === 'function') release();
    for (const [node, attrs] of nativeMarks) for (const [name, before] of attrs) { if (node.getAttribute(name) === '') { if (before === null) node.removeAttribute(name); else node.setAttribute(name, before); } }
    doc.body.removeAttribute('data-neko-workspace-shell'); doc.body.removeAttribute('data-neko-office-mode');
    for (const n of nodes) n.remove(); style.remove();
  };
}
