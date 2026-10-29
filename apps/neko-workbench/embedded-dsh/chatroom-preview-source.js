// A visual placeholder only: this component does not connect to a service or
// create a conversation. Navigation and lifetime are owned by workspace shell.
function createChatroomPreview(doc, avatar = () => '') {
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = el('section', 'neko-chatroom-preview');
  panel.dataset.nekoChatroomPreview = '';
  panel.setAttribute('aria-label', '聊天室界面预览');

  const heading = el('div', 'neko-chatroom-preview__heading');
  heading.append(el('h2', '', '聊天室'), el('span', 'neko-chatroom-preview__badge', '界面预览'));
  const introduction = el('p', 'neko-chatroom-preview__intro', '和人、AI 一起相遇的地方');

  const search = el('input', 'neko-chatroom-preview__search');
  search.type = 'search';
  search.placeholder = '搜索聊天室';
  search.disabled = true;
  search.setAttribute('aria-label', '搜索聊天室，功能尚未开放');

  const label = el('div', 'neko-chatroom-preview__label', '聊天室');
  label.appendChild(el('span', '', '示意'));
  const rooms = el('div', 'neko-chatroom-preview__rooms');
  const addRoom = (name, description, symbol, kind) => {
    const row = el('div', 'neko-chatroom-preview__room');
    const icon = el('span', 'neko-chatroom-preview__room-icon ' + kind, symbol);
    icon.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'neko-chatroom-preview__room-copy');
    copy.append(el('strong', '', name), el('small', '', description));
    row.append(icon, copy);
    rooms.appendChild(row);
  };
  addRoom('公共聊天室', '一起交流与分享', '✦', 'is-public');
  addRoom('我的小窝', '与伙伴们相聚', '⌂', 'is-home');

  const empty = el('div', 'neko-chatroom-preview__empty');
  const illustration = el('div', 'neko-chatroom-preview__illustration');
  const portrait = el('img');
  portrait.alt = '';
  portrait.draggable = false;
  const src = avatar('bigfish');
  if (src) portrait.src = src;
  else portrait.hidden = true;
  illustration.append(portrait, el('span', '', '✧'));
  empty.append(illustration, el('strong', '', '期待在这里相遇'), el('p', '', '这里是聊天室的简化展示，聊天功能尚未开放。'));

  panel.append(heading, introduction, search, label, rooms, empty);
  return panel;
}
