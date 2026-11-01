// Room navigation and home lifetime are owned by the workspace shell.
function createChatroomPreview(doc, avatar = () => '', options = {}) {
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = el('section', 'neko-chatroom-preview');
  panel.dataset.nekoChatroomPreview = '';
  panel.setAttribute('aria-label', typeof options.onOpenLobby === 'function' ? '聊天室' : '聊天室界面预览');

  const heading = el('div', 'neko-chatroom-preview__heading');
  heading.append(el('h2', '', '聊天室'), el('span', 'neko-chatroom-preview__badge', typeof options.onOpenLobby === 'function' ? '公共频道' : '界面预览'));
  const introduction = el('p', 'neko-chatroom-preview__intro', '和人、AI 一起相遇的地方');

  const search = el('input', 'neko-chatroom-preview__search');
  search.type = 'search';
  search.placeholder = '搜索聊天室';
  search.disabled = true;
  search.setAttribute('aria-label', '搜索聊天室，功能尚未开放');

  const label = el('div', 'neko-chatroom-preview__label', '聊天室');
  if (typeof options.onOpenLobby !== 'function') label.appendChild(el('span', '', '示意'));
  const rooms = el('div', 'neko-chatroom-preview__rooms');
  const addRoom = (name, description, symbol, kind, interactive = false) => {
    const row = el(interactive ? 'button' : 'div', 'neko-chatroom-preview__room');
    if (interactive) row.type = 'button';
    const icon = el('span', 'neko-chatroom-preview__room-icon ' + kind, symbol);
    icon.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'neko-chatroom-preview__room-copy');
    copy.append(el('strong', '', name), el('small', '', description));
    row.append(icon, copy);
    rooms.appendChild(row);
    return row;
  };
  const publicRoom = addRoom('公共聊天室', '一起交流与分享', '✦', 'is-public', typeof options.onOpenLobby === 'function');
  if (options.onOpenLobby) { publicRoom.setAttribute('aria-label', '打开公共聊天室'); publicRoom.addEventListener('click', options.onOpenLobby); }
  const home = addRoom('我的小窝', '进入 Yui 的家', '⌂', 'is-home', true);
  home.setAttribute('aria-label', '进入我的小窝，Yui 的家');

  const empty = el('div', 'neko-chatroom-preview__empty');
  const illustration = el('div', 'neko-chatroom-preview__illustration');
  const portrait = el('img');
  portrait.alt = '';
  portrait.draggable = false;
  const src = avatar('bigfish');
  if (src) portrait.src = src;
  else portrait.hidden = true;
  illustration.append(portrait, el('span', '', '✧'));
  empty.append(illustration, el('strong', '', '期待在这里相遇'), el('p', '', typeof options.onOpenLobby === 'function' ? '点击公共聊天室进入频道，登录与连接状态以频道内显示为准。' : '这里是聊天室的简化展示，聊天功能尚未开放。'));

  const room = el('div', 'neko-chatroom-preview__room-view');
  room.append(heading, introduction, search, label, rooms, empty);
  const homeView = el('section', 'neko-chatroom-preview__home-view');
  homeView.hidden = true;
  homeView.setAttribute('aria-label', 'Yui 的家');
  const header = el('div', 'neko-chatroom-preview__home-header');
  const back = el('button', 'neko-chatroom-preview__home-back', '‹ 返回聊天室');
  back.type = 'button';
  const title = el('h2', '', 'Yui 的家');
  const storage = el('p', 'neko-chatroom-preview__home-storage', '工作台本地存档 · 尚未同步');
  header.append(back, title, storage);
  const status = el('p', 'neko-chatroom-preview__home-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const retry = el('button', 'neko-chatroom-preview__home-retry', '重试');
  retry.type = 'button'; retry.hidden = true;
  const stage = el('div', 'neko-chatroom-preview__home-stage');
  stage.dataset.nekoHomeStage = '';
  homeView.append(header, status, retry, stage);
  let mounted = false, mounting = false, disposed = false, releaseHome = null;
  const mount = async () => {
    if (mounted || mounting || disposed) return;
    mounting = true; retry.hidden = true; status.hidden = false;
    status.textContent = '正在准备家园…'; homeView.setAttribute('aria-busy', 'true');
    try {
      if (typeof options.mountHome !== 'function') throw new Error('家园暂不可用，请稍后重试。');
      const release = await options.mountHome(stage);
      if (disposed) { if (typeof release === 'function') release(); return; }
      releaseHome = typeof release === 'function' ? release : null;
      mounted = true; status.hidden = true;
    } catch (error) {
      if (!disposed) { status.textContent = error?.message || '家园暂不可用，请稍后重试。'; retry.hidden = false; }
    } finally {
      mounting = false; homeView.removeAttribute('aria-busy');
    }
  };
  home.addEventListener('click', () => { room.hidden = true; homeView.hidden = false; back.focus(); void mount(); });
  back.addEventListener('click', () => { homeView.hidden = true; room.hidden = false; home.focus(); });
  retry.addEventListener('click', () => { void mount(); });
  panel.disposeHome = () => { disposed = true; releaseHome?.(); releaseHome = null; };
  panel.append(room, homeView);
  return panel;
}
