// Installed only in the authenticated workbench. The coding DOM and drafts stay mounted.
(() => {
  if (window.__nekoScreenShareHost || typeof window.nekoWorkbench?.screenShare !== 'function') return;
  window.__nekoScreenShareHost = true;
  document.addEventListener('click', event => {
    const control = event.target.closest?.('button,a,[role="row"],[role="menuitem"]');
    if (!control || control.dataset?.workbenchAction === 'screen-share'
      || (control.classList.contains('neko-action') && control.textContent?.trim() === '屏幕陪伴')) return;
    if (control.closest('[data-neko-side-rail],[data-slot="sidebar"],.neko-role-host,.neko-strip,nav[data-neko-tools]')) void window.nekoWorkbench.screenShare('hide').catch(() => {});
  }, true);
})();
