'use strict';

// A shared profile must never be opened twice. A failed process check is an
// unknown state, not permission to start a second host.
function sharedProfileStatus(readProcesses, sharedProfile) {
  try {
    const lines = readProcesses().split('\n');
    return lines.some(line => line.includes('dsh-desktop-host/lib/index.js') && line.includes(sharedProfile) ||
      line.includes('dsh-desktop-host/lib/cli.js --profile desktop') || line.includes('/dsh-shared-desktop-host.cjs')) ? 'busy' : 'free';
  } catch { return 'unknown'; }
}

function claimWorkbenchInstance(app, userData) {
  // The installed main process uses the same userData before taking the lock.
  // Electron notifies that process via second-instance if this returns false.
  app.setPath('userData', userData);
  return app.requestSingleInstanceLock();
}

function queueEarlyInstanceNotifications(app) {
  let pending = false;
  const early = () => { pending = true; if (app.isReady?.()) app.focus?.({ steal: true }); };
  app.on('second-instance', early);
  return {
    forward() {
      app.removeListener('second-instance', early);
      // The main process has now synchronously registered its listener.
      if (pending) { pending = false; void app.whenReady().then(() => app.emit('second-instance', {}, [], process.cwd(), {})); }
    },
    discard() { pending = false; app.removeListener('second-instance', early); },
  };
}

async function waitForSharedProfile({ readProcesses, sharedProfile, showMessageBox }) {
  for (;;) {
    const status = sharedProfileStatus(readProcesses, sharedProfile);
    if (status === 'free') return true;
    const result = await showMessageBox({
      type: 'info',
      message: status === 'busy' ? '工作台使用的账号配置正被占用' : '暂时无法检查工作台的共享配置',
      detail: status === 'busy'
        ? '原版 DSH 或另一个工作台可能正在使用同一份账号、插件和会话。请先确认任务已结束并正常退出占用程序，再点“重试”。工作台不会自动结束任何任务。'
        : '为了保护账号和会话，工作台暂不启动。请检查系统权限后重试。',
      buttons: ['重试', '退出'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (result.response !== 0) return false;
  }
}
module.exports = { sharedProfileStatus, waitForSharedProfile, claimWorkbenchInstance, queueEarlyInstanceNotifications };
