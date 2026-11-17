'use strict';
const { randomUUID } = require('node:crypto');

function createWorkshopWindow({ BrowserWindow }) {
  let window, epoch = 0;
  function close() {
    epoch++;
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  }

  async function open({ url, cookie }) {
    const origin = new URL(url).origin;
    if (window && !window.isDestroyed() && new URL(window.webContents.getURL() || url).origin !== origin) close();
    if (!window || window.isDestroyed()) {
      const created = new BrowserWindow({
        width: 1180, height: 820, minWidth: 720, minHeight: 540, show: false,
        title: 'Nekofans · 游戏工坊', backgroundColor: '#101b2c',
        webPreferences: {
          partition: 'neko-game-workshop-' + randomUUID(), sandbox: true, contextIsolation: true, nodeIntegration: false,
          webSecurity: true, webviewTag: false,
        },
      });
      window = created;
      const contents = created.webContents;
      created.once('closed', () => { if (window === created) window = null; });
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-attach-webview', event => event.preventDefault());
      const restrict = (event, destination) => {
        try {
          const target = new URL(destination);
          if (target.origin === origin && target.pathname === '/' && !target.username && !target.password) return;
        } catch {}
        event.preventDefault();
      };
      contents.on('will-navigate', restrict);
      contents.on('will-redirect', restrict);
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
    }
    const active = window, version = ++epoch;
    if (cookie) {
      await active.webContents.session.cookies.set({
        url: origin + '/api', name: cookie.name, value: cookie.value, path: '/api',
        httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax',
      });
    }
    if (active.isDestroyed() || version !== epoch) throw Error('游戏窗口已关闭。');
    if (active.webContents.getURL() !== url) await active.loadURL(url);
    if (active.isDestroyed() || version !== epoch) throw Error('游戏窗口已关闭。');
    active.show();
    active.focus();
  }

  return Object.freeze({ open, close });
}

module.exports = { createWorkshopWindow };
