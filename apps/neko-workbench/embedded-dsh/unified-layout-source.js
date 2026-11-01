// Optional multi-region workspace. Native DSH and each remote site keep their
// own existing document; the controller only changes geometry/visibility.
function installUnifiedLayout(options = {}) {
  const doc = options.document || document, win = options.window || window;
  const bridge = options.bridge || win.nekoWorkbench;
  if (!doc?.body || typeof bridge?.workspace !== 'function' || typeof bridge?.community !== 'function' || doc.querySelector('[data-neko-unified-style]')) return () => {};
  const rail = doc.querySelector('[data-neko-side-rail]');
  if (!rail) return () => {};
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
  const style = el('style'); style.dataset.nekoUnifiedStyle = ''; style.textContent = options.cssText || ''; doc.head.appendChild(style);
  // Keep the legacy multi-pane engine for compatibility, but do not expose it
  // in the daily UI while the compact floating work area is in use.
  let allowLegacyMultiPane = options.allowLegacyMultiPane === true;
  const SLOT_NAMES = { side: '侧栏', left: '左面板', right: '右面板' };
  const MIN_RATIO = 0.25, MAX_RATIO = 0.75;
  const clampRatio = value => Math.max(MIN_RATIO, Math.min(MAX_RATIO, Number.isFinite(value) ? value : 0.5));
  // Human-readable name of what a slot currently shows; the sidebar's
  // "workspace" is DSH's native navigation, not a second coding surface.
  const describe = (slot, value) => slot === 'side'
    ? ({ workspace: '工作区导航', community: '社区', bilibili: videoSite === 'youtube' ? 'YouTube' : 'B站视频' })[value] || '工作区导航'
    : ({ coding: '工作区', community: '社区', bilibili: videoSite === 'youtube' ? 'YouTube' : 'B站视频' })[value] || '空';
  const trigger = button('▤', 'neko-side-rail__button neko-layout-entry', toggleConfig);
  trigger.title = '配置界面布局'; trigger.setAttribute('aria-label', '配置界面布局'); trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', 'neko-unified-config');
  const container = doc.querySelector('.neko-workspace-rail-controls') || rail;
  if (allowLegacyMultiPane) container.appendChild(trigger);
  let configReturnFocus = trigger;
  const config = el('section', 'neko-unified-config'); config.dataset.nekoUnifiedConfig = ''; config.hidden = true; config.id = 'neko-unified-config';
  config.setAttribute('role', 'dialog'); config.setAttribute('aria-labelledby', 'neko-unified-config-title'); config.setAttribute('aria-describedby', 'neko-unified-config-help');
  const close = button('×', 'close', () => setConfig(false, true)); close.setAttribute('aria-label', '关闭界面配置'); close.title = '关闭（Esc）';
  const title = el('h2', '', '界面配置'), explanation = el('p', 'help', '① 选一个区域 ② 点选内容，或把内容拖到窗口里的目标区域。选择内容会自动启用自定义布局。');
  title.id = 'neko-unified-config-title'; explanation.id = 'neko-unified-config-help';
  const summary = el('p', 'summary'); summary.dataset.nekoUnifiedSummary = ''; summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  const toggle = button('启用自定义布局', 'toggle', () => update({ ...layout, enabled: !layout.enabled, ...(layout.flex ? {flex:{...layout.flex,enabled:false}} : {}) }));
  const restore = button('恢复上次多栏布局', 'toggle', () => {
    if (!startupSaved) return;
    const previous = startupSaved; startupSaved = null; applySaved(previous);
  });
  restore.hidden = true;
  const targets = el('div', 'choices'), contents = el('div', 'choices'); targets.setAttribute('role', 'group'); targets.setAttribute('aria-label', '显示区域');
  contents.setAttribute('role', 'group'); contents.setAttribute('aria-label', '显示内容');
  let target = 'left';
  const targetButtons = {}, targetCurrent = {}, contentButtons = {};
  for (const key of ['side', 'left', 'right']) {
    const b = button('', '', () => { target = key; renderConfig(); }); b.dataset.target = key;
    const current = el('small', 'current'); current.setAttribute('aria-hidden', 'true');
    b.append(el('span', 'name', SLOT_NAMES[key]), current); targetButtons[key] = b; targetCurrent[key] = current; targets.appendChild(b);
  }
  for (const [key, label] of [['coding', '工作区'], ['community', '社区'], ['bilibili', 'B站视频']]) {
    contentButtons[key] = button(label, '', () => choose(key)); contentButtons[key].draggable = true; contentButtons[key].title = `点选放入所选区域，或拖到目标区域`;
    contentButtons[key].dataset.nekoLayoutDrag = key; contentButtons[key].dataset.content = key; contents.appendChild(contentButtons[key]);
  }
  // Left/right panes can be emptied so a two-pane layout can go back to one.
  contentButtons.none = button('不显示', 'none', () => choose(null)); contentButtons.none.dataset.content = 'none'; contents.appendChild(contentButtons.none);
  const hint = el('p', 'hint');
  const swap = button('⇄ 交换左右面板', 'toggle', () => update({ ...layout, left: layout.right, right: layout.left, ...(layout.flex ? {flex:{...layout.flex,enabled:false}} : {}) }));
  const info = el('p', 'message'); info.setAttribute('role', 'status'); info.setAttribute('aria-live', 'polite');
  const flexControls = el('section', 'neko-flex-config');
  const flexPresets = el('div', 'choices');
  const presets = [ ['左侧聊天室 / 右侧上下', 'x', 'y'], ['上下排列', 'y', 'y'], ['左右排列', 'x', 'x'], ['上方单区 / 下方左右', 'y', 'x'] ];
  for (const [label, rootAxis, stackAxis] of presets) flexPresets.appendChild(button(label, '', () => {
    const prev = layout.flex || { slots:['social','bilibili','coding'], rootRatio:.55, stackRatio:.5 };
    void update({ ...layout, enabled:true, flex:{ ...prev, enabled:true, rootAxis, stackAxis } });
  }));
  const flexSlots = el('div', 'neko-flex-slots');
  const flexClose = button('退出三面板', 'toggle', () => void update({ ...layout, enabled:false, flex:{...layout.flex, enabled:false} }));
  flexControls.append(el('strong', '', '三面板布局'), flexPresets, el('p', 'flex-hint', '选择预设并用下方选项交换区域。拖动分隔线调整大小。'), flexSlots, flexClose);
  config.append(close, title, explanation, summary, flexControls, toggle, restore, el('strong', '', '显示区域'), targets, el('strong', '', '显示内容'), contents, hint, swap, info);
  if (allowLegacyMultiPane) doc.body.appendChild(config);
  // Escape closes the dialog from anywhere, but only returns focus to ▤ when
  // focus was inside the dialog (or nowhere); a focused DSH input keeps it.
  function escapeConfig(event) {
    if (event.key !== 'Escape' || config.hidden || event.defaultPrevented) return;
    const active = doc.activeElement, inside = config.contains(active);
    if (!inside && active && active !== doc.body && active !== trigger) { void setConfig(false); return; }
    event.preventDefault(); event.stopPropagation(); void setConfig(false, true);
  }
  doc.addEventListener('keydown', escapeConfig);
  const mobile = el('nav', 'neko-unified-mobile'); mobile.setAttribute('aria-label', '窄窗口面板切换'); mobile.hidden = true;
  let activeMain = 'left';
  const mobileLeft = button('左面板', '', () => { activeMain = 'left'; schedule(); }); mobileLeft.dataset.nekoMobileSlot = 'left';
  const mobileRight = button('右面板', '', () => { activeMain = 'right'; schedule(); }); mobileRight.dataset.nekoMobileSlot = 'right';
  mobile.append(mobileLeft, mobileRight); doc.body.appendChild(mobile);
  const divider = el('div', 'neko-unified-divider'); divider.hidden = true; divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', '调整左右面板宽度'); divider.tabIndex = 0;
  divider.setAttribute('aria-orientation', 'vertical'); divider.setAttribute('aria-valuemin', String(MIN_RATIO * 100)); divider.setAttribute('aria-valuemax', String(MAX_RATIO * 100));
  divider.title = '拖动调整宽度 · 双击恢复各半 · 方向键微调'; doc.body.appendChild(divider);
  // Transient notice for errors that happen while the configuration dialog is
  // closed (divider save, layout geometry). It sits in the top 40px band, where
  // site panels draw their renderer-owned toolbar, so a native view never
  // covers it.
  const notice = el('div', 'neko-unified-notice'); notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); doc.body.appendChild(notice);
  let noticeTimer = null;
  const drops = {};
  for (const slot of ['side', 'left', 'right']) {
    const zone = el('div', 'neko-unified-drop'); zone.hidden = true; zone.dataset.nekoDropSlot = slot;
    const label = el('strong', '', `放到${SLOT_NAMES[slot]}`), current = el('small'); zone.append(label, current);
    zone.addEventListener('dragenter', event => { if (!draggedContent) return; event.preventDefault(); zone.dataset.active = 'true'; });
    zone.addEventListener('dragover', event => { if (!draggedContent) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; zone.dataset.active = 'true'; });
    zone.addEventListener('dragleave', () => { zone.removeAttribute('data-active'); });
    zone.addEventListener('drop', event => {
      if (!draggedContent) return;
      event.preventDefault(); const value = draggedContent; draggedContent = null; hideDrops();
      target = slot; choose(value); void setConfig(false, true);
    });
    doc.body.appendChild(zone); drops[slot] = { zone, current };
  }
  let layout = { enabled: false, side: 'workspace', left: null, right: 'coding', ratio: 0.5 };
  let startupSaved = null;
  // Social surfaces temporarily occupy the existing sidebar track.  This is
  // navigation, not a saved pane layout; the right-hand work session stays put.
  let sideSurface = null, sideHome = false, videoSite = 'bilibili', videoSelectionRevision = 0;
  if (typeof bridge.workspace === 'function') {
    const initialRevision = videoSelectionRevision;
    Promise.resolve().then(() => bridge.workspace({action:'video-platform'})).then(value => {
      if (!disposed && initialRevision === videoSelectionRevision && ['bilibili','youtube'].includes(value?.platform)) { videoSite = value.platform; renderConfig(); updateVideoLabels(); schedule(); }
    }).catch(() => {});
  }
  function announceSideSurface(surface) {
    for (const [selector, name] of [['.neko-community-yui','community'],['.neko-side-rail__bilibili','bilibili']]) {
      const entry = doc.querySelector(selector);
      if (entry) entry.setAttribute('aria-pressed', String(surface === name || name === 'bilibili' && surface === 'youtube'));
    }
    doc.dispatchEvent(new win.CustomEvent('neko-side-surface-change', { detail: { surface } }));
  }
  function closeSideSurface() {
    if (!sideSurface) return;
    sideSurface = null; sideHome = false;
    doc.body.removeAttribute('data-neko-side-social-active');
    panels.side.node.hidden = true; closeView('side');
    announceSideSurface('hidden'); schedule();
  }
  function openSideSurface(site, { home = false } = {}) {
    if (disposed || !['community', 'bilibili', 'youtube'].includes(site)) return;
    if (layout.enabled && layout.flex?.enabled) {
      if (site === 'bilibili' || site === 'youtube') {
        videoSite = site;
        if (sideSurface) closeSideSurface();
        if (!flexTabs.hidden) flexActive='bilibili';
        schedule(); return;
      }
      if (!flexTabs.hidden) flexActive='social';
      if (sideSurface === 'community') { schedule(); return; }
      sideSurface='community'; sideHome=false; doc.body.setAttribute('data-neko-side-social-active', ''); announceSideSurface('community'); schedule(); return;
    }
    // Discard only the in-memory presentation of any old multi-pane layout;
    // never rewrite the user's previously stored configuration.
    if (layout.enabled) {
      layout = { enabled:false, side:'workspace', left:null, right:'coding', ratio:layout.ratio };
      doc.body.removeAttribute('data-neko-flex-mode'); clearFlex();
      doc.body.removeAttribute('data-neko-unified-enabled'); hideAll(); clearCoding();
    }
    options.hideLegacy?.();
    if (site !== sideSurface || home) closeView('side');
    sideSurface = site; sideHome = home && site === 'bilibili';
    doc.body.setAttribute('data-neko-side-social-active', '');
    // A collapsed native sidebar has no usable bounds for the child view.
    // Reuse the real sidebar control before measuring its social surface.
    doc.querySelector('.neko-side-rail__expand:not([hidden])')?.click();
    announceSideSurface(site); schedule();
  }
  let disposed = false, frame = 0, revision = 0, requestId = 0, codingNode = null, codingInert = false, suspended = false, drag = null, draggedContent = null;
  let nativeDividerKey = '';
  function postNativeDivider(rect) {
    if (typeof bridge.divider !== 'function') return;
    const key=JSON.stringify(rect); if (key===nativeDividerKey) return; nativeDividerKey=key;
    void Promise.resolve(bridge.divider(rect ? {action:'place',id:'unified',rect} : {action:'remove',id:'unified'})).catch(()=>{});
  }
  let scheduled = false, placements = new Map(), unsubscribe = null, unsubscribeAccount = null, lastRects = {}, openTickets = {}, recoveryTimer = null;
  let accountPending = false, accountRevision = 0;
  const panels = {};
  function makePanel(slot) {
    const node = el('section', 'neko-unified-panel'); node.hidden = true; node.dataset.nekoUnifiedSlot = slot;
    const header = el('header'), name = el('strong'), back = button('上一页', '', () => action(slot, 'back'));
    // The header is renderer DOM above the native view, so short feedback lives
    // in the title line instead of the body text that the site view covers.
    // The body status (role=status) is announced; this visible copy is not.
    const titleText = el('span', 'title'), note = el('span', 'note'); note.setAttribute('aria-hidden', 'true'); name.append(titleText, note);
    const reload = button('刷新', '', () => action(slot, 'reload'));
    const play = button('官方播放', '', () => action(slot, 'play-official'));
    const share = button('分享', '', () => action(slot, 'copy-video-link'));
    const youtubeInput = el('input', 'neko-youtube-url'); youtubeInput.type = 'url'; youtubeInput.placeholder = '粘贴视频或播放列表链接'; youtubeInput.setAttribute('aria-label','YouTube 视频或播放列表链接');
    const youtubeOpen = button('打开视频', 'neko-youtube-open', () => {
      const videoUrl = youtubeInput.value.trim();
      if (!videoUrl) { panelNote(slot, '请先粘贴 YouTube 视频链接', 'error'); youtubeInput.focus(); return; }
      panelNote(slot, '正在打开视频…', 'loading');
      void Promise.resolve(bridge.community({action:'open-youtube-video',slot,videoUrl})).catch(() => { if (!disposed) panelNote(slot, '视频未能打开，请检查链接或网络', 'error'); });
    });
    youtubeInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); youtubeOpen.click(); } });
    const youtubeShorts = button('刷短视频', 'neko-youtube-shorts', () => {
      panelNote(slot, '正在打开 YouTube Shorts…', 'loading');
      void Promise.resolve(bridge.community({action:'open-youtube-shorts',slot})).catch(() => { if (!disposed) panelNote(slot, '短视频未能打开，请检查网络后重试', 'error'); });
    });
    const account = button('连接桌面身份', 'neko-unified-account', () => accountAction(slot));
    account.title = '复用本机 N.E.K.O. 社区账号；未登录时在系统浏览器完成官方授权';
    const leave = button('返回工作区', '', () => {
      if (slot === 'side' && sideSurface) {
        closeSideSurface();
        // Return to the chatroom that occupied this same sidebar.
        doc.querySelector('.neko-room-entry')?.click();
        return;
      }
      if (layout.flex?.enabled) { showNotice('视频已在三面板中打开'); return; }
      // If the other main pane already holds coding, close this optional
      // content instead of swapping it into that pane.
      const other = slot === 'left' ? 'right' : 'left';
      chooseFor(slot, slot !== 'side' && layout[other] === 'coding' ? null : 'coding');
    });
    back.setAttribute('aria-label', '返回上一页'); reload.setAttribute('aria-label', '刷新当前页面');
    if (slot === 'side') leave.textContent = '返回聊天室';
    play.hidden = share.hidden = account.hidden = youtubeInput.hidden = youtubeOpen.hidden = youtubeShorts.hidden = true; header.append(name, back, reload, play, share, account, leave, youtubeShorts, youtubeInput, youtubeOpen);
    const status = el('p', 'status'); status.setAttribute('role', 'status'); node.append(header, status); doc.body.appendChild(node);
    panels[slot] = { node, header, name, titleText, note, back, reload, play, share, account, leave, youtubeInput, youtubeOpen, youtubeShorts, status, site: null, noteTimer: null };
  }
  for (const slot of ['side', 'left', 'right']) makePanel(slot);
  // kind: 'loading' | 'error' | 'ok'. 'ok' notes clear themselves; load and
  // error states stay until the site reports a new state.
  function panelNote(slot, text, kind = 'ok') {
    const p = panels[slot]; if (!p) return;
    if (p.noteTimer) { win.clearTimeout(p.noteTimer); p.noteTimer = null; }
    p.note.textContent = text ? ' · ' + text : ''; p.status.textContent = text || '';
    if (text) p.node.dataset.state = kind; else p.node.removeAttribute('data-state');
    p.name.title = text ? `${p.titleText.textContent}：${text}` : p.titleText.textContent;
    if (text && kind === 'ok') p.noteTimer = win.setTimeout(() => { p.noteTimer = null; if (!disposed && p.node.dataset.state === 'ok') panelNote(slot, ''); }, 2500);
  }
  function action(slot, actionName) {
    // Reload resolves only after the page has loaded, so announce it first.
    if (actionName === 'reload') panelNote(slot, '正在刷新…', 'loading');
    void Promise.resolve(bridge.community({ action: actionName, slot })).then(result => {
      if (disposed) return;
      if (actionName === 'copy-video-link') panelNote(slot, result?.ok ? '链接已复制' : '复制失败，请重试', result?.ok ? 'ok' : 'error');
      else if (actionName === 'reload' && panels[slot].node.dataset.state === 'loading') panelNote(slot, '');
    }).catch(() => { if (!disposed) panelNote(slot, actionName === 'copy-video-link' ? '复制失败，请重试' : '操作未完成，请重试', 'error'); });
  }
  function paintAccount(state) {
    if (disposed || !state || typeof state.message !== 'string') return;
    accountPending = ['checking', 'connecting', 'authorizing'].includes(state.status);
    for (const slot of ['side', 'left', 'right']) {
      const p = panels[slot];
      if (placements.get(slot) !== 'community' || p.node.hidden) continue;
      p.account.textContent = accountPending ? '取消连接' : '连接桌面身份';
      p.account.disabled = false;
      panelNote(slot, state.message, state.status === 'error' ? 'error' : accountPending ? 'loading' : 'ok');
    }
  }
  function accountAction(slot) {
    if (disposed || placements.get(slot) !== 'community' || panels[slot].node.hidden || typeof bridge.communityAccount !== 'function') return;
    const ticket = ++accountRevision;
    if (accountPending) {
      accountPending = false;
      void Promise.resolve(bridge.communityAccount('cancel')).then(state => {
        if (!disposed && ticket === accountRevision) paintAccount(state);
      }).catch(() => { if (!disposed && ticket === accountRevision) panelNote(slot, '取消连接未完成，请重试', 'error'); });
      return;
    }
    paintAccount({ status:'checking', message:'正在检查桌面社区连接…' });
    void Promise.resolve(bridge.communityAccount('connect')).then(state => {
      if (!disposed && ticket === accountRevision && placements.get(slot) === 'community') paintAccount(state);
    }).catch(() => { if (!disposed && ticket === accountRevision && placements.get(slot) === 'community') paintAccount({ status:'error', message:'桌面身份连接未完成，请重试；仍可直接浏览社区。' }); });
  }
  function showNotice(text) {
    if (disposed) return;
    if (!config.hidden) { info.textContent = text; return; }
    if (!text) { clearNotice(); return; }
    if (notice.textContent !== text) notice.textContent = text;
    notice.hidden = false;
    if (noticeTimer) win.clearTimeout(noticeTimer);
    noticeTimer = win.setTimeout(clearNotice, 5000);
  }
  function clearNotice() {
    if (noticeTimer) win.clearTimeout(noticeTimer);
    noticeTimer = null; notice.hidden = true; notice.textContent = '';
  }
  function summaryText() {
    if (!layout.enabled) return '默认显示侧栏与工作区；可选择内容打开中间区域。' + (startupSaved ? ' 上次多栏布局可恢复。' : '');
    const parts = ['side', 'left', 'right'].map(slot => `${SLOT_NAMES[slot]}：${describe(slot, layout[slot])}`);
    const two = layout.left && layout.right, left = Math.round(clampRatio(layout.ratio) * 100);
    return '当前 ' + parts.join(' · ') + (two ? `（宽度 ${left}% / ${100 - left}%）` : '');
  }
  function renderConfig() {
    trigger.setAttribute('aria-expanded', String(!config.hidden));
    toggle.textContent = layout.enabled ? '关闭自定义布局（恢复单栏）' : '启用自定义布局';
    toggle.setAttribute('aria-pressed', String(layout.enabled));
    restore.hidden = !startupSaved;
    summary.textContent = layout.flex?.enabled ? '三面板：' + layout.flex.slots.map(x => ({social:'聊天室',bilibili:videoSite === 'youtube' ? 'YouTube' : 'B站',coding:'工作区'})[x]).join(' / ') : summaryText(); config.dataset.enabled = String(layout.enabled);
    flexSlots.replaceChildren();
    if (layout.flex?.enabled) for (let i=0; i<3; i++) {
      const row = el('label', 'neko-flex-slot'); row.appendChild(el('span', '', ['独立区域','内层第一格','内层第二格'][i]));
      const select = el('select'); select.setAttribute('aria-label', '选择'+['独立区域','内层第一格','内层第二格'][i]);
      for (const [value,name] of [['social','聊天室'],['bilibili',videoSite === 'youtube' ? 'YouTube' : 'B站视频'],['coding','工作区']]) { const option=el('option','',name); option.value=value; option.selected=layout.flex.slots[i]===value; select.appendChild(option); }
      select.addEventListener('change', () => { const slots=[...layout.flex.slots], j=slots.indexOf(select.value); [slots[i],slots[j]]=[slots[j],slots[i]]; void update({...layout, flex:{...layout.flex,slots}}); });
      row.appendChild(select); flexSlots.appendChild(row);
    }
    flexClose.hidden = !layout.flex?.enabled;
    for (const key of Object.keys(targetButtons)) {
      const shown = describe(key, layout[key]);
      targetButtons[key].setAttribute('aria-pressed', String(key === target));
      targetButtons[key].setAttribute('aria-label', `${SLOT_NAMES[key]}，当前显示${shown}`);
      if (targetCurrent[key].textContent !== shown) targetCurrent[key].textContent = shown;
    }
    const value = target === 'side' && layout.side === 'workspace' ? 'coding' : layout[target] ?? 'none';
    contentButtons.bilibili.textContent = videoSite === 'youtube' ? 'YouTube' : 'B站视频';
    for (const key of Object.keys(contentButtons)) contentButtons[key].setAttribute('aria-pressed', String(key === value));
    contentButtons.coding.textContent = target === 'side' ? '工作区导航' : '工作区';
    const other = target === 'left' ? 'right' : 'left';
    contentButtons.none.hidden = target === 'side';
    // Keep at least one main pane; an empty window has nothing to return to.
    contentButtons.none.disabled = target !== 'side' && !layout[other];
    contentButtons.none.title = contentButtons.none.disabled ? `${SLOT_NAMES[other]}也为空，至少保留一个面板` : `清空${SLOT_NAMES[target]}，另一侧占满宽度`;
    hint.textContent = target === 'side'
      ? '侧栏：选「工作区导航」恢复 DSH 原生会话列表；账号和角色生活区始终留在侧栏底部。'
      : `${SLOT_NAMES[target]}：每个内容只在一个区域打开；已在别处的会移过来，原区域换成这里之前的内容（侧栏则恢复工作区导航）。窄窗口顶部可切换左右面板。`;
    swap.disabled = !layout.enabled || !layout.left && !layout.right;
  }
  function focusFirst() { (targetButtons[target] || close).focus?.(); }
  async function setConfig(open, returnFocus = false) {
    if (!allowLegacyMultiPane || disposed || config.hidden === !open) return;
    config.hidden = !open; suspended = open && layout.enabled; renderConfig();
    if (open) { info.textContent = ''; clearNotice(); focusFirst(); }
    else if (returnFocus) {
      const fallback = doc.querySelector('.neko-workspace-settings') || trigger;
      const destination = configReturnFocus?.isConnected && !configReturnFocus.closest?.('[hidden]') ? configReturnFocus : fallback;
      destination?.focus?.();
    }
    if (suspended) hideAll(); else schedule();
  }
  function toggleConfig() { configReturnFocus = trigger; void setConfig(config.hidden); }
  async function openConfigFromSettings(event) {
    if (!allowLegacyMultiPane && event.detail?.optIn === true) {
      allowLegacyMultiPane = true;
      container.appendChild(trigger); doc.body.appendChild(config);
      try {
        const saved = await bridge.workspace({action:'pane-layout'});
        if (disposed) return;
        if (saved?.enabled) { startupSaved = clean(saved); restore.hidden = false; }
      } catch { showNotice('上次布局暂不可读取，可重新选择布局'); }
    }
    configReturnFocus = event.detail?.returnFocus || doc.querySelector('.neko-workspace-settings') || trigger;
    void setConfig(true);
  }
  doc.addEventListener('neko-unified-open-config', openConfigFromSettings);
  function clean(next) { return { enabled: !!next.enabled, side: next.side, left: next.left, right: next.right, ratio: next.ratio, ...(next.flex ? { flex: { ...next.flex, slots: [...next.flex.slots] } } : {}) }; }
  let confirmed = null;
  function applySaved(saved) {
    if (!allowLegacyMultiPane) saved = { enabled:false, side:'workspace', left:null, right:'coding', ratio:clampRatio(saved?.ratio) };
    const enabling = !layout.enabled && saved.enabled;
    layout = clean(saved); confirmed = { ...layout }; renderConfig();
    if (enabling) options.hideLegacy?.();
    if (layout.enabled) doc.body.setAttribute('data-neko-unified-enabled', '');
    else { doc.body.removeAttribute('data-neko-unified-enabled'); hideAll(); clearCoding(); }
    doc.body.toggleAttribute('data-neko-flex-mode', !!(layout.enabled && layout.flex?.enabled));
    if (layout.enabled && (layout.flex?.enabled || layout.side !== 'workspace')) doc.querySelector('.neko-side-rail__expand:not([hidden])')?.click();
    suspended = !config.hidden && layout.enabled; schedule();
  }
  async function update(next, raise = false) {
    if (!allowLegacyMultiPane) return;
    const ticket = ++revision;
    try {
      const saved = await bridge.workspace({ action: 'set-pane-layout', layout: clean(next) });
      if (disposed || ticket !== revision) { if (raise) throw Error('界面配置已变化，请重试'); return; }
      startupSaved = null; info.textContent = ''; applySaved(saved);
    } catch (error) {
      if (!disposed && ticket === revision) {
        // A previous write can have reached disk before its acknowledgement.
        // Read back the durable state rather than restoring a stale snapshot.
        let restored = confirmed;
        try { restored = clean(await bridge.workspace({ action: 'pane-layout' })); } catch { /* use the last acknowledged layout */ }
        if (disposed || ticket !== revision) { if (raise) throw error; return; }
        if (restored) applySaved(restored);
        showNotice('界面配置未能保存：' + (error?.message || '请重试'));
      }
      if (raise) throw error;
    }
  }
  function chooseFor(slot, value, raise = false) { target = slot; return choose(value, raise); }
  function choose(value, raise = false) {
    // Choosing a side-pane destination is an explicit request to leave the
    // temporary chatroom preview and reveal that side pane.
    if (target === 'side' && doc.body.hasAttribute('data-neko-chatroom-active')) doc.dispatchEvent(new win.Event('neko-chatroom-show-workspace'));
    const next = { ...layout, enabled: true, ...(layout.flex ? {flex:{...layout.flex,enabled:false}} : {}) }, requested = target === 'side' && value === 'coding' ? 'workspace' : value;
    // Opening a social page in the sole coding pane creates an adjacent pane,
    // rather than replacing the user's work surface.
    if (target !== 'side' && next[target] === 'coding' && (requested === 'community' || requested === 'bilibili')) {
      const other = target === 'left' ? 'right' : 'left';
      if (!next[other]) next[other] = 'coding';
    }
    if (requested !== 'workspace' && requested !== null) {
      for (const other of ['side', 'left', 'right']) if (other !== target && next[other] === requested) {
        const previous = next[target];
        // The sidebar's workspace is a navigation region, not a second coding view.
        next[other] = other === 'side' ? 'workspace' : (previous && previous !== 'workspace' ? previous : null);
      }
    }
    next[target] = requested; return update(next, raise);
  }
  function findGeometry() {
    const sidebar = doc.querySelector('[data-slot="sidebar"]');
    if (!sidebar?.isConnected) return null;
    let item = sidebar, frameNode = null, center = null;
    while (item?.parentElement && item.parentElement !== doc.body) {
      const next = item.nextElementSibling;
      if (next && typeof next.className === 'string' && /(?:^|\s)[^\s]*_centerCol(?:[_-][^\s]+)?(?:\s|$)/.test(next.className)) { frameNode = item.parentElement; center = next; break; }
      item = item.parentElement;
    }
    if (!frameNode || !center) return null;
    const bounds = frameNode.getBoundingClientRect(), slotRect = sidebar.getBoundingClientRect();
    // DSH's sidebar slot can be display:contents and therefore have no box;
    // the corresponding grid track is the visible sidebar in that case.
    const sideRect = slotRect.width > 0 && slotRect.height > 0 ? slotRect : item.getBoundingClientRect();
    const columns = win.getComputedStyle(frameNode).gridTemplateColumns.trim().split(/\s+/).map(Number.parseFloat);
    const collapsed = doc.body.hasAttribute('data-neko-workspace-collapsed');
    if (columns.length < 2 || !Number.isFinite(columns[0]) || !Number.isFinite(columns[1]) || (!doc.body.hasAttribute('data-neko-flex-mode') && columns[1] < (collapsed ? 0 : 100))) return null;
    const full = { x: bounds.left + columns[0], y: bounds.top, width: columns[1], height: bounds.height };
    if (![full.x, full.y, full.width, full.height].every(Number.isFinite) || (!doc.body.hasAttribute('data-neko-flex-mode') && full.height < 100)) return null;
    let sideBottom = sideRect.bottom;
    const settingsSlot = sidebar.querySelector('[data-slot="sidebar.settings"]') || item.querySelector('[data-slot="sidebar.settings"]');
    const footer = sidebar.querySelector('[data-neko-companion-footer]') || item.querySelector('[data-neko-companion-footer]');
    const dock = sidebar.querySelector('.neko-companion-dock') || item.querySelector('.neko-companion-dock');
    const launcher = sidebar.querySelector('[data-slot="settings.launcher"]') || item.querySelector('[data-slot="settings.launcher"]');
    // The native settings slot may itself be display:contents; its parent is
    // the visible footer containing both the companion and account area.
    if (!sideSurface) for (const node of [settingsSlot?.parentElement, footer, dock, launcher]) {
      const part = node?.getBoundingClientRect();
      if (part && part.height > 0 && part.top > sideRect.top + 60) sideBottom = Math.min(sideBottom, part.top);
    }
    // Child WebContentsViews are always above the host renderer. In the
    // collapsed layout the real work composer floats in the bottom-right;
    // reserve its whole horizontal band so that it remains usable over a
    // community or video view. Do not detach, reload or cover the composer.
    if (!sideSurface && collapsed) for (const node of doc.querySelectorAll('[data-neko-collapsed-composer], [data-neko-workspace-expand-control]')) {
      const part = node.getBoundingClientRect();
      if (part.width > 0 && part.height > 0 && part.left < sideRect.right && part.right > sideRect.left && part.bottom > sideRect.top && part.top < sideBottom) {
        sideBottom = Math.min(sideBottom, Math.max(sideRect.top, part.top - 8));
      }
    }
    return { frameNode, center, full, side: { x: sideRect.left, y: sideRect.top, width: sideRect.width, height: Math.max(0, sideBottom - sideRect.top) } };
  }
  function clearCoding() {
    if (!codingNode) return;
    codingNode.removeAttribute('data-neko-unified-coding');
    if (!codingInert) codingNode.removeAttribute('inert');
    codingNode.removeAttribute('data-neko-flex-coding'); for (const key of ['--neko-flex-x','--neko-flex-y','--neko-flex-width','--neko-flex-height']) codingNode.style.removeProperty(key);
    codingNode.style.removeProperty('--neko-code-width'); codingNode.style.removeProperty('--neko-code-align'); codingNode = null;
  }
  function setCoding(node, rect, align, visible) {
    if (codingNode !== node) { clearCoding(); codingNode = node; codingInert = node.hasAttribute('inert'); }
    const marker = visible ? '' : 'hidden';
    if (node.getAttribute('data-neko-unified-coding') !== marker) node.setAttribute('data-neko-unified-coding', marker);
    const width = `${Math.max(0, rect.width)}px`;
    if (node.style.getPropertyValue('--neko-code-width') !== width) node.style.setProperty('--neko-code-width', width);
    if (node.style.getPropertyValue('--neko-code-align') !== align) node.style.setProperty('--neko-code-align', align);
    if (!visible && !node.hasAttribute('inert')) node.setAttribute('inert', ''); else if (visible && !codingInert && node.hasAttribute('inert')) node.removeAttribute('inert');
  }
  function hideAll() {
    if ([...placements.values()].includes('community')) { ++accountRevision; accountPending = false; }
    for (const [slot] of placements) void Promise.resolve(bridge.community({ action: 'hide', slot })).catch(() => {});
    placements.clear(); lastRects = {}; openTickets = {};
  }
  function closeView(slot) {
    if (!placements.has(slot)) return;
    if (placements.get(slot) === 'community') { ++accountRevision; accountPending = false; panels[slot].account.textContent = '连接桌面身份'; }
    placements.delete(slot); delete lastRects[slot]; delete openTickets[slot];
    void Promise.resolve(bridge.community({ action: 'hide', slot })).catch(() => {});
  }
  function placePanel(slot, rect, site, splitGutter = false) {
    const p = panels[slot]; if (!rect || rect.width < 80 || rect.height < 80 || !site) { p.node.hidden = true; closeView(slot); return; }
    p.node.hidden = false;
    const title = site === 'community' ? 'N.E.K.O. 社区' : site === 'youtube' ? 'YouTube' : 'B站视频';
    if (p.titleText.textContent !== title) { p.titleText.textContent = title; p.node.setAttribute('aria-label', `${SLOT_NAMES[slot]}：${title}`); }
    p.play.hidden = p.share.hidden = site !== 'bilibili';
    p.youtubeInput.hidden = p.youtubeOpen.hidden = p.youtubeShorts.hidden = site !== 'youtube';
    p.leave.hidden = !!layout.flex?.enabled && slot !== 'side';
    p.account.hidden = site !== 'community' || typeof bridge.communityAccount !== 'function';
    const boundsStyle = { left: `${Math.round(rect.x)}px`, top: `${Math.round(rect.y)}px`, width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px` };
    for (const [key, value] of Object.entries(boundsStyle)) if (p.node.style[key] !== value) p.node.style[key] = value;
    const bar = Math.max(42, Math.ceil(p.header.getBoundingClientRect().height));
    // Electron child views are composited above renderer DOM, including the
    // divider. Leave its hit area uncovered on both sides of a split so the
    // user can grab it even when a community/video page occupies either pane.
    // The web document receives the reduced viewport directly through
    // setBounds; it is not reloaded when the divider moves.
    const inset = splitGutter && (slot === 'left' || slot === 'right') ? 6 : 0;
    const targetBounds = { x: rect.x + (slot === 'right' ? inset : 0), y: rect.y + bar, width: rect.width - inset, height: rect.height - bar };
    if (targetBounds.height <= 1) { closeView(slot); return; }
    // Clip only controls that overlap a full-height social page, preserving
    // the original composer and divider without a blank strip underneath.
    const holes = slot === 'side' && sideSurface && (doc.body.hasAttribute('data-neko-workspace-collapsed') || doc.querySelector('[data-neko-companion-rail-chat]'))
      ? [...doc.querySelectorAll('[data-neko-companion-rail-chat], [data-neko-collapsed-composer], [data-neko-workspace-expand-control], .neko-chat-sidebar-divider')].filter(node=>!node.hidden).map(node=>node.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0).slice(0,3).map(r=>({x:r.left-3,y:r.top-3,width:r.width+6,height:r.height+6})) : [];
    const key = JSON.stringify({targetBounds,holes}), current = placements.get(slot);
    if (current !== site) {
      closeView(slot); placements.set(slot, site); panelNote(slot, `正在加载${title}…`, 'loading');
      p.play.disabled = p.share.disabled = true; p.site = site;
      p.account.textContent = '连接桌面身份'; p.account.disabled = site === 'community';
      const ticket = ++requestId; openTickets[slot] = ticket;
      const home = slot === 'side' && site === 'bilibili' && sideHome; if (home) sideHome = false;
      void Promise.resolve(bridge.community({ action: 'open', site, slot, bounds: targetBounds, requestId: ticket, ...(holes.length ? {holes} : {}), ...(home ? { home:true } : {}) })).catch(() => {
        if (!disposed && placements.get(slot) === site && openTickets[slot] === ticket) panelNote(slot, '页面未能打开，请检查网络后点「刷新」', 'error');
      });
    } else if (lastRects[slot] !== key) void Promise.resolve(bridge.community({ action: 'layout', slot, bounds: targetBounds, ...(holes.length ? {holes} : {}) })).catch(() => {});
    lastRects[slot] = key;
  }
  // A three-pane layout is a binary split: one root region and two children.
  // Moving the existing documents changes bounds, not their data or sessions.
  const flexDivider = el('div', 'neko-unified-divider neko-flex-divider');
  flexDivider.hidden = true; flexDivider.tabIndex = 0; flexDivider.setAttribute('role','separator'); doc.body.appendChild(flexDivider);
  let flexRects = null, flexNativeKeys = {}, flexDrag = null, flexMoving = null, flexActive = 'social', flexFooterHeight = 0, flexRestoringRoom = false, flexCompact = false;
  function clearFlexCompact() {
    if (!flexCompact && !doc.body.hasAttribute('data-neko-flex-workspace-collapsed')) return;
    flexCompact = false;
    doc.body.removeAttribute('data-neko-flex-workspace-collapsed');
    for (const key of ['--neko-flex-compact-right','--neko-flex-compact-width','--neko-flex-compact-bottom']) doc.body.style.removeProperty(key);
  }
  function expandFlexWorkspace() { if (!flexCompact) return; clearFlexCompact(); schedule(); }
  doc.addEventListener('neko-workspace-expand', expandFlexWorkspace);
  const flexTabs=el('nav','neko-flex-tabs'); flexTabs.hidden=true; flexTabs.setAttribute('aria-label','窗口较小时切换区域');
  const flexTabButtons={};
  for (const [name,label] of [['social','聊天室'],['bilibili','B站'],['coding','工作区']]) { const b=button(label,'',()=>{flexActive=name;schedule();}); b.setAttribute('aria-label','显示'+label); flexTabButtons[name]=b; flexTabs.appendChild(b); }
  doc.body.appendChild(flexTabs);
  const flexHandles = {}, flexDrops = {};
  for (const [name,label] of [['social','聊天室'],['bilibili','B站视频'],['coding','工作区']]) {
    const handle=button('⋮⋮', 'neko-flex-move', null); handle.draggable=true; handle.title='拖动'+label+'到其他区域'; handle.setAttribute('aria-label',handle.title); handle.hidden=true; doc.body.appendChild(handle); flexHandles[name]=handle;
    const zone=el('div','neko-unified-drop neko-flex-drop'); zone.hidden=true; zone.appendChild(el('strong','',label)); doc.body.appendChild(zone); flexDrops[name]=zone;
    handle.addEventListener('dragstart', event => {
      if (!flexRects?.byName) return;
      if (Object.values(panels).some(panel => !panel.node.hidden && panel.node.dataset.state === 'loading')) { event.preventDefault(); showNotice('页面正在加载，请稍候再拖动'); return; }
      flexMoving=name; event.dataTransfer?.setData('text/plain',name); if (event.dataTransfer) event.dataTransfer.effectAllowed='move';
      hideAll(); for (const [target,drop] of Object.entries(flexDrops)) { const r=flexRects.byName[target]; Object.assign(drop.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'}); drop.hidden=false; }
    });
    handle.addEventListener('dragend', () => { flexMoving=null; for (const drop of Object.values(flexDrops)) drop.hidden=true; schedule(); });
    zone.addEventListener('dragover', event => { if (flexMoving) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect='move'; } });
    zone.addEventListener('drop', event => { if (!flexMoving) return; event.preventDefault(); const slots=[...layout.flex.slots], from=slots.indexOf(flexMoving), to=slots.indexOf(name); [slots[from],slots[to]]=[slots[to],slots[from]]; flexMoving=null; for (const drop of Object.values(flexDrops)) drop.hidden=true; void update({...layout,flex:{...layout.flex,slots}}); });
  }
  function updateVideoLabels() {
    const label = videoSite === 'youtube' ? 'YouTube' : 'B站视频';
    flexTabButtons.bilibili.textContent = videoSite === 'youtube' ? 'YouTube' : 'B站';
    flexTabButtons.bilibili.setAttribute('aria-label', '显示' + label);
    flexHandles.bilibili.title = '拖动' + label + '到其他区域';
    flexHandles.bilibili.setAttribute('aria-label', flexHandles.bilibili.title);
    flexDrops.bilibili.querySelector('strong').textContent = label;
  }
  const flexClamp = value => Math.max(.15, Math.min(.85, Number.isFinite(value) ? value : .5));
  function splitFlex(rect, axis, ratio) {
    const size = axis === 'x' ? rect.width : rect.height, cut = Math.round(size * ratio);
    return axis === 'x' ? [{...rect,width:cut}, {...rect,x:rect.x+cut,width:rect.width-cut}] : [{...rect,height:cut}, {...rect,y:rect.y+cut,height:rect.height-cut}];
  }
  function flexHandle(id, node, rect, axis, ratio) {
    const horizontal = axis === 'y';
    const bar = horizontal ? {x:rect.x,y:Math.round(rect.y+rect.height*ratio)-4,width:rect.width,height:8} : {x:Math.round(rect.x+rect.width*ratio)-4,y:rect.y,width:8,height:rect.height};
    node.hidden = false; node.dataset.orientation = horizontal ? 'horizontal' : 'vertical';
    node.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
    node.setAttribute('aria-label', id === 'unified' ? '调整第一块区域大小' : '调整另外两块区域大小');
    node.setAttribute('aria-valuenow', String(Math.round(ratio*100))); node.setAttribute('aria-valuemin','15'); node.setAttribute('aria-valuemax','85');
    Object.assign(node.style, {left:bar.x+'px',top:bar.y+'px',width:bar.width+'px',height:bar.height+'px'});
    const request = {action:'place',id,orientation:horizontal?'horizontal':'vertical',rect:bar}, key=JSON.stringify(request);
    if (key !== flexNativeKeys[id] && typeof bridge.divider === 'function') { flexNativeKeys[id]=key; void Promise.resolve(bridge.divider(request)).catch(()=>{}); }
  }
  function clearFlex() {
    clearFlexCompact();
    if (!flexRects && !Object.keys(flexNativeKeys).length && flexTabs.hidden && !doc.body.hasAttribute('data-neko-flex-social-hidden')) return;
    flexRects=null; flexDrag=null; flexMoving=null; flexDivider.hidden=true; flexTabs.hidden=true; doc.body.removeAttribute('data-neko-flex-social-hidden'); for (const n of [...Object.values(flexHandles),...Object.values(flexDrops)]) n.hidden=true;
    doc.dispatchEvent(new win.CustomEvent('neko-flex-social-geometry', {detail:null}));
    for (const id of Object.keys(flexNativeKeys)) if (typeof bridge.divider === 'function') void Promise.resolve(bridge.divider({action:'remove',id})).catch(()=>{});
    flexNativeKeys={}; nativeDividerKey='';
    if (codingNode) { codingNode.removeAttribute('data-neko-flex-coding'); for (const key of ['--neko-flex-x','--neko-flex-y','--neko-flex-width','--neko-flex-height']) codingNode.style.removeProperty(key); }
  }
  function activateFlexRoom() { flexRestoringRoom=true; try { doc.querySelector('.neko-room-entry')?.click(); } finally { flexRestoringRoom=false; } }
  function placeFlex() {
    if (flexMoving) return;
    if (doc.visibilityState === 'hidden' || suspended || hasOverlay()) {
      hideAll(); for (const p of Object.values(panels)) p.node.hidden=true; divider.hidden=flexDivider.hidden=true;
      flexTabs.hidden=true; for (const n of Object.values(flexHandles)) n.hidden=true;
      for (const id of Object.keys(flexNativeKeys)) if (typeof bridge.divider === 'function') void Promise.resolve(bridge.divider({action:'remove',id})).catch(()=>{});
      flexNativeKeys={}; return;
    }
    const geo=findGeometry();
    if (!geo) { clearFlex(); showNotice('工作台布局尚未就绪，请展开侧栏后重试'); return; }
    const frameRect=geo.frameNode.getBoundingClientRect();
    const full={x:frameRect.left,y:frameRect.top,width:frameRect.width,height:frameRect.height};
    if (full.width<=0 || full.height<=0) { clearFlex(); return; }
    const flex=layout.flex;
    // Compact mode is meaningful only for the right-hand B站/workspace pair.
    // Leaving this arrangement restores the original panes and their state.
    if (flexCompact && !(flex.slots[0] === 'social' && flex.slots[1] === 'bilibili' && flex.slots[2] === 'coding')) clearFlexCompact();
    const measuredFooter=doc.querySelector('[data-neko-companion-footer]')?.getBoundingClientRect().height || 0;
    if (measuredFooter > 0) flexFooterHeight = measuredFooter;
    const footerHeight=flexFooterHeight;
    const minByName={ social:{width:180,height:Math.max(220,Math.ceil(footerHeight+80))}, bilibili:{width:180,height:160}, coding:{width:180,height:180} };
    const [firstMin,secondMin,thirdMin]=flex.slots.map(name=>minByName[name]);
    const combine=(a,b,axis)=>axis==='x'?{width:a.width+b.width,height:Math.max(a.height,b.height)}:{width:Math.max(a.width,b.width),height:a.height+b.height};
    const stackMin=combine(secondMin,thirdMin,flex.stackAxis), totalMin=combine(firstMin,stackMin,flex.rootAxis);
    if (full.width < totalMin.width || full.height < totalMin.height) {
      clearFlexCompact();
      // No positive split can keep all regions usable. Present one full-sized
      // region with explicit tabs; keep the saved arrangement and ratios intact.
      flexRects=null; divider.hidden=flexDivider.hidden=true; mobile.hidden=true; flexTabs.hidden=false;
      Object.assign(flexTabs.style,{left:Math.round(full.x)+'px',top:Math.round(full.y)+'px',width:Math.round(full.width)+'px'});
      for (const [name,node] of Object.entries(flexTabButtons)) node.setAttribute('aria-pressed',String(flexActive===name));
      for (const n of Object.values(flexHandles)) n.hidden=true;
      for (const id of Object.keys(flexNativeKeys)) if (typeof bridge.divider==='function') void Promise.resolve(bridge.divider({action:'remove',id})).catch(()=>{});
      flexNativeKeys={};
      const single={...full,y:full.y+36,height:Math.max(0,full.height-36)};
      doc.body.toggleAttribute('data-neko-flex-social-hidden',flexActive!=='social');
      doc.dispatchEvent(new win.CustomEvent('neko-flex-social-geometry',{detail:single}));
      if (!sideSurface && !doc.body.hasAttribute('data-neko-chatroom-active')) activateFlexRoom();
      setCoding(geo.center,single,'start',flexActive==='coding'); geo.center.setAttribute('data-neko-flex-coding','');
      for (const [key,value] of Object.entries({x:single.x,y:single.y,width:single.width,height:single.height})) geo.center.style.setProperty('--neko-flex-'+key,Math.round(value)+'px');
      panels.right.node.hidden=true; closeView('right');
      if (flexActive==='social' && sideSurface==='community') placePanel('side',single,'community'); else { panels.side.node.hidden=true; closeView('side'); }
      if (flexActive==='bilibili') placePanel('left',single,videoSite); else { panels.left.node.hidden=true; closeView('left'); }
      return;
    }
    flexTabs.hidden=true; doc.body.removeAttribute('data-neko-flex-social-hidden');
    const bounded=(value,size,minA,minB)=>Math.max(minA/size,Math.min(1-minB/size,flexClamp(value)));
    const rootSize=flex.rootAxis==='x'?full.width:full.height, rootDim=flex.rootAxis==='x'?'width':'height';
    const rootRatio=bounded(flex.rootRatio,rootSize,firstMin[rootDim],stackMin[rootDim]);
    const [first, stack]=splitFlex(full, flex.rootAxis, rootRatio);
    const stackSize=flex.stackAxis==='x'?stack.width:stack.height, stackDim=flex.stackAxis==='x'?'width':'height';
    const stackRatio=bounded(flex.stackRatio,stackSize,secondMin[stackDim],thirdMin[stackDim]);
    const [second, third]=splitFlex(stack, flex.stackAxis, stackRatio);
    const rects=[first,second,third], byName=Object.fromEntries(flex.slots.map((name,i)=>[name,rects[i]]));
    if (flexCompact) {
      // Keep the original DSH document mounted. The companion shell turns its
      // actual composer into a compact row and uses these viewport coordinates.
      const geometry = { '--neko-flex-compact-right': `${Math.max(0, Math.round(win.innerWidth - (stack.x + stack.width) + 16))}px`, '--neko-flex-compact-width': `${Math.max(0, Math.min(480, Math.floor(stack.width - 32)))}px`, '--neko-flex-compact-bottom': `${Math.max(0, Math.round(win.innerHeight - (stack.y + stack.height) + 16))}px` };
      for (const [key,value] of Object.entries(geometry)) if (doc.body.style.getPropertyValue(key) !== value) doc.body.style.setProperty(key,value);
      // The trusted native composer is layered above the video WebContentsView;
      // keep the video at the complete stack size instead of reserving a strip.
      byName.bilibili={...stack};
    }
    flexRects={full,stack,byName};
    for (const [name,node] of Object.entries(flexHandles)) { const r=byName[name]; node.hidden=flexCompact && name==='coding'; Object.assign(node.style,{left:Math.round(r.x+r.width-30)+'px',top:Math.round(r.y+5)+'px'}); }
    mobile.hidden=true;
    if (!sideSurface && !doc.body.hasAttribute('data-neko-chatroom-active')) activateFlexRoom();
    const social=byName.social; doc.dispatchEvent(new win.CustomEvent('neko-flex-social-geometry', {detail:social}));
    const code=byName.coding; setCoding(geo.center, code, 'start', true); geo.center.setAttribute('data-neko-flex-coding','');
    for (const [key,value] of Object.entries({x:code.x,y:code.y,width:code.width,height:code.height})) geo.center.style.setProperty('--neko-flex-'+key,Math.round(value)+'px');
    panels.right.node.hidden=true; closeView('right');
    if (sideSurface === 'community') placePanel('side',social,'community');
    else { panels.side.node.hidden=true; closeView('side'); }
    placePanel('left',byName.bilibili,videoSite);
    flexHandle('unified',divider,full,flex.rootAxis,rootRatio);
    if (!flexCompact) flexHandle('stack',flexDivider,stack,flex.stackAxis,stackRatio);
  }
  function flexEvent(event) {
    if (!layout.enabled || !layout.flex?.enabled || !flexRects || !['unified','stack'].includes(event?.id)) return;
    const key=event.id==='unified'?'root':'stack', axis=layout.flex[key+'Axis'], rect=key==='root'?flexRects.full:flexRects.stack, ratioKey=key+'Ratio';
    const point=axis==='x'?event.x:event.y, origin=axis==='x'?rect.x:rect.y, size=axis==='x'?rect.width:rect.height;
    if (event.type==='start') flexDrag={id:event.id,started:layout.flex[ratioKey],origin,size,axis,ratioKey};
    else if (event.type==='move' && flexDrag?.id===event.id && Number.isFinite(point)) { layout.flex={...layout.flex,[ratioKey]:flexClamp((point-flexDrag.origin)/flexDrag.size)}; schedule(); }
    else if (['end','cancel'].includes(event.type) && flexDrag?.id===event.id) {
      const old=flexDrag.started, value=event.type==='cancel'||event.click ? old : Number.isFinite(point)?flexClamp((point-flexDrag.origin)/flexDrag.size):layout.flex[ratioKey];
      const compact = event.type === 'end' && !event.click && event.id === 'stack' && layout.flex.slots[0] === 'social' && layout.flex.slots[1] === 'bilibili' && layout.flex.slots[2] === 'coding' && Number.isFinite(point) && point >= flexDrag.origin + flexDrag.size - 24;
      if (event.type === 'end' && event.click) (event.id === 'unified' ? divider : flexDivider).focus();
      flexDrag=null; layout.flex={...layout.flex,[ratioKey]:compact ? old : value};
      if (compact) { flexCompact=true; doc.body.setAttribute('data-neko-flex-workspace-collapsed',''); schedule(); }
      else if (Math.abs(value-old)>=.01) void update(layout); else schedule();
    } else if (event.type==='reset') { layout.flex={...layout.flex,[ratioKey]:.5}; void update(layout); }
    else if (event.type==='key') {
      const prev=axis==='x'?'ArrowLeft':'ArrowUp', next=axis==='x'?'ArrowRight':'ArrowDown';
      if (event.key==='End' && event.id==='stack' && layout.flex.slots[0]==='social' && layout.flex.slots[1]==='bilibili' && layout.flex.slots[2]==='coding') { flexCompact=true; doc.body.setAttribute('data-neko-flex-workspace-collapsed',''); schedule(); return; }
      if ([prev,next,'Home','End'].includes(event.key)) { const step=event.shift?.05:.01, value=event.key==='Home'?.15:event.key==='End'?.85:flexClamp(layout.flex[ratioKey]+(event.key===prev?-step:step)); layout.flex={...layout.flex,[ratioKey]:value}; void update(layout); }
    }
  }
  for (const [node,id] of [[divider,'unified'],[flexDivider,'stack']]) {
    node.addEventListener('pointerdown', event => { if (!layout.flex?.enabled || event.button!==0) return; node.setPointerCapture?.(event.pointerId); flexEvent({id,type:'start'}); event.preventDefault(); });
    node.addEventListener('pointermove', event => { if (flexDrag?.id===id) flexEvent({id,type:'move',x:event.clientX,y:event.clientY}); });
    node.addEventListener('pointerup', event => { if (flexDrag?.id===id) flexEvent({id,type:'end',x:event.clientX,y:event.clientY}); });
    node.addEventListener('pointercancel', () => { if (flexDrag?.id===id) flexEvent({id,type:'cancel'}); });
    node.addEventListener('dblclick', () => { if (layout.flex?.enabled) flexEvent({id,type:'reset'}); });
    node.addEventListener('keydown', event => { if (!layout.flex?.enabled || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return; event.preventDefault(); flexEvent({id,type:'key',key:event.key,shift:event.shiftKey}); });
  }
  const unsubscribeFlex = typeof bridge.subscribeDivider === 'function' ? bridge.subscribeDivider(flexEvent) : null;
  const overlaySelector = '[role="dialog"], [role="menu"], [data-neko-account-habitat-menu]';
  const accountSelector = '[data-slot="settings.launcher"] [aria-expanded]';
  function effectivelyVisible(node) {
    if (!node?.isConnected) return false;
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = win.getComputedStyle(current);
      if (current.hidden || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
    }
    return true;
  }
  function hasOverlay() {
    for (const account of doc.querySelectorAll(accountSelector)) {
      if (account.getAttribute('aria-expanded') === 'true' && effectivelyVisible(account)) return true;
    }
    for (const node of doc.querySelectorAll(overlaySelector)) {
      if (node === config || config.contains(node)) continue;
      if (effectivelyVisible(node)) return true;
    }
    return false;
  }
  function place() {
    frame = 0; if (disposed) return;
    if (layout.enabled && layout.flex?.enabled) { placeFlex(); return; }
    clearFlex();
    if (sideSurface) {
      divider.hidden = mobile.hidden = true; postNativeDivider(null); clearCoding();
      if (doc.visibilityState === 'hidden' || hasOverlay()) {
        hideAll(); for (const p of Object.values(panels)) p.node.hidden = true; return;
      }
      const geo = findGeometry();
      for (const slot of ['left', 'right']) { panels[slot].node.hidden = true; closeView(slot); }
      if (!geo) { panels.side.node.hidden = true; closeView('side'); return; }
      placePanel('side', geo.side, sideSurface); return;
    }
    if (!layout.enabled) { for (const p of Object.values(panels)) p.node.hidden = true; divider.hidden = mobile.hidden = true; postNativeDivider(null); return; }
    if (doc.visibilityState === 'hidden' || suspended || hasOverlay()) {
      hideAll(); for (const p of Object.values(panels)) p.node.hidden = true; divider.hidden = mobile.hidden = true; postNativeDivider(null); return;
    }
    const geo = findGeometry();
    if (!geo) { hideAll(); for (const p of Object.values(panels)) p.node.hidden = true; divider.hidden = mobile.hidden = true; postNativeDivider(null); clearCoding(); info.textContent = '工作台布局尚未就绪，请展开侧栏后重试。'; return; }
    const { full, center, side } = geo;
    const narrow = full.width < 540;
    const two = !!layout.left && !!layout.right;
    if (narrow && !layout[activeMain]) activeMain = layout.left ? 'left' : 'right';
    mobile.hidden = !(narrow && two);
    if (!mobile.hidden) {
      mobileLeft.setAttribute('aria-pressed', String(activeMain === 'left')); mobileRight.setAttribute('aria-pressed', String(activeMain === 'right'));
      mobileLeft.setAttribute('aria-label', `左面板：${describe('left', layout.left)}`); mobileRight.setAttribute('aria-label', `右面板：${describe('right', layout.right)}`);
    }
    const x = Math.round(full.x), y = Math.round(full.y), w = Math.round(full.width), h = Math.round(full.height);
    const split = Math.round(w * Math.max(0.25, Math.min(0.75, layout.ratio)));
    const bar = narrow && two ? 36 : 0;
    const rects = {
      side: side.width >= 100 && side.height >= 100 ? side : null,
      left: !layout.left || (narrow && two && activeMain !== 'left') ? null : { x, y:y+bar, width: two && !narrow ? split : w, height:h-bar },
      right: !layout.right || (narrow && two && activeMain !== 'right') ? null : { x: two && !narrow ? x+split : x, y:y+bar, width: two && !narrow ? w-split : w, height:h-bar },
    };
    const codingSide = layout.left === 'coding' ? 'left' : layout.right === 'coding' ? 'right' : null;
    const codeRect = codingSide && rects[codingSide];
    setCoding(center, codeRect || full, codingSide === 'right' && two && !narrow ? 'end' : 'start', !!codeRect);
    divider.hidden = !two || narrow;
    if (!divider.hidden) {
      Object.assign(divider.style, { left: `${x + split - 4}px`, top: `${y}px`, height: `${h}px` });
      postNativeDivider({x:x+split-4,y,width:8,height:h});
      const percent = Math.round(clampRatio(layout.ratio) * 100);
      divider.setAttribute('aria-valuenow', String(percent)); divider.setAttribute('aria-valuetext', `左面板 ${percent}% · 右面板 ${100 - percent}%`);
    } else postNativeDivider(null);
    for (const slot of ['side', 'left', 'right']) {
      const value = layout[slot];
      const site = value === 'community' ? 'community' : value === 'bilibili' ? videoSite : null;
      if (suspended || slot === 'side' && doc.body.hasAttribute('data-neko-chatroom-active')) { panels[slot].node.hidden = true; closeView(slot); }
      else placePanel(slot, rects[slot], site, two && !narrow);
    }
  }
  function schedule() { if (disposed || frame) return; frame = (win.requestAnimationFrame || (fn => win.setTimeout(fn, 16)))(place); }
  function hideDrops() {
    for (const [, { zone }] of Object.entries(drops)) {
      zone.hidden = true; zone.removeAttribute('data-active');
    }
  }
  function showDrops() {
    const geo = findGeometry(); if (!geo) return;
    const f = geo.full, split = Math.round(f.width * clampRatio(layout.ratio));
    const positions = { side: geo.side, left: { ...f, width: split }, right: { ...f, x: f.x + split, width: f.width - split } };
    for (const [slot, { zone, current }] of Object.entries(drops)) {
      const r = positions[slot]; if (!r || r.width < 60 || r.height < 80) continue;
      const shown = describe(slot, layout[slot]);
      current.textContent = shown !== '空' ? `当前：${shown}` : '';
      Object.assign(zone.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` }); zone.hidden = false;
    }
  }
  function startContentDrag(event) {
    const item = event.target.closest?.('[data-neko-layout-drag]'); if (!item) return;
    draggedContent = item.dataset.nekoLayoutDrag;
    event.dataTransfer?.setData('text/plain', draggedContent); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    // Native child views are detached while picking a destination, so the
    // renderer's drop targets cannot be covered by a WebContentsView.
    suspended = layout.enabled; hideAll(); schedule(); showDrops();
  }
  function endContentDrag() { draggedContent = null; hideDrops(); suspended = !config.hidden && layout.enabled; schedule(); }
  contents.addEventListener('dragstart', startContentDrag); contents.addEventListener('dragend', endContentDrag);
  const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  function observe() { const geo = findGeometry(); if (geo && geo.frameNode !== observe.frame) { resize?.disconnect(); resize?.observe(geo.frameNode); resize?.observe(doc.querySelector('[data-slot="sidebar"]')); for (const panel of Object.values(panels)) resize?.observe(panel.header); observe.frame = geo.frameNode; } }
  // Watch attributes only on actual overlay/account ancestors, avoiding global
  // class/style observation for DSH's frequent streaming updates. A separate
  // child-list observer refreshes this set if React mounts or replaces menus.
  let watchedOverlayNodes = new Set();
  const overlayObserver = new win.MutationObserver(schedule);
  function watchOverlayAncestors() {
    const next = new Set();
    for (const item of doc.querySelectorAll(overlaySelector + ', ' + accountSelector)) {
      if (item === config || config.contains(item)) continue;
      for (let node = item; node && node.nodeType === 1; node = node.parentElement) next.add(node);
    }
    if (next.size === watchedOverlayNodes.size && [...next].every(node => watchedOverlayNodes.has(node))) return;
    overlayObserver.disconnect(); watchedOverlayNodes = next;
    for (const node of next) overlayObserver.observe(node, { attributes:true, attributeFilter:['hidden','aria-expanded','data-state','style','class'] });
  }
  const observer = new win.MutationObserver(records => {
    const relevant = records.some(record => record.type === 'childList' || record.attributeName === 'role' || record.attributeName === 'data-neko-account-habitat-menu' ||
      (record.target instanceof win.Element && record.target.closest('[data-slot="settings.launcher"]')));
    if (!relevant || scheduled) return;
    scheduled = true; Promise.resolve().then(() => { scheduled = false; if (!disposed) { watchOverlayAncestors(); observe(); schedule(); } });
  });
  observer.observe(doc.body, { childList:true, subtree:true, attributes:true, attributeFilter:['aria-expanded','role','data-neko-account-habitat-menu'] });
  watchOverlayAncestors();
  win.addEventListener('resize', schedule); doc.addEventListener('scroll', schedule, true);
  doc.addEventListener('neko-collapsed-composer-geometry', schedule);
  function visibilityChanged() { if (doc.visibilityState === 'hidden') hideAll(); else schedule(); }
  doc.addEventListener('visibilitychange', visibilityChanged); win.addEventListener('focus', visibilityChanged);
  divider.addEventListener('pointerdown', e => { if (layout.flex?.enabled) return; if (e.button !== 0) return; const geo = findGeometry(); if (!geo) return; drag = { pointerId: e.pointerId, left: geo.full.x, width: geo.full.width, started: layout.ratio }; divider.setPointerCapture?.(e.pointerId); divider.dataset.dragging = 'true'; e.preventDefault(); });
  divider.addEventListener('pointermove', e => { if (!drag || drag.pointerId !== e.pointerId) return; layout.ratio = clampRatio((e.clientX - drag.left) / drag.width); schedule(); });
  divider.addEventListener('pointerup', e => { if (!drag || drag.pointerId !== e.pointerId) return; const started = drag.started, moved = Math.abs(layout.ratio - started) >= 0.01; drag = null; divider.removeAttribute('data-dragging'); if (moved) void update(layout); else { layout.ratio = started; schedule(); } });
  divider.addEventListener('pointercancel', e => { if (!drag || drag.pointerId !== e.pointerId) return; layout.ratio = drag.started; drag = null; divider.removeAttribute('data-dragging'); schedule(); });
  divider.addEventListener('dblclick', () => { if (!layout.flex?.enabled) void update({ ...layout, ratio: 0.5 }); });
  divider.addEventListener('keydown', e => {
    if (layout.flex?.enabled) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.05;
    const next = e.key === 'Home' ? MIN_RATIO : e.key === 'End' ? MAX_RATIO : clampRatio(layout.ratio + (e.key === 'ArrowLeft' ? -step : step));
    void update({ ...layout, ratio: next });
  });
  const unsubscribeNativeDivider = typeof bridge.subscribeDivider === 'function' ? bridge.subscribeDivider(event => {
    if (layout.flex?.enabled || event?.id !== 'unified' || divider.hidden) return;
    if (event.type === 'start') { const geo=findGeometry(); if (!geo || drag) return; drag={pointerId:'native',left:geo.full.x,width:geo.full.width,started:layout.ratio}; divider.dataset.dragging='true'; }
    else if (event.type === 'move' && drag?.pointerId === 'native' && Number.isFinite(event.x)) { layout.ratio=clampRatio((event.x-drag.left)/drag.width); schedule(); }
    else if ((event.type === 'end' || event.type === 'cancel') && drag?.pointerId === 'native') {
      const started=drag.started; if(event.type === 'end' && event.click) layout.ratio=started; else if (event.type === 'end' && Number.isFinite(event.x)) layout.ratio=clampRatio((event.x-drag.left)/drag.width);
      drag=null; divider.removeAttribute('data-dragging');
      if (event.type === 'cancel') { layout.ratio=started; schedule(); }
      else { divider.focus(); if (Math.abs(layout.ratio-started)>=.01) void update(layout); else { layout.ratio=started; schedule(); } }
    } else if (event.type === 'reset') void update({ ...layout, ratio:.5 });
    else if (event.type === 'key' && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      const step=event.shift?.05:.01, next=event.key==='Home'?MIN_RATIO:event.key==='End'?MAX_RATIO:clampRatio(layout.ratio+(event.key==='ArrowLeft'?-step:step)); void update({ ...layout, ratio:next });
    }
  }) : null;
  function shortcut(event) {
    const item = event.target.closest?.('.neko-community-yui, .neko-side-rail__bilibili'); if (!item) return;
    if (item.hasAttribute('data-neko-video-entry')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const bili = item.classList.contains('neko-side-rail__bilibili');
    openSideSurface(bili ? 'bilibili' : 'community', { home:bili });
  }
  doc.addEventListener('click', shortcut, true);
  function videoOpen(event) {
    const detail = event.detail;
    if (disposed || !detail || !['bilibili','youtube'].includes(detail.platform)) return;
    ++videoSelectionRevision; videoSite = detail.platform; detail.handled = true; renderConfig(); updateVideoLabels();
    openSideSurface(videoSite, {home:videoSite === 'bilibili'}); detail.promise = Promise.resolve();
  }
  doc.addEventListener('neko-video-open', videoOpen);
  // A companion's community visit must not invoke the legacy single-pane
  // route, which would hide all currently assigned native views. Save the
  // destination first; the visible companion menu is allowed to close before
  // remote loading resumes so no menu/native-view z-order deadlock occurs.
  function visitCommunity(event) {
    const detail = event.detail;
    if (disposed || !detail || typeof detail !== 'object') return;
    detail.handled = true;
    openSideSurface('community'); detail.promise = Promise.resolve();
  }
  doc.addEventListener('neko-unified-open-community', visitCommunity);
  doc.addEventListener('neko-side-surface-close', closeSideSurface);
  function roomModeChanged() {
    if (layout.enabled && layout.flex?.enabled && !sideSurface && !flexRestoringRoom) {
      if (!doc.body.hasAttribute('data-neko-chatroom-active')) { if (!flexTabs.hidden) flexActive='coding'; showNotice('工作区已在三面板中打开'); activateFlexRoom(); }
      else if (!flexTabs.hidden) flexActive='social';
    }
    if (doc.body.hasAttribute('data-neko-chatroom-active')) { panels.side.node.hidden = true; closeView('side'); }
    schedule();
  }
  doc.addEventListener('neko-chatroom-mode-change', roomModeChanged);
  if (typeof bridge.subscribeCommunity === 'function') unsubscribe = bridge.subscribeCommunity(state => {
    if (!state?.slot || !panels[state.slot] || placements.get(state.slot) !== state.site) return;
    if (state.status === 'hidden') {
      if (state.requestId !== undefined && openTickets[state.slot] !== state.requestId) return;
      placements.delete(state.slot); delete lastRects[state.slot]; delete openTickets[state.slot];
      // A close event can arrive just before Chromium marks the window hidden.
      // Wait until that transition has settled before attempting a reopen.
      if (recoveryTimer) win.clearTimeout(recoveryTimer);
      recoveryTimer = win.setTimeout(() => { recoveryTimer = null; if (!disposed && doc.visibilityState !== 'hidden') schedule(); }, 200);
      return;
    }
    const p = panels[state.slot];
    if (state.status === 'loading') panelNote(state.slot, '正在加载…', 'loading');
    if (state.status === 'ready') { panelNote(state.slot, ''); if (state.site === 'community') p.account.disabled = false; }
    if (state.tooSmall) panelNote(state.slot, '请扩大视频区域（至少 200 × 200）', 'error');
    else if (state.status === 'error') panelNote(state.slot, '页面未能打开，请检查网络后点「刷新」', 'error');
    if (typeof state.canGoBack === 'boolean') p.back.disabled = !state.canGoBack;
    if (typeof state.canShare === 'boolean') p.share.disabled = !state.canShare;
    if (typeof state.canPlayOfficial === 'boolean') p.play.disabled = !state.canPlayOfficial || !!state.isOfficialPlayer;
  });
  if (typeof bridge.subscribeCommunityAccount === 'function') unsubscribeAccount = bridge.subscribeCommunityAccount(paintAccount);
  Promise.resolve(bridge.workspace({ action:'pane-layout' })).then(saved => {
    if (disposed || revision) return;
    // Keep the durable layout intact. Each newly opened workbench starts with
    // the chatroom sidebar and one coding area; restoration is a user action.
    const previous = clean(saved);
    startupSaved = allowLegacyMultiPane && previous.enabled ? previous : null;
    layout = confirmed = { enabled:false, side:'workspace', left:null, right:'coding', ratio:previous.ratio };
    renderConfig();
    observe(); schedule();
  }).catch(() => { if (!disposed) showNotice('布局暂不可用，请更新工作台后重试'); });
  renderConfig();
  return () => {
    closeSideSurface();
    disposed = true; revision++; hideAll(); clearCoding(); postNativeDivider(null); if (typeof unsubscribeNativeDivider === 'function') unsubscribeNativeDivider(); doc.body.removeAttribute('data-neko-unified-enabled');
    observer.disconnect(); overlayObserver.disconnect(); resize?.disconnect(); win.removeEventListener('resize', schedule); doc.removeEventListener('scroll', schedule, true); doc.removeEventListener('click', shortcut, true); doc.removeEventListener('neko-unified-open-community', visitCommunity); doc.removeEventListener('neko-collapsed-composer-geometry', schedule); doc.removeEventListener('keydown', escapeConfig);
    doc.removeEventListener('neko-workspace-expand', expandFlexWorkspace);
    doc.removeEventListener('neko-chatroom-mode-change', roomModeChanged);
    doc.removeEventListener('neko-unified-open-config', openConfigFromSettings);
    clearFlex(); flexDivider.remove(); flexTabs.remove(); for (const node of [...Object.values(flexHandles),...Object.values(flexDrops)]) node.remove(); if (typeof unsubscribeFlex === 'function') unsubscribeFlex();
    doc.removeEventListener('neko-side-surface-close', closeSideSurface);
    doc.removeEventListener('neko-video-open', videoOpen);
    doc.removeEventListener('visibilitychange', visibilityChanged); win.removeEventListener('focus', visibilityChanged); if (recoveryTimer) win.clearTimeout(recoveryTimer); if (noticeTimer) win.clearTimeout(noticeTimer);
    for (const p of Object.values(panels)) if (p.noteTimer) win.clearTimeout(p.noteTimer);
    if (frame) (win.cancelAnimationFrame || win.clearTimeout)(frame); if (typeof unsubscribe === 'function') unsubscribe(); if (typeof unsubscribeAccount === 'function') unsubscribeAccount();
    trigger.remove(); config.remove(); mobile.remove(); divider.remove(); notice.remove(); for (const p of Object.values(panels)) p.node.remove(); for (const { zone } of Object.values(drops)) zone.remove(); style.remove();
  };
}
