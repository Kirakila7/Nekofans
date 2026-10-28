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
  const communityButton = button('', 'neko-side-rail__button neko-community neko-community-yui', () => { closeSettings(); Promise.resolve(options.openCommunity?.()).catch(showError); });
  communityButton.setAttribute('aria-label', 'Yui · N.E.K.O. 社区'); communityButton.title = 'N.E.K.O. 原生社区'; communityButton.appendChild(image(avatar('yui')));
  railTop.append(settingsButton, communityButton);
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
  const railCompanion = own(button('', 'neko-side-rail__button neko-rail-companion', () => toggleCompanionMenu(railCompanion)));
  railCompanion.hidden = true; railCompanion.title = '大肥鱼 · 点击互动';
  railCompanion.setAttribute('aria-label', '大肥鱼互动菜单');
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
    if (needsRail !== companionInRail || (needsRail && character.parentNode !== railCompanion)) {
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
  }
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
      await options.openDshNew(seat.projectRoot);
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
        if (row.provider === 'codex' && codexPaused()) { link.disabled = true; link.title = 'Codex 测试中，暂不可用'; link.textContent += ' · 测试中'; }
        section.appendChild(link);
      }
      return section;
    }));
    if (catalog?.nextDshOffset != null) projectList.appendChild(button('加载更多 DSH 会话', 'neko-workspace-more', () => refreshCatalog(true, catalog.nextDshOffset)));
    const unavailable = Object.entries(catalog?.providers || {}).filter(([, status]) => status !== 'ready' && status !== 'testing').map(([name]) => name.toUpperCase());
    listStatus.textContent = listLoading ? '正在读取本地工作会话…' : unavailable.length ? unavailable.join('、') + ' 会话暂不可读取，可刷新重试' : codexPaused() ? 'Codex 测试中，暂不可用' : rows.length ? '' : seat && !seat.provider ? '请配置这个工作 agent' : '暂无匹配的工作会话';
  }
  async function refreshCatalog(force = false, dshOffset = 0) {
    if (disposed || listLoading) return;
    listLoading = true; renderCatalog();
    try { const next = await call({ action: 'catalog', force, dshOffset }); if (!disposed) catalog = next; }
    catch (error) { showError(error); }
    finally { listLoading = false; if (!disposed) renderCatalog(); }
  }
  async function openSession(row) {
    if (row.provider === 'codex' && codexPaused()) { showError(Error('Codex 测试中，暂不可用')); return; }
    hideSocial(); closeSettings();
    if (row.provider === 'dsh') { await saveLayout({ officeMode: 'dsh' }); options.openDshSession?.(row.id); }
    else {
      const version = ++readVersion; selectedId = row.id; selectedProject = row.cwd; officeInput.value = drafts.get(row.id) || ''; officeReading = true; officeErrorText = '';
      await saveLayout({ officeMode: 'codex' }); officeError.textContent = '正在读取原生 Codex 会话…';
      try { const next = await call({ action: 'codex-read', id: row.id }); if (!disposed && version === readVersion) office = next; }
      catch (error) { if (!disposed && version === readVersion) showOfficeError(error); }
      finally { if (!disposed && version === readVersion) { officeReading = false; renderOffice(); } }
    }
  }
  function newOffice() { ++readVersion; hideSocial(); selectedId = null; officeReading = false; officeErrorText = ''; office = { status: 'idle', thread: null, items: [], approvals: office.approvals || [], error: '' }; officeInput.value = drafts.get('new') || ''; officeRenderKey = ''; renderOffice(); officeInput.focus(); }
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
    const found = options.locateSidebar?.(); const root = found?.root || found?.slot || doc.querySelector('[data-slot="sidebar"]');
    const rail = doc.querySelector('[data-neko-side-rail]'), theme = rail?.querySelector('.neko-side-rail__theme');
    if (rail && railCompanion.parentNode !== rail) rail.prepend(railCompanion);
    if (theme && officeButton.parentNode !== theme) { if (!nativeMarks.has(theme)) nativeMarks.set(theme, new Map()); nativeMarks.get(theme).set('aria-hidden', theme.getAttribute('aria-hidden')); theme.setAttribute('aria-hidden', ''); theme.appendChild(officeButton); }
    if (rail && railTop.parentNode !== rail) theme?.after(railTop);
    const mount = doc.querySelector('[data-neko-seat-mount]'); if (mount && seats.parentNode !== mount) mount.appendChild(seats);
    const nativeBrowser = doc.querySelector('[data-slot="sidebar.workspaces"]');
    if (nativeBrowser) { markNative(nativeBrowser, 'data-neko-session-browser-original'); if (sessionBrowser.parentNode !== nativeBrowser.parentNode || sessionBrowser.nextSibling !== nativeBrowser) nativeBrowser.before(sessionBrowser); }
    const account = doc.querySelector('[data-slot="settings.launcher"]');
    if (account?.parentElement) markNative(account.parentElement, 'data-neko-companion-footer');
    if (account && (dock.parentNode !== account.parentNode || dock.nextSibling !== account)) account.before(dock);
    watchDockAncestors();
    syncCompanionPlacement(rail);
    if (!companionInRail) setCompanionOffset(companionOffset);
    if (root) {
      const r = root.getBoundingClientRect(), strip = doc.querySelector('.neko-strip')?.getBoundingClientRect();
      const x = Math.ceil(r.right), bottom = strip?.top > 0 ? strip.top : win.innerHeight;
      Object.assign(panel.style, { left: x + 'px', top: '0px', width: Math.max(0, win.innerWidth - x) + 'px', height: Math.max(0, bottom) + 'px' });
    }
    positionCompanionMenu();
  }
  function schedule() { if (!disposed && !queued) { queued = true; Promise.resolve().then(() => { queued = false; place(); positionCompanionMenu(); }); } }
  function nativeNew(event) { if (layout?.officeMode !== 'codex' || !event.target.closest?.('[data-neko-new-session="plus"]')) return; event.preventDefault(); event.stopImmediatePropagation(); newOffice(); }
  function escape(event) { if (event.key !== 'Escape') return; if (!companionMenu.hidden) { event.preventDefault(); event.stopPropagation(); closeCompanionMenu(); } else if (!modal.hidden) { event.stopPropagation(); closeSettings(); } else if (layout?.companionHistoryOpen && dock.contains(doc.activeElement)) { event.preventDefault(); saveLayout({ companionHistoryOpen: false }); historyToggle.focus(); } }
  const observer = new win.MutationObserver(schedule); observer.observe(doc.body, { childList: true, subtree: true });
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
  if (typeof bridge.subscribeCommunity === 'function') releases.push(bridge.subscribeCommunity(next => { if (disposed) return; socialOpen = next.status !== 'hidden'; renderOffice(); }));
  Promise.all([bridge.getState(), call({ action: 'state' }), call({ action: 'codex-state' }), call({ action: 'codex-model-choices' }).catch(() => null)]).then(([s, l, c, choices]) => { if (!disposed) { for (const [id, choice] of Object.entries(choices || {})) modelChoices.set(id, choice); state = s; layout = l; office = c; selectedId = c.thread?.id || null; selectedProject ||= s.workspaceRoot || ''; renderLayout(); refreshCatalog(); } }).catch(showError);
  syncCharacter();
  const interval = win.setInterval(() => { if (doc.visibilityState !== 'hidden') refreshCatalog(true); }, 60000);
  place();
  return () => {
    if (disposed) return; disposed = true; motion?.removeEventListener?.('change', syncCharacter); doc.removeEventListener('visibilitychange', syncCharacter); if (characterVideo) { characterVideo.pause(); characterVideo.removeAttribute('src'); characterVideo.load(); } observer.disconnect(); ancestorObserver.disconnect(); intersection?.disconnect(); resize?.disconnect(); win.clearInterval(interval);
    win.removeEventListener('resize', place); doc.removeEventListener('scroll', schedule, true); doc.removeEventListener('click', nativeNew, true); doc.removeEventListener('keydown', escape, true);
    doc.removeEventListener('pointerdown', dismissCompanionMenu, true);
    for (const release of releases) if (typeof release === 'function') release();
    for (const [node, attrs] of nativeMarks) for (const [name, before] of attrs) { if (node.getAttribute(name) === '') { if (before === null) node.removeAttribute(name); else node.setAttribute(name, before); } }
    doc.body.removeAttribute('data-neko-workspace-shell'); doc.body.removeAttribute('data-neko-office-mode');
    for (const n of nodes) n.remove(); style.remove();
  };
}
