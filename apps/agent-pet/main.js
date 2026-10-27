const api = window.dshPet;
const el = (id) => document.getElementById(id);
const statuses = { running: '工作中', idle: '空闲', success: '已完成', stopped: '已停止', unavailable: '请在 DSH 查看' };
const clips = { running: '工作状态-思考冒泡.webm', idle: '待机呼吸休闲.webm', success: '待机呼吸休闲.webm', celebrating: '工作状态-雀跃庆祝.webm', stopped: '工作状态-垂头叹气冒汗.webm', unavailable: '待机呼吸休闲.webm', dragging: '被鼠标拖拽悬空反馈.webm' };
let snapshot;
let currentClip;
let drag;
let moved = false;
let celebrating = false;
let noticeTimer;
function state() { return !snapshot?.connected ? 'unavailable' : celebrating ? 'celebrating' : snapshot.agent.status; }
function clip(state) {
  const next = '/assets/dsh-pet/' + encodeURIComponent(clips[state] || clips.idle);
  if (currentClip === next) return;
  currentClip = next;
  el('video').loop = state !== 'celebrating';
  el('video').src = next;
  el('video').play().catch(() => {});
}
function render(value) {
  if (value.rename) { el('rename').hidden = false; el('nickname').value = snapshot?.agent.name || ''; el('nickname').focus(); return; }
  if (snapshot?.connected && snapshot.agent.status === 'running' && value.agent.status === 'success' && value.connected) {
    celebrating = true;
    el('notice').hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el('notice').hidden = true; }, 6000);
  } else if (value.agent.status !== 'success' || !value.connected) celebrating = false;
  snapshot = value;
  el('pet').setAttribute('aria-label', '打开 ' + value.agent.name + ' 的输入框');
  el('status').textContent = value.connected ? (statuses[value.agent.status] || '请在 DSH 查看') : 'DSH 连接中断';
  el('task').textContent = '任务：' + value.agent.name;
  el('work').textContent = '工作：' + (value.agent.task || statuses[value.agent.status] || '请在 DSH 查看');
  el('last').textContent = '你上一条：' + (value.lastMessage || '暂无');
  el('send').disabled = value.busy || !value.connected || value.agent.mode !== 'continuable';
  el('input').disabled = value.agent.mode !== 'continuable';
  el('input').placeholder = value.agent.mode === 'continuable' ? '继续这个任务…' : '此类子代理请在 DSH 中操作';
  el('error').textContent = value.error || '';
  el('error').hidden = !value.error;
  if (value.error) { el('dialog').hidden = false; el('hint').hidden = true; }
  if (!drag) clip(state());
}
api.onSnapshot(render);
api.command({ type: 'snapshot' });
el('video').addEventListener('loadeddata', () => { el('fallback').hidden = true; });
el('video').addEventListener('error', () => { el('fallback').hidden = false; });
el('video').addEventListener('ended', () => { celebrating = false; if (!drag) clip(state()); });
el('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = el('input').value;
  if (!text.trim()) return;
  el('send').disabled = true;
  const reply = await api.command({ type: 'send', text }).catch(() => ({ ok: false }));
  if (reply.ok && el('input').value === text) el('input').value = '';
  el('send').disabled = !snapshot?.connected || snapshot?.agent.mode !== 'continuable';
  el('input').focus();
});
el('open').onclick = () => api.command({ type: 'open' });
el('hide').onclick = () => { el('dialog').hidden = true; };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { el('dialog').hidden = true; el('rename').hidden = true; } });
el('rename').onsubmit = async (event) => {
  event.preventDefault();
  const reply = await api.command({ type: 'rename', name: el('nickname').value });
  if (reply.ok) el('rename').hidden = true;
};
el('rename-cancel').onclick = () => { el('rename').hidden = true; };
el('pet').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { startX: event.screenX, startY: event.screenY, x: event.screenX, y: event.screenY };
  moved = false;
  api.command({ type: 'drag-start', screen_x: event.screenX, screen_y: event.screenY });
  el('pet').setPointerCapture(event.pointerId);
});
el('pet').addEventListener('pointermove', (event) => {
  if (!drag) return;
  if (!moved && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) < 4) return;
  moved = true;
  clip('dragging');
  api.command({ type: 'drag-move', screen_x: event.screenX, screen_y: event.screenY });
  drag.x = event.screenX; drag.y = event.screenY;
});
el('pet').addEventListener('pointerup', () => {
  if (!drag) return;
  drag = null;
  api.command({ type: 'drag-end' });
  if (snapshot) clip(state());
});
el('pet').addEventListener('click', () => {
  if (moved) { moved = false; return; }
  el('dialog').hidden = !el('dialog').hidden;
  el('hint').hidden = true;
  if (!el('dialog').hidden) el('input').focus();
});
el('pet').addEventListener('lostpointercapture', () => { if (drag) api.command({ type: 'drag-end' }); drag = null; if (snapshot) clip(state()); });
el('pet').addEventListener('pointerenter', () => { if (el('dialog').hidden) el('hint').hidden = false; });
el('pet').addEventListener('pointerleave', () => { el('hint').hidden = true; });
let inside = false;
document.addEventListener('pointermove', (event) => {
  const next = !!drag || !!event.target.closest('button,input,#dialog,#rename');
  if (next !== inside) { inside = next; api.command({ type: 'hit', inside }); }
});
document.addEventListener('pointerleave', () => { if (drag) return; inside = false; api.command({ type: 'hit', inside: false }); });
