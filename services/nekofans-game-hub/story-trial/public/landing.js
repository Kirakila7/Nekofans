'use strict';

/* 控制台：创建房间、展示三条私密链接、本标签页最近房间。无外部依赖。 */

(() => {
  const $ = (id) => document.getElementById(id);
  const RECENT_KEY = 'nk-recent-rooms';
  const RECENT_LIMIT = 5;
  const SEAT_LABELS = { white: '白方席位', black: '黑方席位', goddess: '女神席（主持人）' };
  const SEAT_HINTS = {
    white: '给白方玩家',
    black: '给黑方玩家',
    goddess: '只给主持人，不要共享屏幕',
  };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.textContent = message;
    $('toastRoot').appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 200ms ease';
      setTimeout(() => node.remove(), 240);
    }, 3600);
  }

  async function copyText(text, label) {
    if (!text) {
      toast('链接不可用', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(label + '已复制', 'ok');
    } catch {
      window.prompt('复制链接：', text);
    }
  }

  function loadRecent() {
    try {
      const raw = sessionStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.slice(0, RECENT_LIMIT) : [];
    } catch {
      return [];
    }
  }

  function saveRecent(list) {
    try {
      sessionStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
    } catch {
      /* ignore */
    }
  }

  function linkRow(seat, url, actions) {
    return (
      '<div class="link-row">' +
      '<div class="lr-head"><span>' + SEAT_LABELS[seat] + '</span>' +
      '<span class="hint">' + SEAT_HINTS[seat] + '</span></div>' +
      '<code>' + esc(url) + '</code>' +
      '<div class="lr-actions">' + (actions || '') + '</div>' +
      '</div>'
    );
  }

  function renderCreated(room) {
    $('linksCard').hidden = false;
    $('createdRoomId').textContent = '房间 ' + room.roomId;
    $('createdLinks').innerHTML = ['white', 'black', 'goddess']
      .map((seat) =>
        linkRow(
          seat,
          room.links[seat],
          '<button class="btn small" data-copy="' + seat + '">复制</button>' +
            '<a class="btn small primary" href="' + esc(room.links[seat]) + '" target="_blank" rel="noopener">打开</a>',
        ),
      )
      .join('');
    $('openGoddessLink').href = room.links.goddess;
  }

  function renderRecent() {
    const list = loadRecent();
    if (!list.length) {
      $('recentCard').hidden = true;
      return;
    }
    $('recentCard').hidden = false;
    $('recentList').innerHTML = list
      .map(
        (room) =>
          '<div class="link-row"><div class="recent-row"><span><strong>' + esc(room.roomId) + '</strong> ' +
          '<span class="hint">' + new Date(room.createdAt).toLocaleString('zh-CN', { hour12: false }) + '</span></span>' +
          '<span class="hint">仅本标签页</span></div>' +
          '<div class="lr-actions">' +
          ['white', 'black', 'goddess']
            .map(
              (seat) =>
                '<a class="btn small" href="' + esc(room.links[seat]) + '" target="_blank" rel="noopener">' +
                (seat === 'goddess' ? '女神' : seat === 'white' ? '白方' : '黑方') + '</a>',
            )
            .join('') +
          '</div></div>',
      )
      .join('');
  }

  async function createRoom(event) {
    event.preventDefault();
    const button = $('createBtn');
    button.disabled = true;
    const hint = $('createHint');
    hint.textContent = '正在创建房间…';
    try {
      const guessLimit = Number($('guessLimit').value);
      const reviewMode = $('reviewMode').checked;
      const scenario = $('scenario').value.trim();
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guessLimit, reviewMode, ...(scenario ? { scenario } : {}) }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '创建失败');
      window.__nkLastRoom = data;
      renderCreated(data);
      const recent = loadRecent().filter((room) => room.roomId !== data.roomId);
      recent.unshift({ roomId: data.roomId, links: data.links, createdAt: Date.now() });
      saveRecent(recent);
      renderRecent();
      hint.textContent = '房间已创建' + (data.scenario ? '（剧情场景 ' + data.scenario + '）' : '') +
        '。请复制三条链接，并先打开女神席审核规则。';
      toast('房间已创建', 'ok');
    } catch (error) {
      hint.textContent = '创建失败：' + error.message;
      toast('创建失败：' + error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  $('createForm').addEventListener('submit', createRoom);

  $('createdLinks').addEventListener('click', (event) => {
    const button = event.target instanceof HTMLElement ? event.target.closest('[data-copy]') : null;
    if (!button) return;
    const room = window.__nkLastRoom;
    if (!room) return;
    const seat = button.dataset.copy;
    copyText(room.links[seat], SEAT_LABELS[seat] + '链接');
  });

  $('copyAllBtn').addEventListener('click', () => {
    const room = window.__nkLastRoom;
    if (!room) return;
    const text = ['white', 'black', 'goddess']
      .map((seat) => SEAT_LABELS[seat] + '：' + room.links[seat])
      .join('\n');
    copyText(text, '三条链接');
  });

  renderRecent();
})();
