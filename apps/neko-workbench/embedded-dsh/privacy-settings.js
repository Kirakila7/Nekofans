// Keep the native upload control in place, behind a visible privacy disclosure.
function installPrivacySettings(doc = document) {
  const Observer = doc.defaultView?.MutationObserver;
  if (!doc.documentElement || !doc.head || !Observer) return () => {};
  const rows = new Map(), cards = new Set();
  const titles = new Map([
    ['在使用官方模型 API 时上传 Session Log', 'zh'],
    ['Upload Session Log when using the official model API', 'en'],
  ]);
  const cardSelector = 'section._6qcDqa_section > ._6qcDqa_card, section._6qcDqa_section > ._6qcDqa_balanceCard';
  const style = doc.createElement('style');
  style.dataset.nekoPrivacyStyle = '';
  style.textContent = `
    .neko-settings-account-card { display: none !important; }
    [data-neko-privacy-collapsed="true"] { display: none !important; }
    .neko-privacy-settings { margin: 12px 0 0; }
    .neko-privacy-settings > button {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px;
      border: 1px solid var(--dsw-alias-border-l1, #d3dee9); border-radius: 8px;
      background: var(--dsw-alias-bg-layer-1, transparent);
      color: var(--dsw-alias-label-primary, inherit); font: inherit;
      text-align: left; cursor: pointer;
    }
    .neko-privacy-settings > button::before { content: '▸'; }
    .neko-privacy-settings > button[aria-expanded="true"]::before { content: '▾'; }
    .neko-privacy-settings > button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2c66a6); outline-offset: 2px; }
    .neko-privacy-status { margin-left: auto; color: var(--dsw-alias-label-secondary, inherit); font-size: 12px; }
  `;
  doc.head.appendChild(style);
  let disposed = false, queued = false, nextId = 0;
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function render(record, control, language) {
    record.button.setAttribute('aria-expanded', String(record.expanded));
    record.row.setAttribute('data-neko-privacy-collapsed', String(!record.expanded));
    text(record.label, language === 'en' ? 'Privacy / advanced settings' : '隐私 / 高级设置');
    const checked = control.matches('input[type="checkbox"]') ? String(control.checked) : control.getAttribute('aria-checked');
    const state = language === 'en' ? checked === 'true' ? 'on' : checked === 'false' ? 'off' : 'unknown'
      : checked === 'true' ? '已开启' : checked === 'false' ? '已关闭' : '状态待确认';
    text(record.status, (language === 'en' ? 'Session Log upload: ' : '会话日志上传：') + state);
  }
  function release(record) {
    record.header.remove();
    record.row.removeAttribute('data-neko-privacy-collapsed');
    if (record.ownedId && record.row.id === record.ownedId) record.row.removeAttribute('id');
  }
  function create(row) {
    const header = doc.createElement('div'), button = doc.createElement('button');
    const label = doc.createElement('span'), status = doc.createElement('span');
    header.className = 'neko-privacy-settings';
    button.type = 'button';
    status.className = 'neko-privacy-status';
    status.setAttribute('aria-live', 'polite');
    let ownedId = null;
    if (!row.id) {
      do { ownedId = 'neko-privacy-setting-' + ++nextId; } while (doc.getElementById(ownedId));
      row.id = ownedId;
    }
    button.setAttribute('aria-controls', row.id);
    button.append(label, status); header.appendChild(button);
    const record = { row, header, button, label, status, ownedId, expanded: false };
    button.addEventListener('click', () => {
      record.expanded = !record.expanded;
      if (!record.expanded && row.contains(doc.activeElement)) button.focus();
      sync();
    });
    return record;
  }
  function sync() {
    queued = false;
    if (disposed) return;
    const found = new Map();
    // Inspect switch rows, rather than walking every div in a streaming chat.
    for (const control of doc.querySelectorAll('[role="switch"], input[type="checkbox"]')) {
      let candidate = control.parentElement;
      for (let depth = 0; candidate && depth < 3; depth++, candidate = candidate.parentElement) {
        const heading = Array.from(candidate.querySelectorAll('div')).find(node =>
          !node.children.length && titles.has(node.textContent.trim()) && node.parentElement?.parentElement === candidate);
        if (heading) { found.set(candidate, { control, language: titles.get(heading.textContent.trim()) }); break; }
      }
    }
    for (const [row, record] of rows) if (!found.has(row)) { release(record); rows.delete(row); }
    for (const [row, value] of found) {
      let record = rows.get(row);
      if (!record) { record = create(row); rows.set(row, record); }
      if (record.header.parentNode !== row.parentNode || record.header.nextSibling !== row) row.before(record.header);
      render(record, value.control, value.language);
    }
    const selected = new Set(doc.querySelectorAll(cardSelector));
    for (const card of cards) if (!selected.has(card)) { card.classList.remove('neko-settings-account-card'); cards.delete(card); }
    for (const card of selected) if (!cards.has(card)) { card.classList.add('neko-settings-account-card'); cards.add(card); }
  }
  function schedule() {
    if (disposed || queued) return;
    queued = true; Promise.resolve().then(sync);
  }
  const observer = new Observer(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['aria-checked', 'checked'] });
  doc.addEventListener('change', schedule, true);
  doc.addEventListener('click', schedule, true);
  sync();
  return () => {
    disposed = true; observer.disconnect();
    doc.removeEventListener('change', schedule, true); doc.removeEventListener('click', schedule, true);
    for (const record of rows.values()) release(record);
    for (const card of cards) card.classList.remove('neko-settings-account-card');
    rows.clear(); cards.clear(); style.remove();
  };
}
