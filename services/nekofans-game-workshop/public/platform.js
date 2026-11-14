import { createRoomAgent } from './room-agent.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let roomId = params.get('room');
const communityTicket = new URLSearchParams(location.hash.slice(1)).get('communitySeat');
if (communityTicket) history.replaceState(null, '', location.pathname + location.search);
let gameId = params.get('game'), game, seat, snapshot, socket, reconnect, stopped = false, pending = false, frameReady = false, channel;
let projects = [];
let publishEnabled = false;
let toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500); }
async function api(url, body, key) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制，可以发到聊天室了'); }
  catch {
    const box = document.createElement('textarea'); box.value = text; box.readOnly = true; box.style.position = 'fixed'; box.style.top = '0'; document.body.append(box); box.select();
    if (document.execCommand('copy')) { box.remove(); toast('已复制，可以发到聊天室了'); }
    else { toast('请复制页面上选中的链接或提示词'); box.onblur = () => box.remove(); }
  }
}
const keyFor = id => 'nekofans:game-room:' + id;
const communityEntry = document.createElement('button');
communityEntry.type = 'button';
communityEntry.id = 'enter-community-room';
communityEntry.className = 'primary';
communityEntry.hidden = true;
$('enter-room').after(communityEntry);
function seatTarget() {
  return roomId ? { operation: 'join', target: roomId } : { operation: 'create', target: gameId };
}
function openSeat(value) {
  seat = value;
  roomId = seat.id;
  if (!seat.community) {
    try { localStorage.setItem(keyFor(roomId), JSON.stringify(seat)); } catch {}
  }
  history.replaceState(null, '', '?room=' + roomId);
  stopped = false;
  connect();
}
async function startCommunity() {
  communityEntry.disabled = true;
  try {
    const { url } = await api('/api/community/seat/start', seatTarget());
    location.assign(url);
  } catch (error) {
    toast(error.message);
    communityEntry.disabled = false;
  }
}
communityEntry.onclick = startCommunity;
function paintProject(cover, project) {
  cover.dataset.scene = project?.title.startsWith('蘑菇岛') ? 'mushroom' : project?.mode === 'turns' ? 'turns' : 'shared';
}
function modeLabel(project) { return project.mode === 'turns' ? '轮流操作' : '共同操作'; }
function showProject(project) {
  $('room-project-name').textContent = project.title;
  $('room-project-meta').textContent = modeLabel(project);
  paintProject($('room-art'), project);
}
function renderProjects() {
  const list = $('project-list');
  const cards = projects.map(project => {
    const card = document.createElement('a');
    card.className = 'project-card';
    card.href = '/?game=' + project.id;
    const cover = document.createElement('div');
    cover.className = 'project-cover';
    cover.setAttribute('aria-hidden', 'true');
    cover.append(document.createElement('span'));
    paintProject(cover, project);
    const details = document.createElement('div');
    details.className = 'project-details';
    const title = document.createElement('h2');
    title.textContent = project.title;
    const mode = document.createElement('p');
    mode.textContent = '2 人 · ' + modeLabel(project);
    details.append(title, mode);
    const arrow = document.createElement('span');
    arrow.className = 'project-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    details.append(arrow);
    card.append(cover, details);
    return card;
  });
  list.replaceChildren(...cards);
  $('project-empty').textContent = '暂无项目';
  $('project-empty').hidden = Boolean(cards.length);
  $('room-project-select').replaceChildren(...projects.map(project => new Option(project.title, project.id)));
}
async function loadProjects() {
  ({ projects } = await api('/api/games'));
  renderProjects();
}
function homeView() {
  if (roomId || gameId) return;
  const view = location.hash === '#rooms' ? 'rooms' : location.hash === '#publish' && publishEnabled ? 'publish' : 'projects';
  for (const name of ['projects', 'rooms', 'publish']) {
    $(name).hidden = name !== view;
    if (name === view) $(name + '-nav').setAttribute('aria-current', 'page');
    else $(name + '-nav').removeAttribute('aria-current');
  }
}
addEventListener('hashchange', homeView);
$('join-form').onsubmit = event => {
  event.preventDefault();
  const value = $('join-code').value.trim();
  let id = value;
  if (!/^[\w-]{12}$/.test(id)) {
    try {
      const url = new URL(value);
      const parts = [...url.searchParams];
      if (url.origin === location.origin && url.pathname === '/' && !url.username && !url.password && !url.hash && parts.length === 1 && parts[0][0] === 'room') id = parts[0][1];
    } catch {}
  }
  if (!/^[\w-]{12}$/.test(id)) return toast('请输入这个工坊的邀请链接或 12 位房间号。');
  location.assign('/?room=' + id);
};
function roomCommand(message) {
  if (socket?.readyState !== WebSocket.OPEN || pending) return;
  pending = true;
  $('start-game').disabled = true;
  $('room-project-select').disabled = true;
  socket.send(JSON.stringify(message));
}
$('room-project-select').onchange = event => roomCommand({ type: 'project', gameId: event.target.value });
$('start-game').onclick = () => roomCommand({ type: 'start' });
function randomId() { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function post(type, extra = {}) { if (frameReady) $('game-frame').contentWindow.postMessage({ nekofans: 1, channel, type, ...extra }, '*'); }
function updateFrame() { if (snapshot && seat) post('snapshot', { state: snapshot, player: seat.player, connected: socket?.readyState === WebSocket.OPEN, agentActive: roomAgent.active }); }
function submitGameAction(message) {
  if (pending || socket?.readyState !== WebSocket.OPEN || !snapshot) { post('error', { error: '请等待同步完成' }); return false; }
  const text = JSON.stringify({ type: 'action', actionId: randomId(), version: snapshot.version, action: message.action, endTurn: message.endTurn !== false });
  if (text.length > 6000) { post('error', { error: '单次操作过大' }); return false; }
  pending = true;
  socket.send(text);
  return true;
}
const roomAgent = createRoomAgent({
  button: $('game-agent'), settings: $('agent-settings'), options: $('agent-options'), model: $('agent-model'), teammate: $('agent-teammate'),
  refresh: $('agent-refresh'), modelStatus: $('agent-model-status'), post, submit: submitGameAction, onControl: updateFrame, notify: toast,
  readRoom() {
    if (!snapshot || !seat) return null;
    const connected = !stopped && socket?.readyState === WebSocket.OPEN;
    const playing = snapshot.phase === 'playing';
    return { id: seat.id, token: seat.token, player: seat.player, account: seat.community, phase: snapshot.phase, version: snapshot.version, connected,
      canPlay: playing && connected && !pending && snapshot.players.length === 2 && snapshot.online.every(Boolean) && (snapshot.game.mode === 'shared' || snapshot.turn === seat.player) };
  },
});
function showFrame() {
  if (channel) return;
  channel = randomId(); frameReady = false;
  $('game-shell').classList.add('is-playing');
  $('game-frame').src = '/play/' + gameId + '#' + channel;
  $('game-frame').hidden = false; $('game-placeholder').hidden = true;
  setTimeout(() => { if (!frameReady) toast('游戏尚未接入联机模板：请用页面提供的提示词补入 NekofansGame 接口'); }, 7000);
}
addEventListener('message', event => {
  if (event.source !== $('game-frame').contentWindow || event.data?.nekofans !== 1 || event.data.channel !== channel) return;
  const message = event.data;
  if (message.type === 'ready') { frameReady = true; updateFrame(); roomAgent.ready(message.agent === true); }
  if (message.type === 'game-error') toast('游戏代码需要调整：' + String(message.error).slice(0, 140));
  if (message.type === 'agent-result') roomAgent.result(message);
  if (message.type === 'action') {
    if (message.agentRequestId) roomAgent.action(message);
    else if (!roomAgent.active) submitGameAction(message);
  }
});
function renderRoom() {
  if (!snapshot) return;
  const playing = snapshot.phase === 'playing';
  const host = seat.player === 0;
  const everyoneOnline = snapshot.players.length === 2 && snapshot.online.every(Boolean);
  $('entry-panel').hidden = true;
  $('room-panel').hidden = false;
  $('rooms-nav').setAttribute('aria-current', 'page');
  $('play-title').textContent = playing ? snapshot.game.title : '游戏房间';
  showProject(snapshot.game);
  $('room-title').textContent = playing && snapshot.game.mode === 'turns' ? (snapshot.turn === seat.player ? '你的回合' : '对方回合') : '成员';
  $('room-count').textContent = snapshot.players.length + ' / 2';
  const waiting = snapshot.players.length < 2 ? '等待朋友加入' : everyoneOnline ? (host ? '' : '等待房主开局') : '等待玩家上线';
  $('room-start-hint').textContent = playing ? '' : waiting;
  $('room-project-control').hidden = playing || !host;
  $('room-project-name').hidden = !playing && host;
  $('room-project-select').disabled = pending || playing;
  if (![...$('room-project-select').options].some(option => option.value === snapshot.gameId)) {
    $('room-project-select').add(new Option(snapshot.game.title, snapshot.gameId));
  }
  $('room-project-select').value = snapshot.gameId;
  $('start-game').hidden = playing || !host;
  $('start-game').disabled = pending || !everyoneOnline || playing || !host;
  $('new-room').hidden = !playing;
  const fragment = document.createDocumentFragment();
  for (let player = 0; player < 2; player++) {
    const member = snapshot.players[player];
    const row = document.createElement('div'); row.className = 'player';
    row.dataset.state = member ? (snapshot.online[player] ? 'online' : 'offline') : 'empty';
    const avatar = document.createElement('span'); avatar.className = 'player-avatar'; avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = member ? (player === 0 ? '✦' : '●') : '+';
    const name = document.createElement('strong'); name.textContent = member?.name || '空位';
    row.append(avatar, name);
    if (member && (player === 0 || player === seat.player)) {
      const tag = document.createElement('span'); tag.className = 'player-tag';
      tag.textContent = player === 0 && player === seat.player ? '你 · 房主' : player === 0 ? '房主' : '你';
      row.append(tag);
    }
    if (member) {
      const status = document.createElement('span'); status.className = 'player-presence';
      const label = snapshot.online[player] ? '在线' : '离线';
      status.setAttribute('aria-label', label); status.setAttribute('role', 'img'); status.title = label;
      row.append(status);
    }
    fragment.append(row);
  }
  $('players').replaceChildren(fragment);
  $('new-room').href = '/?game=' + gameId;
  if (playing) { showFrame(); updateFrame(); roomAgent.wake(); }
}
function connectionStatus(message) {
  $('status').textContent = message;
  $('status').parentElement.hidden = !message;
}
function connect() {
  if (stopped) return;
  clearTimeout(reconnect); connectionStatus('连接中');
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${seat.id}/socket`);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: seat.token }));
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') {
      pending = false; toast(message.error); post('error', { error: message.error });
      if (message.status === 401 || message.status === 404) {
        stopped = true;
        roomAgent.stop();
        if (!seat.community) {
          try {
            if (JSON.parse(localStorage.getItem(keyFor(seat.id)))?.token === seat.token) localStorage.removeItem(keyFor(seat.id));
          } catch {}
        }
        $('entry-panel').hidden = false; $('room-panel').hidden = true;
      }
      return;
    }
    const changed = !snapshot || snapshot.version !== message.version || snapshot.online.some((online, player) => online !== message.online[player]);
    pending = false; snapshot = message; gameId = message.gameId; connectionStatus(''); renderRoom();
    if (changed) roomAgent.updated();
  };
  socket.onclose = event => {
    pending = false; connectionStatus('正在重连');
    roomAgent.stop();
    $('start-game').disabled = true; $('room-project-select').disabled = true; updateFrame();
    if (event.code === 1008 || event.code === 4001) { stopped = true; connectionStatus(event.code === 4001 ? '这个席位已在另一个窗口打开' : '请重新进入房间'); }
    else if (!stopped) reconnect = setTimeout(connect, 1800);
  };
}
$('enter-room').onclick = async () => {
  $('enter-room').disabled = true;
  try {
    openSeat(await api(roomId ? `/api/rooms/${roomId}/join` : '/api/rooms', { gameId, name: $('player-name').value }));
  } catch (error) { toast(error.message); } finally { $('enter-room').disabled = false; }
};
$('copy-invite').onclick = () => copy(`${location.origin}/?room=${seat.id}`);
$('html-file').onchange = () => { const file = $('html-file').files[0]; $('file-name').textContent = file?.name || '选择 HTML'; if (!$('game-title').value && file) $('game-title').value = file.name.replace(/\.html?$/i, ''); };
$('publish-form').onsubmit = async event => {
  event.preventDefault(); const file = $('html-file').files[0]; if (!file || file.size > 512 * 1024) return toast('请选择不超过 512 KB 的 HTML 文件');
  $('publish-button').disabled = true;
  try {
    const html = await file.text();
    if (!html.includes('NekofansGame.connect')) return toast('这个 HTML 还没有联机接口。先复制提示词，让 DeepSeek 为它加入双人联机模板。');
    const published = await api('/api/games', { title: $('game-title').value, mode: $('game-mode').value, html }, $('publish-key').value);
    const link = location.origin + '/?game=' + published.id;
    $('published').hidden = false; $('published-link').textContent = link; $('published-link').href = link; $('open-game').href = link; $('copy-game').onclick = () => copy(link); toast('已发布');
    void loadProjects().catch(() => {});
  } catch (error) { toast(error.message); } finally { $('publish-button').disabled = false; }
};
$('copy-prompt').onclick = async () => { try { const response = await fetch('/generation-guide.md'); await copy(await response.text()); } catch { toast('提示词读取失败，请重试'); } };
$('demo').onclick = async () => { try { const demo = await api('/api/demo', {}); location.href = '/?game=' + demo.id; } catch (error) { toast(error.message); } };
try {
  const config = await api('/api/config'); $('demo').hidden = !config.demo;
  roomAgent.configure(config.gameAgent === true);
  publishEnabled = config.publishEnabled;
  $('publish-nav').hidden = !publishEnabled;
  homeView();
  await loadProjects().catch(() => { $('project-empty').textContent = '暂时无法加载项目，请刷新重试。'; });
  if (roomId || gameId) {
    $('home').hidden = true; $('play').hidden = false;
    communityEntry.hidden = !config.communitySeats || Boolean(roomId);
    const accountLabel = config.accountSeatLabel || 'N.E.K.O.';
    communityEntry.textContent = '用 ' + accountLabel + ' 账号' + (roomId ? '加入' : '建房');
    let communityRoom = false;
    if (roomId) {
      $('entry-title').textContent = '加入房间'; $('enter-room').textContent = '加入';
      $('play-title').textContent = '游戏邀请';
      communityRoom = (await api('/api/rooms/' + encodeURIComponent(roomId))).community;
      if (communityRoom) {
        communityEntry.hidden = !config.communitySeats;
        $('player-name').closest('label').hidden = true;
        $('enter-room').hidden = true;
        if (!config.communitySeats) { $('entry-copy').textContent = '账号入座暂不可用'; $('entry-copy').hidden = false; }
      } else {
        try { seat = JSON.parse(localStorage.getItem(keyFor(roomId))); } catch {}
      }
    } else { game = await api('/api/games/' + gameId); $('play-title').textContent = game.title; showProject(game); }
    if (communityTicket && config.communitySeats) {
      openSeat(await api('/api/community/seat', { ...seatTarget(), ticket: communityTicket }));
    } else if (seat?.id === roomId) connect();
    else if (communityRoom && config.communitySeats) await startCommunity();
  }
} catch (error) { toast(error.message); }
