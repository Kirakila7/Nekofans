const status = document.querySelector('#status');
window.nativeTrial.onStatus(event => {
  if (event.type === 'error' || event.type === 'restore-error') status.textContent = event.message;
  if (event.type === 'attached') {
    status.textContent = '客户端窗口已挂载，请使用外层窗口控制';
    document.querySelector('#native-controls-cover').style.display = 'flex';
  }
  if (event.type === 'detached') {
    status.textContent = event.restored ? '客户端已弹出，原窗口按钮已还原' : '客户端已退出';
    document.querySelector('#native-controls-cover').style.display = 'none';
  }
  if (event.type === 'captured') status.textContent = '截图已保存在试验目录';
});
for (const button of document.querySelectorAll('button')) button.addEventListener('click', async () => {
  try { await window.nativeTrial.action(button.dataset.action); }
  catch (error) { status.textContent = error.message; }
});
