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
  let office = { status: 'idle', thread: null, items: [], approvals: [], error: '' };
  const nativeMarks = new Map(), nodes = [], releases = [], drafts = new Map(), groupOpen = new Set();
  const own = node => { node.dataset.nekoWorkspaceOwned = ''; nodes.push(node); return node; };
  const call = request => bridge.workspace(request);
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
  const lobby = typeof bridge.lobby === 'function' ? createLobbyView({ doc, bridge, el, button, image, avatar, composer: options.lobbyComposer || (typeof WORKBENCH_LOBBY_COMPOSER !== 'undefined' ? WORKBENCH_LOBBY_COMPOSER : null) || win.WorkbenchLobbyComposer || null, companion: () => state?.companion, onOpen: () => { hideSocial(); closeSettings(); }, onChange: () => renderOffice() }) : null;
  if (lobby) { own(lobby.panel); railTop.appendChild(lobby.railButton); releases.push(lobby.dispose); }
  const leaveViews = () => { hideSocial(); lobby?.hide(); };
  const seats = own(el('div', 'neko-custom-seats')); seats.setAttribute('role', 'group'); seats.setAttribute('aria-label', '自定义工作 agent');
  const sessionBrowser = own(el('section', 'neko-session-browser')); sessionBrowser.setAttribute('aria-label', '全部工作会话');
  const listHeader = el('div', 'neko-session-browser__header');
  const allButton = button('全部工作会话', 'neko-session-all', () => saveLayout({ activeSeatId: null }));
  const refreshButton = button('↻', 'neko-session-refresh', () => refreshCatalog(true)); refreshButton.setAttribute('aria-label', '刷新本地工作会话');
  listHeader.append(allButton, refreshButton);
  const search = el('input', 'neko-session-search'); search.type = 'search'; search.placeholder = '搜索工作会话或项目'; search.setAttribute('aria-label', '搜索工作会话或项目'); search.addEventListener('input', () => { searchText = search.value.toLowerCase(); renderCatalog(); });
  const listStatus = el('p', 'neko-session-status'), projectList = el('div', 'neko-project-list');
  sessionBrowser.append(listHeader, search, listStatus, projectList);
  const dock = own(el('section', 'neko-companion-dock')); dock.setAttribute('aria-label', '主 agent 聊天');
  const character = el('div', 'neko-companion-character');
  character.setAttribute('role', 'slider'); character.tabIndex = 0; character.setAttribute('aria-label', '左右移动大肥鱼'); character.setAttribute('aria-orientation', 'horizontal'); character.title = '左右拖动 · Home 回到中间';
  let companionOffset = 0, companionDrag = null;
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
    if (event.button !== 0 || companionDrag) return;
    setCompanionOffset(companionOffset); companionDrag = { pointerId: event.pointerId, x: event.clientX, offset: companionOffset };
    character.dataset.dragging = 'true'; event.preventDefault();
    try { character.setPointerCapture(event.pointerId); } catch {}
  });
  character.addEventListener('pointermove', event => {
    if (!companionDrag || companionDrag.pointerId !== event.pointerId) return;
    setCompanionOffset(companionDrag.offset + event.clientX - companionDrag.x);
  });
  const finishCompanionDrag = event => { if (!companionDrag || companionDrag.pointerId !== event.pointerId) return; companionDrag = null; character.removeAttribute('data-dragging'); try { character.releasePointerCapture(event.pointerId); } catch {} };
  character.addEventListener('pointerup', finishCompanionDrag); character.addEventListener('pointercancel', finishCompanionDrag); character.addEventListener('lostpointercapture', finishCompanionDrag);
  character.addEventListener('dragstart', event => event.preventDefault());
  character.addEventListener('keydown', event => {
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
  const officeFooter = el('div', 'neko-office-form-footer'), officeCaption = el('span', '', 'Codex 原生执行层 · 沿用本机配置');
  const stopButton = button('停止', 'neko-office-stop', () => call({ action: 'codex-stop' }).catch(showOfficeError));
  const sendButton = el('button', 'neko-office-send', '发送'); sendButton.type = 'submit';
  officeFooter.append(officeCaption, stopButton, sendButton); officeForm.append(officeInput, officeFooter);
  panel.append(officeHeader, officeHistory, officeError, officeApprovals, officeForm); doc.body.appendChild(panel);
  officeInput.addEventListener('input', () => drafts.set(selectedId || 'new', officeInput.value));
  let officeSending = false, officeRenderKey = '', readVersion = 0;
  officeForm.addEventListener('submit', async event => {
    event.preventDefault(); const message = officeInput.value.trim(); if (!message || officeSending) return;
    officeSending = true; sendButton.disabled = true; officeError.textContent = '';
    try {
      const next = await call({ action: 'codex-send', id: selectedId, cwd: office.thread?.cwd || selectedProject || state?.workspaceRoot, message });
      drafts.delete(selectedId || 'new'); officeInput.value = ''; if (next.thread?.id === selectedId || officeSending) { office = next; } else { office.approvals = next.approvals || []; } renderOffice(); refreshCatalog(true);
    } catch (error) { showOfficeError(error); }
    finally { officeSending = false; renderOffice(); }
  });
  officeInput.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); officeForm.requestSubmit(); } });
  const modal = own(el('div', 'neko-workspace-modal')); modal.hidden = true; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  const modalCard = el('section', 'neko-workspace-modal__card'), modalHeader = el('header'), modalTitle = el('h2');
  const modalClose = button('×', 'neko-workspace-modal__close', closeSettings); modalClose.setAttribute('aria-label', '关闭工作台设置');
  modalHeader.append(modalTitle, modalClose); const modalBody = el('div', 'neko-workspace-modal__body'); modalCard.append(modalHeader, modalBody); modal.appendChild(modalCard); doc.body.appendChild(modal);
  modal.addEventListener('pointerdown', event => { if (event.target === modal) closeSettings(); });
  function showError(error) { listStatus.textContent = error?.message || '工作台操作未完成，请重试'; }
  function showOfficeError(error) { officeError.textContent = error?.message || 'Codex 操作未完成，请重试'; }
  async function saveLayout(patch) {
    try { layout = await call({ action: 'update', patch }); renderLayout(); }
    catch (error) { showError(error); }
  }
  function renderLayout() {
    if (!layout || disposed) return;
    officeImage.src = avatar(layout.officeMode === 'codex' ? 'devcat' : 'bigfish');
    officeButton.setAttribute('aria-label', '工作界面：' + (layout.officeMode === 'codex' ? 'Codex' : 'DSH') + '，点击切换');
    doc.body.setAttribute('data-neko-office-mode', layout.officeMode);
    const active = layout.activeSeatId;
    seats.replaceChildren(...layout.seats.map(seat => {
      const row = el('div', 'neko-custom-seat'); row.dataset.active = String(active === seat.id);
      const pick = button('', 'neko-custom-seat__pick', () => {
        if (!seat.provider) { openSettings('seat', seat.id); return; }
        leaveViews();
        saveLayout({ activeSeatId: seat.id, officeMode: seat.provider });
      });
      pick.setAttribute('aria-pressed', String(active === seat.id));
      pick.append(image(seat.avatarId === 'custom' ? seat.customDataUrl : avatar(seat.avatarId)), el('span', 'neko-custom-seat__name', seat.name), el('span', 'neko-custom-seat__provider', seat.provider?.toUpperCase() || '未绑定'));
      const settings = button('⋯', 'neko-custom-seat__settings', () => openSettings('seat', seat.id)); settings.setAttribute('aria-label', '配置工作 agent：' + seat.name);
      row.append(pick, settings); return row;
    }));
    renderCatalog(); renderCompanion(); renderOffice(); place();
  }
  function renderCatalog() {
    if (!layout) return;
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
        const link = button(row.title, 'neko-workspace-session', () => openSession(row));
        link.title = row.title; link.dataset.selected = String(row.provider === 'codex' && row.id === selectedId);
        section.appendChild(link);
      }
      return section;
    }));
    if (catalog?.nextDshOffset != null) projectList.appendChild(button('加载更多 DSH 会话', 'neko-workspace-more', () => refreshCatalog(true, catalog.nextDshOffset)));
    const unavailable = Object.entries(catalog?.providers || {}).filter(([, status]) => status !== 'ready').map(([name]) => name.toUpperCase());
    listStatus.textContent = listLoading ? '正在读取本地工作会话…' : unavailable.length ? unavailable.join('、') + ' 会话暂不可读取，可刷新重试' : rows.length ? '' : seat && !seat.provider ? '请配置这个工作 agent' : '暂无匹配的工作会话';
  }
  async function refreshCatalog(force = false, dshOffset = 0) {
    if (disposed || listLoading) return;
    listLoading = true; renderCatalog();
    try { const next = await call({ action: 'catalog', force, dshOffset }); if (!disposed) catalog = next; }
    catch (error) { showError(error); }
    finally { listLoading = false; if (!disposed) renderCatalog(); }
  }
  async function openSession(row) {
    leaveViews(); closeSettings();
    if (row.provider === 'dsh') { await saveLayout({ officeMode: 'dsh' }); options.openDshSession?.(row.id); }
    else {
      const version = ++readVersion; selectedId = row.id; selectedProject = row.cwd; officeInput.value = drafts.get(row.id) || '';
      await saveLayout({ officeMode: 'codex' }); officeError.textContent = '正在读取原生 Codex 会话…';
      try { const next = await call({ action: 'codex-read', id: row.id }); if (!disposed && version === readVersion) { office = next; } if (!disposed && version === readVersion) { officeError.textContent = ''; renderOffice(); } } catch (error) { showOfficeError(error); }
    }
  }
  function newOffice() { ++readVersion; leaveViews(); selectedId = null; office = { status: 'idle', thread: null, items: [], approvals: office.approvals || [], error: '' }; officeInput.value = drafts.get('new') || ''; officeRenderKey = ''; renderOffice(); officeInput.focus(); }
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
    lobby?.renderStatus();
  }
  function renderOffice() {
    if (!layout) return;
    const lobbyOpen = !!lobby?.isOpen(); panel.hidden = layout.officeMode !== 'codex' || socialOpen || lobbyOpen;
    for (const main of doc.querySelectorAll('main')) { if (socialOpen) continue; if (main.closest('[data-neko-workspace-owned]')) continue; if ((!panel.hidden || lobbyOpen) && !main.contains(dock)) markNative(main, 'inert'); else if (nativeMarks.get(main)?.has('inert')) { const before = nativeMarks.get(main).get('inert'); if (before === null) main.removeAttribute('inert'); else main.setAttribute('inert', before); nativeMarks.get(main).delete('inert'); } }
    officeTitle.textContent = office.thread?.title || 'Codex'; officeModel.textContent = office.thread?.model || '本机默认模型';
    const cwd = office.thread?.cwd || selectedProject || state?.workspaceRoot || '';
    projectButton.textContent = cwd ? cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd : '选择项目'; projectButton.title = cwd || '选择项目';
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
    officeError.textContent = office.error || (office.status === 'working' ? 'Codex 正在工作…' : '');
    sendButton.disabled = officeSending || office.status === 'working'; stopButton.hidden = office.status !== 'working';
    officeApprovals.replaceChildren(...(office.approvals || []).map(a => {
      const box = el('section', 'neko-office-approval'); box.append(el('strong', '', a.title), el('p', '', [a.threadTitle, a.cwd].filter(Boolean).join(' · ')), el('pre', '', a.command || a.reason || 'Codex 请求确认此操作'));
      box.append(button('允许本次', '', () => call({ action: 'codex-approve', key: a.key, decision: 'accept' }).catch(showOfficeError)), button('拒绝', '', () => call({ action: 'codex-approve', key: a.key, decision: 'decline' }).catch(showOfficeError))); return box;
    }));
  }
  function closeSettings() { if (modal.hidden) return; modal.hidden = true; settingsButton.focus(); }
  function officeChoices() {
    const choices = el('div', 'neko-office-choices');
    for (const [id, name, pic] of [['dsh', 'DSH', 'bigfish'], ['codex', 'Codex', 'devcat'], ['claude', 'Claude · 待接入', 'claude']]) {
      const b = button('', 'neko-office-choice', async () => { leaveViews(); await saveLayout({ officeMode: id }); closeSettings(); });
      b.disabled = id === 'claude'; b.setAttribute('aria-pressed', String(layout?.officeMode === id)); b.append(image(avatar(pic)), el('span', '', name)); choices.appendChild(b);
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
      for (const [value, label] of [['', '暂不绑定'], ['dsh', 'DSH'], ['codex', 'Codex']]) { const option = el('option', '', label); option.value = value; provider.appendChild(option); } provider.value = seat.provider || ''; providerLabel.appendChild(provider);
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
    const found = options.locateSidebar?.(); const root = found?.root || found?.slot || doc.querySelector('[data-slot="sidebar"]');
    const rail = doc.querySelector('[data-neko-side-rail]'), theme = rail?.querySelector('.neko-side-rail__theme');
    if (theme && officeButton.parentNode !== theme) { if (!nativeMarks.has(theme)) nativeMarks.set(theme, new Map()); nativeMarks.get(theme).set('aria-hidden', theme.getAttribute('aria-hidden')); theme.setAttribute('aria-hidden', ''); theme.appendChild(officeButton); }
    if (rail && railTop.parentNode !== rail) theme?.after(railTop);
    const mount = doc.querySelector('[data-neko-seat-mount]'); if (mount && seats.parentNode !== mount) mount.appendChild(seats);
    const nativeBrowser = doc.querySelector('[data-slot="sidebar.workspaces"]');
    if (nativeBrowser) { markNative(nativeBrowser, 'data-neko-session-browser-original'); if (sessionBrowser.parentNode !== nativeBrowser.parentNode || sessionBrowser.nextSibling !== nativeBrowser) nativeBrowser.before(sessionBrowser); }
    const account = doc.querySelector('[data-slot="settings.launcher"]');
    if (account?.parentElement) markNative(account.parentElement, 'data-neko-companion-footer');
    if (account && (dock.parentNode !== account.parentNode || dock.nextSibling !== account)) account.before(dock);
    setCompanionOffset(companionOffset);
    if (root) {
      const r = root.getBoundingClientRect(), strip = doc.querySelector('.neko-strip')?.getBoundingClientRect();
      const x = Math.ceil(r.right), bottom = strip?.top > 0 ? strip.top : win.innerHeight;
      Object.assign(panel.style, { left: x + 'px', top: '0px', width: Math.max(0, win.innerWidth - x) + 'px', height: Math.max(0, bottom) + 'px' });
      lobby?.place(panel.style);
    }
  }
  function schedule() { if (!disposed && !queued) { queued = true; Promise.resolve().then(() => { queued = false; place(); }); } }
  function nativeNew(event) { if (layout?.officeMode !== 'codex' || !event.target.closest?.('[data-neko-new-session="plus"]')) return; event.preventDefault(); event.stopImmediatePropagation(); newOffice(); }
  function escape(event) { if (event.key !== 'Escape') return; if (!modal.hidden) { event.stopPropagation(); closeSettings(); } else if (layout?.companionHistoryOpen && dock.contains(doc.activeElement)) { event.preventDefault(); saveLayout({ companionHistoryOpen: false }); historyToggle.focus(); } }
  const observer = new win.MutationObserver(schedule); observer.observe(doc.body, { childList: true, subtree: true });
  win.addEventListener('resize', place); doc.addEventListener('click', nativeNew, true); doc.addEventListener('keydown', escape, true);
  const resize = win.ResizeObserver ? new win.ResizeObserver(place) : null;
  if (options.locateSidebar?.()?.root) resize?.observe(options.locateSidebar().root);
  doc.body.setAttribute('data-neko-workspace-shell', '');
  if (typeof bridge.subscribe === 'function') releases.push(bridge.subscribe(next => {
    if (disposed) return; state = next; const connections = modalBody.querySelector('.neko-workspace-connections'); if (connections) connections.textContent = connectionSummary(); if (!selectedProject) selectedProject = next.workspaceRoot || '';
    renderCompanion(); if (next.workspaceRevision !== layoutVersion) { layoutVersion = next.workspaceRevision; call({ action: 'state' }).then(value => { if (!disposed) { layout = value; renderLayout(); } }).catch(showError); }
  }));
  if (typeof bridge.subscribeOffice === 'function') releases.push(bridge.subscribeOffice(next => { if (disposed) return; if (next.thread?.id === selectedId || officeSending) { office = next; } else { office.approvals = next.approvals || []; } renderOffice(); }));
  if (typeof bridge.subscribeCommunity === 'function') releases.push(bridge.subscribeCommunity(next => { if (disposed) return; socialOpen = next.status !== 'hidden'; if (socialOpen) lobby?.hide(); renderOffice(); }));
  Promise.all([bridge.getState(), call({ action: 'state' }), call({ action: 'codex-state' })]).then(([s, l, c]) => { if (!disposed) { state = s; layout = l; office = c; selectedProject ||= s.workspaceRoot || ''; renderLayout(); refreshCatalog(); } }).catch(showError);
  syncCharacter();
  const interval = win.setInterval(() => { if (doc.visibilityState !== 'hidden') refreshCatalog(true); }, 60000);
  place();
  return () => {
    if (disposed) return; disposed = true; motion?.removeEventListener?.('change', syncCharacter); doc.removeEventListener('visibilitychange', syncCharacter); if (characterVideo) { characterVideo.pause(); characterVideo.removeAttribute('src'); characterVideo.load(); } observer.disconnect(); resize?.disconnect(); win.clearInterval(interval);
    win.removeEventListener('resize', place); doc.removeEventListener('click', nativeNew, true); doc.removeEventListener('keydown', escape, true);
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
