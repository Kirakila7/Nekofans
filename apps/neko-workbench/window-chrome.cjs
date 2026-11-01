'use strict';
const HEADER_HEIGHT = 36;
function overlayTheme(dark) {
  return { height: HEADER_HEIGHT, color: dark ? '#17191f' : '#f6f8fc', symbolColor: dark ? '#e5e7eb' : '#344054' };
}
function workbenchWindowChrome(platform = process.platform, dark = false) {
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: overlayTheme(dark), autoHideMenuBar: true };
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } };
  return {};
}
function updateWindowChrome(window, dark, platform = process.platform) {
  if (typeof dark !== 'boolean') throw new TypeError('Window theme must be a boolean');
  if (platform === 'win32' && window && !window.isDestroyed()) {
    const zoom = window.webContents?.getZoomFactor?.() || 1;
    window.setTitleBarOverlay({ ...overlayTheme(dark), height: Math.round(HEADER_HEIGHT * zoom) });
  }
}
function toggleWindowFullscreen(window) {
  if (!window || window.isDestroyed()) throw new Error('Workbench window is unavailable');
  const fullscreen = !window.isFullScreen();
  window.setFullScreen(fullscreen);
  return { fullscreen };
}
module.exports = { HEADER_HEIGHT, workbenchWindowChrome, updateWindowChrome, toggleWindowFullscreen };
