// Optional multi-region workspace. Native DSH and each remote site keep their
// own existing document; the controller only changes geometry/visibility.
function installUnifiedLayout(options = {}) {
  const doc = options.document || document, win = options.window || window;
  const bridge = options.bridge || win.nekoWorkbench;
  if (!doc?.body || typeof bridge?.workspace !== 'function' || typeof bridge?.community !== 'function' || doc.querySelector('[data-neko-unified-config]')) return () => {};
  const rail = doc.querySelector('[data-neko-side-rail]');
  if (!rail) return () => {};
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, cls, fn) => { const b = el('button', cls, label); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
  const style = el('style'); style.dataset.nekoUnifiedStyle = ''; style.textContent = options.cssText || ''; doc.head.appendChild(style);
  const SLOT_NAMES = { side: '侧栏', left: '左面板', right: '右面板' };
  const MIN_RATIO = 0.25, MAX_RATIO = 0.75;
  const clampRatio = value => Math.max(MIN_RATIO, Math.min(MAX_RATIO, Number.isFinite(value) ? value : 0.5));
  // Human-readable name of what a slot currently shows; the sidebar's
  // "workspace" is DSH's native navigation, not a second coding surface.
  const describe = (slot, value) => slot === 'side'
    ? ({ workspace: '工作区导航', community: '社区', bilibili: 'B站视频' })[value] || '工作区导航'
    : ({ coding: '工作区', community: '社区', bilibili: 'B站视频' })[value] || '空';
  const trigger = button('▤', 'neko-side-rail__button neko-layout-entry', toggleConfig);
  trigger.title = '配置界面布局'; trigger.setAttribute('aria-label', '配置界面布局'); trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', 'neko-unified-config');
  const container = doc.querySelector('.neko-workspace-rail-controls') || rail;
  container.appendChild(trigger);
  const config = el('section', 'neko-unified-config'); config.dataset.nekoUnifiedConfig = ''; config.hidden = true; config.id = 'neko-unified-config';
  config.setAttribute('role', 'dialog'); config.setAttribute('aria-labelledby', 'neko-unified-config-title'); config.setAttribute('aria-describedby', 'neko-unified-config-help');
  const close = button('×', 'close', () => setConfig(false, true)); close.setAttribute('aria-label', '关闭界面配置'); close.title = '关闭（Esc）';
  const title = el('h2', '', '界面配置'), explanation = el('p', 'help', '① 选一个区域 ② 点选内容，或把内容拖到窗口里的目标区域。选择内容会自动启用自定义布局。');
  title.id = 'neko-unified-config-title'; explanation.id = 'neko-unified-config-help';
  const summary = el('p', 'summary'); summary.dataset.nekoUnifiedSummary = ''; summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  const toggle = button('启用自定义布局', 'toggle', () => update({ ...layout, enabled: !layout.enabled }));
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
  const swap = button('⇄ 交换左右面板', 'toggle', () => update({ ...layout, left: layout.right, right: layout.left }));
  const info = el('p', 'message'); info.setAttribute('role', 'status'); info.setAttribute('aria-live', 'polite');
  config.append(close, title, explanation, summary, toggle, el('strong', '', '显示区域'), targets, el('strong', '', '显示内容'), contents, hint, swap, info);
  doc.body.appendChild(config);
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
  let layout = { enabled: false, side: 'workspace', left: 'coding', right: null, ratio: 0.5 };
  let disposed = false, frame = 0, revision = 0, requestId = 0, codingNode = null, codingInert = false, suspended = false, drag = null, draggedContent = null;
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
    const account = button('连接桌面身份', 'neko-unified-account', () => accountAction(slot));
    account.title = '复用本机 N.E.K.O. 社区账号；未登录时在系统浏览器完成官方授权';
    const leave = button('返回工作区', '', () => chooseFor(slot, 'coding'));
    back.setAttribute('aria-label', '返回上一页'); reload.setAttribute('aria-label', '刷新当前页面');
    play.hidden = share.hidden = account.hidden = true; header.append(name, back, reload, play, share, account, leave);
    const status = el('p', 'status'); status.setAttribute('role', 'status'); node.append(header, status); doc.body.appendChild(node);
    panels[slot] = { node, header, name, titleText, note, back, reload, play, share, account, leave, status, site: null, noteTimer: null };
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
    if (!layout.enabled) return '自定义布局未启用：显示 DSH 原生单栏工作区。选择任一内容即可启用。';
    const parts = ['side', 'left', 'right'].map(slot => `${SLOT_NAMES[slot]}：${describe(slot, layout[slot])}`);
    const two = layout.left && layout.right, left = Math.round(clampRatio(layout.ratio) * 100);
    return '当前 ' + parts.join(' · ') + (two ? `（宽度 ${left}% / ${100 - left}%）` : '');
  }
  function renderConfig() {
    trigger.setAttribute('aria-expanded', String(!config.hidden));
    toggle.textContent = layout.enabled ? '关闭自定义布局（恢复单栏）' : '启用自定义布局';
    toggle.setAttribute('aria-pressed', String(layout.enabled));
    summary.textContent = summaryText(); config.dataset.enabled = String(layout.enabled);
    for (const key of Object.keys(targetButtons)) {
      const shown = describe(key, layout[key]);
      targetButtons[key].setAttribute('aria-pressed', String(key === target));
      targetButtons[key].setAttribute('aria-label', `${SLOT_NAMES[key]}，当前显示${shown}`);
      if (targetCurrent[key].textContent !== shown) targetCurrent[key].textContent = shown;
    }
    const value = target === 'side' && layout.side === 'workspace' ? 'coding' : layout[target] ?? 'none';
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
    if (disposed || config.hidden === !open) return;
    config.hidden = !open; suspended = open && layout.enabled; renderConfig();
    if (open) { info.textContent = ''; clearNotice(); focusFirst(); }
    else if (returnFocus && trigger.isConnected) trigger.focus?.();
    if (suspended) hideAll(); else schedule();
  }
  function toggleConfig() { void setConfig(config.hidden); }
  function clean(next) { return { enabled: !!next.enabled, side: next.side, left: next.left, right: next.right, ratio: next.ratio }; }
  let confirmed = null;
  function applySaved(saved) {
    const enabling = !layout.enabled && saved.enabled;
    layout = clean(saved); confirmed = { ...layout }; renderConfig();
    if (enabling) options.hideLegacy?.();
    if (layout.enabled) doc.body.setAttribute('data-neko-unified-enabled', '');
    else { doc.body.removeAttribute('data-neko-unified-enabled'); hideAll(); clearCoding(); }
    if (layout.enabled && layout.side !== 'workspace') doc.querySelector('.neko-side-rail__expand:not([hidden])')?.click();
    suspended = !config.hidden && layout.enabled; schedule();
  }
  async function update(next, raise = false) {
    const ticket = ++revision;
    try {
      const saved = await bridge.workspace({ action: 'set-pane-layout', layout: clean(next) });
      if (disposed || ticket !== revision) { if (raise) throw Error('界面配置已变化，请重试'); return; }
      info.textContent = ''; applySaved(saved);
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
    const next = { ...layout, enabled: true }, requested = target === 'side' && value === 'coding' ? 'workspace' : value;
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
    if (columns.length < 2 || !Number.isFinite(columns[0]) || !Number.isFinite(columns[1]) || columns[1] < 100) return null;
    const full = { x: bounds.left + columns[0], y: bounds.top, width: columns[1], height: bounds.height };
    if (![full.x, full.y, full.width, full.height].every(Number.isFinite) || full.height < 100) return null;
    let sideBottom = sideRect.bottom;
    const settingsSlot = sidebar.querySelector('[data-slot="sidebar.settings"]') || item.querySelector('[data-slot="sidebar.settings"]');
    const footer = sidebar.querySelector('[data-neko-companion-footer]') || item.querySelector('[data-neko-companion-footer]');
    const dock = sidebar.querySelector('.neko-companion-dock') || item.querySelector('.neko-companion-dock');
    const launcher = sidebar.querySelector('[data-slot="settings.launcher"]') || item.querySelector('[data-slot="settings.launcher"]');
    // The native settings slot may itself be display:contents; its parent is
    // the visible footer containing both the companion and account area.
    for (const node of [settingsSlot?.parentElement, footer, dock, launcher]) {
      const part = node?.getBoundingClientRect();
      if (part && part.height > 0 && part.top > sideRect.top + 60) sideBottom = Math.min(sideBottom, part.top);
    }
    return { frameNode, center, full, side: { x: sideRect.left, y: sideRect.top, width: sideRect.width, height: Math.max(0, sideBottom - sideRect.top) } };
  }
  function clearCoding() {
    if (!codingNode) return;
    codingNode.removeAttribute('data-neko-unified-coding');
    if (!codingInert) codingNode.removeAttribute('inert');
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
  function placePanel(slot, rect, site) {
    const p = panels[slot]; if (!rect || rect.width < 80 || rect.height < 80 || !site) { p.node.hidden = true; closeView(slot); return; }
    p.node.hidden = false;
    const title = site === 'community' ? 'N.E.K.O. 社区' : 'B站视频';
    if (p.titleText.textContent !== title) { p.titleText.textContent = title; p.node.setAttribute('aria-label', `${SLOT_NAMES[slot]}：${title}`); }
    p.play.hidden = p.share.hidden = site !== 'bilibili';
    p.account.hidden = site !== 'community' || typeof bridge.communityAccount !== 'function';
    const boundsStyle = { left: `${Math.round(rect.x)}px`, top: `${Math.round(rect.y)}px`, width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px` };
    for (const [key, value] of Object.entries(boundsStyle)) if (p.node.style[key] !== value) p.node.style[key] = value;
    const bar = Math.max(42, Math.ceil(p.header.getBoundingClientRect().height));
    const targetBounds = { x: rect.x, y: rect.y + bar, width: rect.width, height: rect.height - bar };
    if (targetBounds.height <= 1) { closeView(slot); return; }
    const key = JSON.stringify(targetBounds), current = placements.get(slot);
    if (current !== site) {
      closeView(slot); placements.set(slot, site); panelNote(slot, `正在加载${title}…`, 'loading');
      p.play.disabled = p.share.disabled = true; p.site = site;
      p.account.textContent = '连接桌面身份'; p.account.disabled = site === 'community';
      const ticket = ++requestId; openTickets[slot] = ticket;
      void Promise.resolve(bridge.community({ action: 'open', site, slot, bounds: targetBounds, requestId: ticket })).catch(() => {
        if (!disposed && placements.get(slot) === site && openTickets[slot] === ticket) panelNote(slot, '页面未能打开，请检查网络后点「刷新」', 'error');
      });
    } else if (lastRects[slot] !== key) void Promise.resolve(bridge.community({ action: 'layout', slot, bounds: targetBounds })).catch(() => {});
    lastRects[slot] = key;
  }
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
    if (!layout.enabled) { for (const p of Object.values(panels)) p.node.hidden = true; divider.hidden = mobile.hidden = true; return; }
    if (doc.visibilityState === 'hidden' || suspended || hasOverlay()) {
      hideAll(); for (const p of Object.values(panels)) p.node.hidden = true; divider.hidden = mobile.hidden = true; return;
    }
    const geo = findGeometry();
    if (!geo) { hideAll(); for (const p of Object.values(panels)) p.node.hidden = true; divider.hidden = mobile.hidden = true; clearCoding(); info.textContent = '工作台布局尚未就绪，请展开侧栏后重试。'; return; }
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
      const percent = Math.round(clampRatio(layout.ratio) * 100);
      divider.setAttribute('aria-valuenow', String(percent)); divider.setAttribute('aria-valuetext', `左面板 ${percent}% · 右面板 ${100 - percent}%`);
    }
    for (const slot of ['side', 'left', 'right']) {
      const value = layout[slot];
      const site = value === 'community' || value === 'bilibili' ? value : null;
      if (suspended || slot === 'side' && doc.body.hasAttribute('data-neko-chatroom-active')) { panels[slot].node.hidden = true; closeView(slot); }
      else placePanel(slot, rects[slot], site);
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
  function observe() { const geo = findGeometry(); if (geo && geo.frameNode !== observe.frame) { resize?.disconnect(); resize?.observe(geo.frameNode); resize?.observe(doc.querySelector('[data-slot="sidebar"]')); observe.frame = geo.frameNode; } }
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
  function visibilityChanged() { if (doc.visibilityState === 'hidden') hideAll(); else schedule(); }
  doc.addEventListener('visibilitychange', visibilityChanged); win.addEventListener('focus', visibilityChanged);
  divider.addEventListener('pointerdown', e => { if (e.button !== 0) return; const geo = findGeometry(); if (!geo) return; drag = { pointerId: e.pointerId, left: geo.full.x, width: geo.full.width, started: layout.ratio }; divider.setPointerCapture?.(e.pointerId); divider.dataset.dragging = 'true'; e.preventDefault(); });
  divider.addEventListener('pointermove', e => { if (!drag || drag.pointerId !== e.pointerId) return; layout.ratio = clampRatio((e.clientX - drag.left) / drag.width); schedule(); });
  divider.addEventListener('pointerup', e => { if (!drag || drag.pointerId !== e.pointerId) return; const started = drag.started, moved = Math.abs(layout.ratio - started) >= 0.01; drag = null; divider.removeAttribute('data-dragging'); if (moved) void update(layout); else { layout.ratio = started; schedule(); } });
  divider.addEventListener('pointercancel', e => { if (!drag || drag.pointerId !== e.pointerId) return; layout.ratio = drag.started; drag = null; divider.removeAttribute('data-dragging'); schedule(); });
  divider.addEventListener('dblclick', () => void update({ ...layout, ratio: 0.5 }));
  divider.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.05;
    const next = e.key === 'Home' ? MIN_RATIO : e.key === 'End' ? MAX_RATIO : clampRatio(layout.ratio + (e.key === 'ArrowLeft' ? -step : step));
    void update({ ...layout, ratio: next });
  });
  function shortcut(event) {
    if (!layout.enabled) return;
    const item = event.target.closest?.('.neko-community-yui, .neko-side-rail__bilibili'); if (!item) return;
    event.preventDefault(); event.stopImmediatePropagation();
    target = activeMain; choose(item.classList.contains('neko-side-rail__bilibili') ? 'bilibili' : 'community');
  }
  doc.addEventListener('click', shortcut, true);
  // A companion's community visit must not invoke the legacy single-pane
  // route, which would hide all currently assigned native views. Save the
  // destination first; the visible companion menu is allowed to close before
  // remote loading resumes so no menu/native-view z-order deadlock occurs.
  function visitCommunity(event) {
    const detail = event.detail;
    if (disposed || !layout.enabled || !detail || typeof detail !== 'object') return;
    detail.handled = true;
    const existing = ['side', 'left', 'right'].find(slot => layout[slot] === 'community');
    if (existing) {
      if (existing === 'side') doc.querySelector('.neko-side-rail__expand:not([hidden])')?.click();
      else activeMain = existing;
      schedule(); detail.promise = Promise.resolve(); return;
    }
    const destination = layout.left === 'coding' ? 'right' : layout.right === 'coding' ? 'left' : activeMain;
    activeMain = destination;
    detail.promise = chooseFor(destination, 'community', true);
  }
  doc.addEventListener('neko-unified-open-community', visitCommunity);
  function roomModeChanged() {
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
    if (state.status === 'error') panelNote(state.slot, '页面未能打开，请检查网络后点「刷新」', 'error');
    if (typeof state.canGoBack === 'boolean') p.back.disabled = !state.canGoBack;
    if (typeof state.canShare === 'boolean') p.share.disabled = !state.canShare;
    if (typeof state.canPlayOfficial === 'boolean') p.play.disabled = !state.canPlayOfficial || !!state.isOfficialPlayer;
  });
  if (typeof bridge.subscribeCommunityAccount === 'function') unsubscribeAccount = bridge.subscribeCommunityAccount(paintAccount);
  Promise.resolve(bridge.workspace({ action:'pane-layout' })).then(saved => {
    if (disposed || revision) return;
    layout = confirmed = clean(saved); renderConfig();
    if (layout.enabled) { options.hideLegacy?.(); doc.body.setAttribute('data-neko-unified-enabled',''); }
    observe(); schedule();
  }).catch(() => { if (!disposed) showNotice('布局暂不可用，请更新工作台后重试'); });
  renderConfig();
  return () => {
    disposed = true; revision++; hideAll(); clearCoding(); doc.body.removeAttribute('data-neko-unified-enabled');
    observer.disconnect(); overlayObserver.disconnect(); resize?.disconnect(); win.removeEventListener('resize', schedule); doc.removeEventListener('scroll', schedule, true); doc.removeEventListener('click', shortcut, true); doc.removeEventListener('neko-unified-open-community', visitCommunity); doc.removeEventListener('keydown', escapeConfig);
    doc.removeEventListener('neko-chatroom-mode-change', roomModeChanged);
    doc.removeEventListener('visibilitychange', visibilityChanged); win.removeEventListener('focus', visibilityChanged); if (recoveryTimer) win.clearTimeout(recoveryTimer); if (noticeTimer) win.clearTimeout(noticeTimer);
    for (const p of Object.values(panels)) if (p.noteTimer) win.clearTimeout(p.noteTimer);
    if (frame) (win.cancelAnimationFrame || win.clearTimeout)(frame); if (typeof unsubscribe === 'function') unsubscribe(); if (typeof unsubscribeAccount === 'function') unsubscribeAccount();
    trigger.remove(); config.remove(); mobile.remove(); divider.remove(); notice.remove(); for (const p of Object.values(panels)) p.node.remove(); for (const { zone } of Object.values(drops)) zone.remove(); style.remove();
  };
}
