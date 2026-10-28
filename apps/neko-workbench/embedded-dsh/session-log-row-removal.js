// Hide the Session Log upload preference without changing the stored setting.
function installSessionLogRowRemoval(doc = document) {
  if (!doc.documentElement || !doc.head || typeof MutationObserver !== 'function') return () => {};
  const marked = new Set();
  const style = doc.createElement('style');
  style.textContent = '[data-neko-hide-session-log-row] { display: none !important; }';
  doc.head.appendChild(style);
  const titles = new Set([
    '在使用官方模型 API 时上传 Session Log',
    'Upload Session Log when using the official model API',
  ]);
  function sync() {
    const selected = new Set();
    for (const heading of doc.querySelectorAll('div')) {
      if (heading.children.length || !titles.has(heading.textContent.trim())) continue;
      const row = heading.parentElement?.parentElement;
      if (row?.querySelector('[role="switch"], input[type="checkbox"]')) selected.add(row);
    }
    for (const node of marked) if (!selected.has(node)) { node.removeAttribute('data-neko-hide-session-log-row'); marked.delete(node); }
    for (const node of selected) if (!marked.has(node)) { node.setAttribute('data-neko-hide-session-log-row', ''); marked.add(node); }
  }
  const observer = new MutationObserver(sync);
  observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
  sync();
  return () => {
    observer.disconnect();
    for (const node of marked) node.removeAttribute('data-neko-hide-session-log-row');
    style.remove();
  };
}

