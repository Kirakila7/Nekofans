'use strict';

/*
 * Nekofans 双子棋局 · 浏览器端
 *
 * 只渲染服务端按席位投影后的状态；不持有对手规则、不自行判定胜负。
 * 私密令牌只存在本标签页 sessionStorage，并在进入页面后从地址栏移除。
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const FILES = 'abcdefgh';
  const PIECE_GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const PIECE_NAMES = { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' };
  const SEAT_NAME = { white: '白方', black: '黑方' };
  const COLOR_NAME = { w: '白方', b: '黑方' };
  const PHASE_TEXT = { lobby: '准备中', playing: '对局中', paused: '已暂停', finished: '已结束' };
  const PHASE_CLASS = { lobby: 'phase-lobby', playing: 'phase-playing', paused: 'phase-paused', finished: 'phase-finished' };
  const RULE_STATUS_TEXT = {
    empty: '未提交',
    submitted: '已封存 · 等待女神确认',
    active: '已生效',
    returned: '被女神退回 · 可修改重交',
    revealed: '已揭晓',
  };
  const RULE_STATUS_CLASS = { empty: 'muted', submitted: 'pending', active: 'ok', returned: 'bad', revealed: 'ok' };
  const GUESS_STATUS_TEXT = {
    pending: '等待女神裁定',
    correct: '猜中 · 获胜',
    wrong: '未命中',
    void: '作废',
  };
  const GUESS_STATUS_CLASS = { pending: 'pending', correct: 'ok', wrong: 'bad', void: 'muted' };
  const REASON_TEXT = {
    checkmate: '将死',
    stalemate: '逼和',
    'insufficient-material': '子力不足',
    'fifty-move': '五十回合规则',
    'threefold-repetition': '三次重复局面',
    'seventy-five-move': '七十五回合规则',
    'fivefold-repetition': '五次重复局面',
    guess: '猜中隐藏规则',
    resign: '认输',
    goddess: '女神裁定',
    agreement: '双方协议',
    abort: '对局中止',
    timeout: '超时',
    special: '特殊终局',
  };

  const roomMatch = location.pathname.match(/^\/room\/([a-z0-9-]+)$/);
  const ROOM_ID = roomMatch ? roomMatch[1] : null;
  const TOKEN_KEY = 'nk-token:' + ROOM_ID;
  const NOTES_KEY = 'nk-notes:' + ROOM_ID;

  const S = {
    roomId: ROOM_ID,
    token: null,
    role: null,
    seat: null,
    latest: null,
    es: null,
    connected: false,
    selected: null,
    promotion: null,
    busy: false,
    shownRejectionAt: null,
    noteTimer: null,
    ruleDraft: null,
    ruleDraftDirty: false,
    goddessDrafts: {
      ruleText: {},
      ruleNote: {},
      guessNote: {},
      editNote: '',
      endNote: '',
      announce: '',
    },
    dirty: {
      ruleText: {},
      ruleNote: {},
      guessNote: {},
      editNote: false,
      endNote: false,
      announce: false,
    },
    specialType: null,
    specialFrom: null,
    fieldDrafts: {},
    fieldDirty: {},
    showLinks: false,
    secrecy: false,
    lastDecision: null,
  };

  // ---------------- 基础工具 ----------------

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function fmtTime(timestamp) {
    if (!timestamp) return '';
    try {
      return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
      return '';
    }
  }

  function seatName(seat) {
    return SEAT_NAME[seat] || '—';
  }

  function phaseText(phase) {
    return PHASE_TEXT[phase] || phase;
  }

  function pill(text, cls) {
    return '<span class="pill ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  function resultText(result) {
    if (!result) return '';
    const winner = result.winner === 'draw' ? '和棋' : seatName(result.winner) + '胜';
    return '对局结束 · ' + winner + '（' + (REASON_TEXT[result.reason] || result.reason) + '）';
  }

  // 公开行动的类型文案只来自服务端按席位投影，静态脚本不内置任何一方能力文本。
  function specialItem(type) {
    const state = S.latest;
    const list = state && state.game && state.game.story && state.game.story.special;
    return (Array.isArray(list) ? list : []).find((item) => item.type === type) || null;
  }

  function specialLabel(type) {
    const item = specialItem(type);
    return item && item.label ? item.label : '公开行动';
  }

  function specialGlyph(type) {
    const item = specialItem(type);
    return item && item.glyph ? item.glyph : '·';
  }

  function storyEventText(event) {
    if (!event || !event.kind) return '';
    // 公开事件只描述棋盘变化，不命名任何一方的能力、目标名字或原因。
    if (event.kind === 'board-change') {
      if (event.change === 'piece-removed') {
        return event.square ? '棋盘变化：' + event.square + ' 的棋子消失' : '棋盘变化：有棋子消失';
      }
      return '棋盘变化';
    }
    return '棋盘变化';
  }

  function toast(message, kind) {
    const root = $('toastRoot');
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.textContent = message;
    root.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 200ms ease';
      setTimeout(() => node.remove(), 240);
    }, kind === 'error' ? 5200 : 3200);
  }

  function fatal(title, message) {
    $('boot').hidden = true;
    $('fatal').hidden = false;
    $('fatalTitle').textContent = title;
    $('fatalMessage').textContent = message;
  }

  function setConnected(connected) {
    S.connected = connected;
    $('connChip').classList.toggle('on', connected);
    $('connChip').classList.toggle('off', !connected);
    $('connText').textContent = connected ? '已连接' : '重连中…';
  }

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(method, path, body) {
    if (!S.token) throw new ApiError(401, 'missing_token', '缺少访问令牌');
    const separator = path.includes('?') ? '&' : '?';
    const url = '/api/rooms/' + encodeURIComponent(S.roomId) + path + separator + 'token=' + encodeURIComponent(S.token);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (error) {
      throw new ApiError(0, 'network', '无法连接本地服务，请确认 node server.js 仍在运行');
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 401) {
      fatal('访问令牌无效', '请从控制台重新复制席位链接打开；不要把不同席位的链接混用。');
    }
    if (!response.ok || !data || data.ok === false) {
      throw new ApiError(
        response.status,
        (data && data.code) || 'error',
        (data && data.error) || '请求失败（HTTP ' + response.status + '）',
      );
    }
    return data;
  }

  async function playerAction(path, body) {
    if (S.busy) return false;
    S.busy = true;
    let ok = false;
    try {
      const data = await api('POST', path, body || {});
      if (data.state) applyState(data.state);
      ok = true;
    } catch (error) {
      toast(error.message || '操作失败', 'error');
    } finally {
      S.busy = false;
      render();
    }
    return ok;
  }

  async function goddessAction(action, body) {
    if (S.busy) return;
    S.busy = true;
    try {
      const data = await api('POST', '/goddess/' + action, body || {});
      if (data.state) applyState(data.state);
    } catch (error) {
      toast(error.message || '操作失败', 'error');
    } finally {
      S.busy = false;
      render();
    }
  }

  async function refreshState() {
    try {
      const data = await api('GET', '/state');
      applyState(data.state);
      setConnected(true);
    } catch (error) {
      if (error.status !== 401) toast(error.message || '刷新失败', 'error');
    }
  }

  // ---------------- 启动与推送 ----------------

  // 页面脚本错误可见化：便于本地排查，也避免"静默失败"
  window.addEventListener('error', (event) => {
    const message = event && event.message ? String(event.message) : '未知脚本错误';
    (window.__nkErrors = window.__nkErrors || []).push(message);
    toast('页面脚本错误：' + message, 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const message = event && event.reason ? String(event.reason.message || event.reason) : '未知异步错误';
    (window.__nkErrors = window.__nkErrors || []).push(message);
  });

  function readToken() {
    let token = null;
    try {
      token = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      token = null;
    }
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      token = fromUrl;
      try {
        sessionStorage.setItem(TOKEN_KEY, fromUrl);
      } catch {
        /* ignore */
      }
      params.delete('token');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }
    return token;
  }

  function connectStream() {
    if (S.es) S.es.close();
    const url = '/api/rooms/' + encodeURIComponent(S.roomId) + '/stream?token=' + encodeURIComponent(S.token);
    const source = new EventSource(url);
    S.es = source;
    source.addEventListener('state', (event) => {
      try {
        const state = JSON.parse(event.data);
        applyState(state);
      } catch (error) {
        (window.__nkErrors = window.__nkErrors || []).push('SSE applyState: ' + String(error && error.message || error));
      }
    });
    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));
  }

  function applyState(state) {
    if (!state) return;
    S.latest = state;
    S.role = state.role;
    S.seat = state.seat;
    document.body.dataset.role = state.role;
    $('boot').hidden = true;
    $('app').hidden = false;
    $('playerView').hidden = state.role !== 'player';
    const goddessView = $('goddessView');
    if (goddessView) goddessView.hidden = state.role !== 'goddess';
    if (S.selected && state.game) {
      const stillMine = state.game.legalMoves.some((move) => move.from === S.selected);
      if (!stillMine) S.selected = null;
    }
    // 玩家/大肥鱼页面不需要女神视图；加载后移除其静态机密标签，避免 DOM 泄露 B 的能力名。
    if (state.role !== 'goddess') {
      const goddessView = document.getElementById('goddessView');
      if (goddessView) goddessView.remove();
    }
    const specialActions = state.me && state.me.story ? state.me.story.specialActions : [];
    if (S.specialType && !specialActions.some((action) => action.type === S.specialType)) {
      S.specialType = null;
      S.specialFrom = null;
    }
    if (S.specialFrom && !specialActions.some((action) => action.type === S.specialType && action.from === S.specialFrom)) {
      S.specialFrom = null;
    }
    render();
    const rejection = state.me && state.me.lastRejection;
    if (rejection && rejection.at !== S.shownRejectionAt) {
      S.shownRejectionAt = rejection.at;
      toast('女神驳回了你的走子：' + rejection.label + '\n' + rejection.reason, 'error');
    }
  }

  // ---------------- 棋盘 ----------------

  function seatPair() {
    if (S.role === 'goddess') return { top: 'black', bottom: 'white', flip: false };
    if (S.seat === 'black') return { top: 'white', bottom: 'black', flip: true };
    return { top: 'black', bottom: 'white', flip: false };
  }

  function parseBoard(fen) {
    const placement = String(fen || '').split(' ')[0];
    const board = {};
    let rank = 8;
    let file = 0;
    for (const ch of placement) {
      if (ch === '/') {
        rank -= 1;
        file = 0;
      } else if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else if (PIECE_GLYPHS[ch.toLowerCase()]) {
        if (file < 8 && rank >= 1) {
          board[FILES[file] + rank] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' };
        }
        file += 1;
      }
    }
    return board;
  }

  function isPlayerInteractive(state) {
    if (state.role !== 'player') return false;
    if (state.phase !== 'playing') return false;
    if (!state.me) return false;
    if (state.me.canMove) return true;
    return Boolean(state.me.story && state.me.story.canSpecial);
  }

  function isGoddessInteractive(state) {
    return (
      state.role === 'goddess' &&
      state.phase === 'playing' &&
      !state.game.pendingMove &&
      !state.game.result &&
      state.game.legalMoves.length > 0
    );
  }

  function renderBoard() {
    const boardEl = $('board');
    if (!S.latest) return;
    const state = S.latest;
    const game = state.game;
    const board = parseBoard(game.fen);
    const { flip } = seatPair();
    const interactive = isPlayerInteractive(state) || isGoddessInteractive(state);
    const legal = game.legalMoves || [];
    const story = state.role === 'player' && state.me ? state.me.story : null;
    const specialActions = story ? story.specialActions || [] : [];
    const specialMode = Boolean(S.specialType && story);
    const activeSpecial = specialMode
      ? specialActions.filter((action) => action.type === S.specialType)
      : [];
    const specialSources = new Set(activeSpecial.map((action) => action.from));
    const specialTargets = new Map();
    if (specialMode && S.specialFrom) {
      for (const action of activeSpecial) {
        if (action.from !== S.specialFrom) continue;
        if (!specialTargets.has(action.to)) specialTargets.set(action.to, []);
        specialTargets.get(action.to).push(action);
      }
    }
    const selectedMoves = !specialMode && S.selected ? legal.filter((move) => move.from === S.selected) : [];
    const targetMap = new Map();
    for (const move of selectedMoves) {
      if (!targetMap.has(move.to)) targetMap.set(move.to, []);
      targetMap.get(move.to).push(move);
    }
    const last = game.lastMove;
    const checkSquare = game.inCheck && board ? kingSquareOf(board, game.turn) : null;
    const fragment = document.createDocumentFragment();

    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const rank = flip ? row + 1 : 8 - row;
        const fileIndex = flip ? 7 - col : col;
        const square = FILES[fileIndex] + rank;
        const cell = board[square];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'square ' + ((fileIndex + rank) % 2 === 1 ? 'dark' : 'light');
        button.dataset.square = square;
        button.setAttribute('aria-label', square + (cell ? ' ' + COLOR_NAME[cell.color] + PIECE_NAMES[cell.type] : ' 空格'));
        if (interactive) button.classList.add('can-move');
        if (!interactive) button.disabled = true;
        if (last && (last.from === square || last.to === square)) button.classList.add('last');
        if (checkSquare === square) button.classList.add('check');
        if (specialMode) {
          if (specialSources.has(square)) button.classList.add('special-source');
          if (S.specialFrom === square) button.classList.add('special-selected');
          if (specialTargets.has(square)) {
            button.classList.add('target', 'special-target');
            if (cell) button.classList.add('capture');
          }
        } else {
          if (S.selected === square) button.classList.add('selected');
          if (targetMap.has(square)) {
            button.classList.add('target');
            const mover = board[S.selected];
            const isCapture = Boolean(cell) || (mover && mover.type === 'p' && S.selected[0] !== square[0]);
            if (isCapture) button.classList.add('capture');
          }
        }
        if (cell) {
          const glyph = document.createElement('span');
          glyph.className = 'piece ' + cell.color;
          glyph.textContent = PIECE_GLYPHS[cell.type];
          button.appendChild(glyph);
        }
        if (row === 7) {
          const fileLabel = document.createElement('span');
          fileLabel.className = 'file-label';
          fileLabel.textContent = FILES[fileIndex];
          button.appendChild(fileLabel);
        }
        if (col === 0) {
          const rankLabel = document.createElement('span');
          rankLabel.className = 'rank-label';
          rankLabel.textContent = String(rank);
          button.appendChild(rankLabel);
        }
        fragment.appendChild(button);
      }
    }
    boardEl.innerHTML = '';
    boardEl.appendChild(fragment);
    boardEl.dataset.live = interactive ? 'true' : 'false';

    // 覆盖层：待裁决 / 暂停
    const lock = $('pendingLock');
    const pending = game.pendingMove;
    if (pending && state.phase === 'playing') {
      lock.hidden = false;
      $('pendingTitle').textContent = '等待女神裁决';
      const own = S.seat && pending.seat === S.seat;
      $('pendingDetail').textContent = own
        ? '你提交了 ' + pending.label + '，等待女神确认。'
        : seatName(pending.seat) + '提交了 ' + pending.label + '，等待女神确认。';
      $('cancelPendingBtn').hidden = !own;
    } else if (state.phase === 'paused') {
      lock.hidden = false;
      $('pendingTitle').textContent = '对局已暂停';
      $('pendingDetail').textContent = '等待女神继续。';
      $('cancelPendingBtn').hidden = true;
    } else {
      lock.hidden = true;
    }
  }

  function kingSquareOf(board, color) {
    for (const [square, cell] of Object.entries(board)) {
      if (cell.type === 'k' && cell.color === color) return square;
    }
    return null;
  }

  function onBoardClick(square) {
    const state = S.latest;
    if (!state || S.busy) return;
    if (state.role === 'goddess') {
      goddessBoardClick(square);
      return;
    }
    if (!isPlayerInteractive(state)) return;
    const story = state.me && state.me.story;
    if (story && S.specialType) {
      handleSpecialClick(square, story);
      return;
    }
    const legal = state.game.legalMoves;
    if (S.selected) {
      const from = S.selected;
      const candidates = legal.filter((move) => move.from === from && move.to === square);
      if (candidates.length) {
        if (candidates.some((move) => move.promotion)) {
          showPromotion(from, square, candidates, 'player');
        } else {
          S.selected = null;
          submitMove(from, square, null);
        }
        return;
      }
    }
    if (legal.some((move) => move.from === square)) {
      S.selected = S.selected === square ? null : square;
      renderBoard();
      return;
    }
    S.selected = null;
    renderBoard();
  }

  function handleSpecialClick(square, story) {
    const actions = (story.specialActions || []).filter((action) => action.type === S.specialType);
    if (S.specialFrom) {
      const candidates = actions.filter((action) => action.from === S.specialFrom && action.to === square);
      if (candidates.length) {
        if (candidates.some((action) => action.promotion)) {
          showPromotion(S.specialFrom, square, candidates, 'special', { type: S.specialType });
        } else {
          submitSpecial(S.specialType, S.specialFrom, square, null);
        }
        return;
      }
    }
    if (actions.some((action) => action.from === square)) {
      S.specialFrom = S.specialFrom === square ? null : square;
      renderBoard();
      return;
    }
    toast('该格没有可用的公开走法起点或落点', 'error');
  }

  function goddessBoardClick(square) {
    const state = S.latest;
    if (!isGoddessInteractive(state)) return;
    const legal = state.game.legalMoves;
    if (S.selected) {
      const candidates = legal.filter((move) => move.from === S.selected && move.to === square);
      if (candidates.length) {
        if (candidates.some((move) => move.promotion)) {
          showPromotion(S.selected, square, candidates, 'force');
        } else {
          forceMove(S.selected, square, null);
        }
        return;
      }
    }
    if (legal.some((move) => move.from === square)) {
      S.selected = S.selected === square ? null : square;
    } else {
      S.selected = null;
    }
    renderBoard();
  }

  function showPromotion(from, to, candidates, mode, context) {
    S.promotion = { from, to, mode, ...(context || {}) };
    const state = S.latest;
    const moverColor = state.game.turn;
    const choices = $('promotionChoices');
    choices.innerHTML = '';
    for (const type of ['q', 'r', 'b', 'n']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = '升变为' + PIECE_NAMES[type];
      button.setAttribute('aria-label', '升变为' + PIECE_NAMES[type]);
      const glyph = document.createElement('span');
      glyph.className = 'piece ' + moverColor;
      glyph.textContent = PIECE_GLYPHS[type];
      button.appendChild(glyph);
      button.addEventListener('click', () => {
        const promotionContext = S.promotion || {};
        hidePromotion();
        if (mode === 'force') forceMove(from, to, type);
        else if (mode === 'special') submitSpecial(promotionContext.type, from, to, type);
        else submitMove(from, to, type);
      });
      choices.appendChild(button);
    }
    $('promotion').hidden = false;
  }

  function hidePromotion() {
    S.promotion = null;
    $('promotion').hidden = true;
  }

  async function submitMove(from, to, promotion) {
    const moveFrom = from;
    const moveTo = to;
    S.selected = null;
    if (S.busy) return;
    S.busy = true;
    renderBoard();
    try {
      const data = await api('POST', '/move', { from: moveFrom, to: moveTo, promotion: promotion || null });
      applyState(data.state);
    } catch (error) {
      toast(error.message || '走子失败', 'error');
      renderBoard();
    } finally {
      S.busy = false;
      render();
    }
  }

  async function forceMove(from, to, promotion) {
    const label = (from || '') + ' → ' + (to || '') + (promotion ? '=' + promotion.toUpperCase() : '');
    if (!window.confirm('确认由女神代走：' + label + '？')) {
      S.selected = null;
      renderBoard();
      return;
    }
    S.selected = null;
    if (S.busy) return;
    S.busy = true;
    renderBoard();
    const note = (S.goddessDrafts.editNote || '').trim();
    try {
      const data = await api('POST', '/goddess/force-move', {
        from,
        to,
        promotion: promotion || null,
        note: note || undefined,
      });
      applyState(data.state);
    } catch (error) {
      toast(error.message || '代走失败', 'error');
      renderBoard();
    } finally {
      S.busy = false;
      render();
    }
  }

  async function submitSpecial(type, from, to, promotion) {
    S.specialType = null;
    S.specialFrom = null;
    S.selected = null;
    if (S.busy) return;
    S.busy = true;
    renderBoard();
    try {
      const data = await api('POST', '/special', {
        type: type,
        from,
        to,
        promotion: promotion || null,
      });
      applyState(data.state);
      toast('公开走法已生效', 'ok');
    } catch (error) {
      toast(error.message || '公开走法失败', 'error');
    } finally {
      S.busy = false;
      render();
    }
  }

  async function submitPrivateAction() {
    const state = S.latest;
    const privateAction = state && state.me && state.me.story && state.me.story.privateAction;
    if (!privateAction || !privateAction.endpoint) return;
    const target = $('privateTarget').value.trim().toLowerCase();
    const name = $('privateValue').value.trim();
    if (S.busy) return;
    if (!/^[a-h][1-8]$/.test(target)) {
      toast('目标格格式应如 e1', 'error');
      return;
    }
    if (!name) {
      toast('请输入一个值', 'error');
      return;
    }
    if (!window.confirm(privateAction.confirm || '确认提交一次私密行动？')) return;
    S.busy = true;
    try {
      // 端点/文案由服务端按席位下发；静态脚本不硬编码该席位的具体动作。
      const data = await api('POST', privateAction.endpoint, { target, name });
      applyState(data.state);
      toast(data.result === 'success' ? '私密行动已生效' : '私密行动未生效', data.result === 'success' ? 'ok' : 'error');
    } catch (error) {
      toast(error.message || '私密行动提交失败', 'error');
    } finally {
      S.busy = false;
      render();
    }
  }

  async function submitTeammateGuess() {
    const text = $('teammateGuessInput').value.trim();
    if (!text) return;
    if (S.busy) return;
    if (!window.confirm('当前未接入真实模型。将以 A 席位提交这段人工代填的猜测，是否继续？')) return;
    S.busy = true;
    try {
      const data = await api('POST', '/teammate/guess', { text });
      applyState(data.state);
      $('teammateGuessInput').value = '';
      $('teammateGuessCounter').textContent = '0 / 300';
      toast('已以 A 席位提交猜测', 'ok');
    } catch (error) {
      toast(error.message || '提交猜测失败', 'error');
    } finally {
      S.busy = false;
      render();
    }
  }

  async function requestTeammateDecision() {
    const state = S.latest;
    const info = state && state.me && state.me.teammate;
    if (!info || !info.available) {
      toast('未接入真实模型/受控适配器', 'error');
      return;
    }
    if (S.busy) return;
    if (!window.confirm('调用受控决策适配器？服务端会再次校验席位、版本、回合和动作；失败不会自动走子。')) return;
    S.busy = true;
    try {
      const data = await api('POST', '/teammate/decide', {});
      S.lastDecision = {
        decision: data.decision || null,
        applied: Boolean(data.applied),
        pending: Boolean(data.pending),
        adapter: data.adapter || null,
      };
      applyState(data.state);
      const kind = data.decision && data.decision.kind;
      const text = kind === 'guess'
        ? '受控适配器提出一次猜测'
        : (kind === 'special' ? '受控适配器选择了一次公开行动' : '受控适配器选择了一步走子');
      toast(text + (data.pending ? '（待女神核准）' : '，已应用'), 'ok');
    } catch (error) {
      S.lastDecision = { error: error.message || '决策失败' };
      toast(error.message || '受控决策失败', 'error');
    } finally {
      S.busy = false;
      render();
    }
  }

  async function savePrivateField(square) {
    const nameInput = document.querySelector('[data-field="private-value"][data-square="' + square + '"]');
    const aliasInput = document.querySelector('[data-field="public-mark"][data-square="' + square + '"]');
    const name = nameInput ? nameInput.value.trim() : '';
    const alias = aliasInput ? aliasInput.value.trim() : '';
    if (!name) {
      toast('私密字段不能为空；如需清空请暂时保留旧值', 'error');
      return;
    }
    try {
      const data = await api('POST', '/goddess/private-field', { square, name, alias });
      delete S.fieldDrafts[square];
      delete S.fieldDirty[square];
      applyState(data.state);
      toast('私密字段已保存', 'ok');
    } catch (error) {
      toast(error.message || '保存私密字段失败', 'error');
    }
  }

  function toggleSeatLinks() {
    S.showLinks = !S.showLinks;
    renderGoddessView();
  }

  function applySecrecyUi() {
    document.body.dataset.secrecy = S.secrecy ? 'on' : 'off';
    const button = $('secrecyBtn');
    if (button) {
      button.textContent = S.secrecy ? '录屏遮罩：开' : '录屏遮罩：关';
      button.classList.toggle('on', S.secrecy);
    }
    const banner = $('secrecyBanner');
    const isGoddess = Boolean(S.latest && S.latest.role === 'goddess');
    if (banner) banner.hidden = !(S.secrecy && isGoddess);
  }

  function toggleSecrecy() {
    S.secrecy = !S.secrecy;
    if (S.secrecy) S.showLinks = false;
    applySecrecyUi();
    renderHeader();
    renderGoddessView();
  }

  // ---------------- 渲染：顶栏 / 玩家条 / 行棋提示 ----------------

  function renderHeader() {
    const state = S.latest;
    $('roomChip').textContent = '房间 ' + state.roomId;
    const phaseChip = $('phaseChip');
    phaseChip.textContent = phaseText(state.phase);
    phaseChip.className = 'chip ' + (PHASE_CLASS[state.phase] || '');
    const roleChip = $('roleChip');
    if (state.role === 'goddess') {
      roleChip.textContent = '女神席 · 主持人';
    } else {
      roleChip.textContent = seatName(state.seat) + '席位 · 你执' + (state.seat === 'white' ? '白' : '黑');
    }
    const secrecyBtn = $('secrecyBtn');
    if (secrecyBtn) secrecyBtn.hidden = state.role !== 'goddess';
    if (state.role !== 'goddess') S.secrecy = false;
    applySecrecyUi();
  }

  function renderPlayerBars() {
    const state = S.latest;
    const { top, bottom } = seatPair();
    for (const [prefix, seat] of [['top', top], ['bottom', bottom]]) {
      const color = seat === 'white' ? 'w' : 'b';
      $(prefix + 'Dot').className = 'side-dot' + (color === 'b' ? ' black' : '');
      $(prefix + 'Name').textContent = seatName(seat);
      const isSelf = state.role === 'player' && state.seat === seat;
      $(prefix + 'SelfTag').hidden = !isSelf;
      const player = state.players[seat];
      const tags = [];
      tags.push(pill(player.connected ? '在线' : '离线', player.connected ? 'ok' : 'muted'));
      const rule = player.rule;
      const shownStatus = state.revealed[seat] ? 'revealed' : rule.status;
      tags.push(pill(ruleLabelShort(shownStatus), RULE_STATUS_CLASS[shownStatus] || 'muted'));
      if (player.guess.pending) tags.push(pill('猜测等待中', 'pending'));
      $(prefix + 'Tags').innerHTML = tags.join('');
    }
  }

  function ruleLabelShort(status) {
    if (status === 'empty') return '规则未交';
    if (status === 'submitted') return '规则待审';
    if (status === 'returned') return '规则退回';
    if (status === 'active') return '规则生效';
    if (status === 'revealed') return '规则揭晓';
    return status;
  }

  function renderTurnLine() {
    const state = S.latest;
    const game = state.game;
    const line = $('turnLine');
    if (state.phase === 'lobby') {
      const white = state.players.white.rule.status;
      const black = state.players.black.rule.status;
      line.innerHTML = '等待双方提交规则并获女神确认 · 白方 ' +
        pill(ruleLabelShort(white), RULE_STATUS_CLASS[white] || 'muted') + ' 黑方 ' +
        pill(ruleLabelShort(black), RULE_STATUS_CLASS[black] || 'muted');
      return;
    }
    if (state.phase === 'paused') {
      line.textContent = '对局已暂停 · 等待女神继续';
      return;
    }
    if (state.phase === 'finished') {
      line.textContent = '本局已结束';
      return;
    }
    if (game.pendingMove) {
      line.innerHTML = '等待女神裁决：' + esc(seatName(game.pendingMove.seat)) +
        ' ' + esc(game.pendingMove.label);
      return;
    }
    const turnSeat = game.turn === 'w' ? 'white' : 'black';
    let text;
    if (state.role === 'player') {
      text = state.seat === turnSeat ? '轮到你走子（' + seatName(turnSeat) + '）' : '等待' + seatName(turnSeat) + '走子';
    } else {
      text = seatName(turnSeat) + '行棋中 · 当前有 ' + game.legalMoves.length + ' 个合法走法';
    }
    if (game.inCheck) text += ' · 将军！';
    line.textContent = text;
  }

  function renderResultBanner() {
    const state = S.latest;
    const banner = $('resultBanner');
    if (state.phase !== 'finished' || !state.game.result) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    const result = state.game.result;
    banner.className = 'result-banner' + (result.winner === 'draw' ? ' draw' : '');
    const reason = state.role === 'goddess' && state.goddess && state.goddess.resultLabel
      ? state.goddess.resultLabel
      : (REASON_TEXT[result.reason] || result.reason);
    let html = result.winner === 'draw' ? '和棋 · ' + esc(reason) : seatName(result.winner) + '胜 · ' + esc(reason);
    if (result.note) html += '<span class="sub">' + esc(result.note) + '</span>';
    banner.innerHTML = html;
  }

  function renderBoardHint() {
    const state = S.latest;
    const hint = $('boardHint');
    if (state.role === 'player' && state.me && state.me.story && S.specialType) {
      hint.textContent = S.specialFrom
        ? '公开走法：起点 ' + S.specialFrom + ' 已选中，请点落点；点击走法类型可取消。'
        : '公开走法：请先在棋盘上点起点，再点落点；点击走法类型可取消。';
      return;
    }
    if (state.phase === 'lobby') {
      hint.textContent = state.role === 'goddess' ? '先审核双方规则，规则都生效后才能开始对局。' : '等待女神确认双方规则后开始。';
      return;
    }
    if (state.phase === 'finished') {
      hint.textContent = state.revealed.white || state.revealed.black
        ? '棋盘已冻结，揭晓的规则见右侧。'
        : '本局已结束，棋盘已冻结。';
      return;
    }
    if (state.phase === 'paused') {
      hint.textContent = '对局暂停中。';
      return;
    }
    if (state.game.pendingMove) {
      hint.textContent = '这一步尚未生效，等待女神处理。';
      return;
    }
    if (state.role === 'player') {
      if (!state.me.canMove) {
        hint.textContent = '等待对方走子。';
      } else {
        hint.textContent = '点击自己的棋子查看合法落点，再点目标格走子。';
      }
    } else {
      hint.textContent = '女神视角：点棋子 → 目标格可代走一步（会二次确认）。';
    }
  }

  function renderMoveStrip() {
    const strip = $('moveStrip');
    const moves = S.latest.game.moves || [];
    if (!moves.length) {
      strip.innerHTML = '<span class="empty">尚无走子</span>';
      return;
    }
    const parts = [];
    for (let index = 0; index < moves.length; index += 2) {
      const whiteMove = moves[index];
      const blackMove = moves[index + 1];
      const number = index / 2 + 1;
      const renderMove = (move) => {
        if (!move) return '';
        if (!move) return '';
        const last = move === moves[moves.length - 1];
        return '<span class="mv' + (last ? ' last' : '') + (move.by === 'goddess' ? ' goddess' : '') + '">' + esc(move.label) + '</span>';
      };
      parts.push(
        '<span class="move-pair"><span class="num">' + number + '.</span>' +
          renderMove(whiteMove) + renderMove(blackMove) + '</span>',
      );
    }
    strip.innerHTML = parts.join('');
    strip.scrollLeft = strip.scrollWidth;
  }

  // ---------------- 渲染：玩家视图 ----------------

  function renderStoryCard() {
    const state = S.latest;
    if (!state || state.role !== 'player') return;
    const card = $('storyCard');
    const story = state.me && state.me.story;
    const publicStory = state.game.story;
    if (!story || !publicStory || !publicStory.enabled) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    // 本方能力文案由服务端在验证席位后下发；静态脚本不内置任何能力文案/解释。
    $('storyStatus').innerHTML = '你的能力：' + pill(story.abilityLabel || '本席私密能力', 'ok') + ' ' + pill(phaseText(state.phase), 'muted');
    $('storyAbilityHelp').textContent = story.abilityHelp || '';

    const special = publicStory.special || [];
    $('specialCount').textContent = special.length ? special.length + ' 种' : '空';
    $('specialList').innerHTML = special.length
      ? special.map((item) => {
          const active = S.specialType === item.type;
          const disabled = !story.canSpecial && !active;
          return '<button type="button" class="special-chip' + (active ? ' active' : '') + '"' +
            ' data-action="special-pattern" data-type="' + esc(item.type) + '"' +
            (disabled ? ' disabled' : '') + ' title="公开行动">' +
            '<span class="glyph">' + esc(item.glyph || '·') + '</span>' +
            '<span>' + esc(item.label || '公开行动') + '</span></button>';
        }).join('')
      : '<span class="hint">暂无公开行动；有棋子退场后会出现可用行动。</span>';

    let hint;
    if (S.specialType && S.specialFrom) hint = '已选择起点 ' + S.specialFrom + '，请在棋盘上点落点；再次点击行动类型取消。';
    else if (S.specialType) hint = '已选择「' + specialLabel(S.specialType) + '」公开行动：在棋盘上先点起点，再点落点；再次点击行动类型取消。';
    else if (state.phase === 'finished') hint = '本局已结束；公开行动池仅供复盘。';
    else if (!special.length) hint = '暂无公开行动。';
    else if (!story.canSpecial) hint = '等待轮到你时才能使用公开行动。';
    else hint = '选择一种公开行动，然后在棋盘上点起点 → 落点；公开行动会代替本回合普通走子。';
    $('specialHint').textContent = hint;

    const privateActionBox = $('privateActionBox');
    const privateAction = story.privateAction;
    if (!privateAction) {
      // 没有私密行动的席位（包括 A）不保留任何私密面板/DOM。
      privateActionBox.hidden = true;
      privateActionBox.innerHTML = '';
    } else {
      privateActionBox.hidden = false;
      if (!privateActionBox.innerHTML.trim()) {
        // 面板文案只来自服务端按席位下发的私密描述；静态脚本不内置能力名。
        privateActionBox.innerHTML =
          '<div class="divider"></div>' +
          '<h3>' + esc(privateAction.label || '私密行动') + ' <span class="lock">本席私密</span></h3>' +
          '<p class="hint">' + esc(privateAction.help || '') + '</p>' +
          '<div class="row">' +
          '<input id="privateTarget" maxlength="2" placeholder="' + esc(privateAction.targetPlaceholder || '目标格') + '" autocomplete="off">' +
          '<input id="privateValue" maxlength="40" placeholder="' + esc(privateAction.valuePlaceholder || '值') + '" autocomplete="off">' +
          '<button type="button" class="btn danger" data-action="private-action-submit">' + esc(privateAction.buttonLabel || '提交私密行动') + '</button>' +
          '</div>' +
          '<p class="hint" id="privateResult"></p>' +
          '<ul class="plain-list" id="privateAttempts"></ul>';
      }
      const privateActionButton = privateActionBox.querySelector('[data-action="private-action-submit"]');
      if (privateActionButton) privateActionButton.disabled = !privateAction.canUse || S.busy;
      const attempts = Array.isArray(privateAction.attempts) ? privateAction.attempts : [];
      const last = attempts.length ? attempts[attempts.length - 1] : null;
      $('privateResult').textContent = last
        ? '上次：' + last.targetSquare + ' · ' + last.name + ' → ' + (last.success ? '成功' : '未生效')
        : (privateAction.used ? '本回合已提交过私密行动。' : '本回合还没有提交。');
      $('privateAttempts').innerHTML = attempts.length
        ? attempts.slice().reverse().map((attempt) =>
            '<li>' + fmtTime(attempt.at) + ' · ' + esc(attempt.targetSquare) + ' · ' +
            esc(attempt.name) + ' → ' + (attempt.success ? '<span class="pill ok">成功</span>' : '<span class="pill bad">未生效</span>') + '</li>',
          ).join('')
        : '<li class="hint">还没有提交。</li>';
    }

    const events = (publicStory.events || []).slice().reverse();
    $('storyNoEvents').hidden = events.length > 0;
    $('storyEvents').innerHTML = events.map((event) =>
      '<li><span class="time">' + fmtTime(event.at) + '</span>' + esc(storyEventText(event)) + '</li>',
    ).join('');
  }

  function renderTeammateCard() {
    const state = S.latest;
    const card = $('teammateCard');
    if (!state) { card.hidden = true; return; }
    if (state.role !== 'player' || state.seat !== 'white' || !state.game.story || !state.game.story.enabled) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const info = state.me.teammate || { available: false, label: '未接入真实模型', note: '' };
    $('teammateStatus').innerHTML = pill(info.label, info.available ? 'ok' : 'pending') + ' ' + pill('预留接口', 'muted');
    $('teammateNote').textContent = info.note || '预留适配器；当前不调用任何模型。';
    const input = $('teammateGuessInput');
    input.disabled = !state.me.canGuess;
    $('teammateGuessCounter').textContent = input.value.length + ' / 300';
    $('teammateGuessBtn').disabled = !state.me.canGuess || S.busy || input.value.trim().length === 0;
    const canAct = Boolean(
      state.phase === 'playing' &&
      !state.game.pendingMove &&
      !state.game.result &&
      (state.me.canMove || (state.me.story && state.me.story.canSpecial) || state.me.canGuess),
    );
    const decideBtn = $('teammateDecideBtn');
    decideBtn.disabled = !info.available || !canAct || S.busy;
    decideBtn.textContent = info.available ? '让大肥鱼决策（受控）' : '受控适配器未接入';
    const result = $('teammateDecisionResult');
    if (S.lastDecision && S.lastDecision.error) result.textContent = '上次决策失败：' + S.lastDecision.error;
    else if (S.lastDecision && S.lastDecision.decision) {
      const d = S.lastDecision.decision;
      result.textContent = '上次决策：' + d.kind + (d.actionId ? ' · ' + d.actionId : '') +
        (S.lastDecision.pending ? ' · 待女神核准' : ' · 已应用');
    } else result.textContent = info.note || '';
  }

  function renderGoddessStory() {
    const state = S.latest;
    if (!state || state.role !== 'goddess') return;
    const story = state.goddess && state.goddess.story;
    const card = $('goddessStoryCard');
    if (!story) { card.hidden = true; return; }
    card.hidden = false;
    const labels = story.abilityText || {};
    const labelFor = (seat) => (labels[seat] && labels[seat].label) || '私密能力';
    const goddessAdapter = state.goddess && state.goddess.adapter;
    $('goddessStoryStatus').innerHTML =
      '白方：' + pill(labelFor('white'), 'ok') + ' · 黑方：' + pill(labelFor('black'), 'ok') +
      ' · ' + pill(story.kingErasureWins ? '特殊终局规则：启用' : '特殊终局规则：关闭', story.kingErasureWins ? 'pending' : 'muted') +
      (goddessAdapter ? ' · 女神适配器：' + pill(goddessAdapter.label || '未接入', goddessAdapter.available ? 'ok' : 'muted') : '');
    const special = Array.isArray(story.special) ? story.special : [];
    $('goddessSpecial').textContent = special.length
      ? special.map((type) => specialLabel(type)).join(' / ')
      : '空';

    $('goddessNames').innerHTML = (story.names || []).map((piece) => {
      const draft = S.fieldDirty[piece.square] ? S.fieldDrafts[piece.square] || {} : {};
      const name = draft.name !== undefined ? draft.name : (piece.privateValue || '');
      const alias = draft.alias !== undefined ? draft.alias : (piece.alias || '');
      return '<div class="name-row' + (piece.privateValue ? '' : ' missing-name') + '">' +
        '<span class="meta">' + esc(COLOR_NAME[piece.color]) + esc(PIECE_NAMES[piece.type] || piece.type) + ' ' + esc(piece.square) + '</span>' +
        '<input data-field="private-value" data-square="' + esc(piece.square) + '" maxlength="40" placeholder="私密字段（空=不可用）" value="' + esc(name) + '">' +
        '<input data-field="public-mark" data-square="' + esc(piece.square) + '" maxlength="40" placeholder="公开标记（可选）" value="' + esc(alias) + '">' +
        '<button type="button" class="btn small" data-action="name-save" data-square="' + esc(piece.square) + '">保存字段</button>' +
        '</div>';
    }).join('') || '<p class="hint">没有可配置的棋子。</p>';

    $('goddessAudit').innerHTML = story.attempts.length
      ? story.attempts.slice().reverse().map((attempt) =>
          '<div class="audit-item">' + fmtTime(attempt.at) + ' · ' + seatName(attempt.seat) + ' → ' +
          esc(attempt.targetSquare) + ' · 「' + esc(attempt.name) + '」 · ' +
          (attempt.success ? '<span class="success">成功</span>' : '<span class="failed">未生效</span>') + '</div>',
        ).join('')
      : '<p class="hint">暂无私密行动记录。</p>';

    const events = (story.events || []).slice().reverse();
    $('goddessStoryEvents').innerHTML = events.length
      ? events.map((event) => '<li>' + esc(storyEventText(event)) + '</li>').join('')
      : '<li class="hint">暂无公开行动。</li>';
  }

  function renderPlayerView() {
    const state = S.latest;
    if (state.role !== 'player') return;
    const me = state.me;
    const oppSeat = state.seat === 'white' ? 'black' : 'white';
    const opponent = state.players[oppSeat];

    // 席位卡
    $('seatDot').className = 'side-dot' + (state.seat === 'black' ? ' black' : '');
    $('seatTitle').textContent = seatName(state.seat) + '席位';
    $('seatSub').textContent = '你执' + (state.seat === 'white' ? '白' : '黑') + ' · 观察并猜中对方的隐藏规则';
    $('seatSelfConn').textContent = state.players[state.seat].connected ? '在线' : '离线';
    $('seatSelfConn').className = 'pill ' + (state.players[state.seat].connected ? 'ok' : 'muted');
    $('seatOppConn').textContent = opponent.connected ? '在线' : '离线';
    $('seatOppConn').className = 'pill ' + (opponent.connected ? 'ok' : 'muted');
    const pending = state.game.pendingMove;
    $('seatPending').textContent = pending
      ? seatName(pending.seat) + ' ' + pending.label
      : '无';
    $('seatPending').className = 'pill ' + (pending ? 'pending' : 'muted');
    const rejectionLine = $('rejectionLine');
    if (me.lastRejection) {
      rejectionLine.hidden = false;
      rejectionLine.textContent = '最近被驳回：' + me.lastRejection.label + ' · ' + me.lastRejection.reason;
    } else {
      rejectionLine.hidden = true;
    }

    // 规则卡
    const rule = me.rule;
    $('ruleStatus').innerHTML = '状态：' + pill(RULE_STATUS_TEXT[rule.status] || rule.status, RULE_STATUS_CLASS[rule.status] || 'muted') +
      (rule.revealed ? ' ' + pill('已对双方公开', 'ok') : '');
    const note = $('ruleNote');
    if (rule.status === 'returned' && rule.note) {
      note.hidden = false;
      note.textContent = '女神说明：' + rule.note;
    } else {
      note.hidden = true;
    }
    const canSubmitRule = Boolean(me.canSubmitRule);
    $('ruleEditBox').hidden = !canSubmitRule;
    $('ruleSealedBox').hidden = canSubmitRule;
    if (canSubmitRule) {
      const input = $('ruleInput');
      if (document.activeElement !== input) {
        if (S.ruleDraftDirty) input.value = S.ruleDraft || '';
        else input.value = rule.text || '';
      }
      $('ruleSubmitBtn').disabled = input.value.trim().length === 0;
      $('ruleCounter').textContent = input.value.length + ' / 400';
    } else {
      let text = rule.text || '';
      if (rule.status === 'submitted') text = (text || '（已提交）') ;
      if (rule.status === 'active') text = text || '（已生效）';
      $('ruleSealedBox').innerHTML =
        '<span class="sealed-title">' + (rule.status === 'submitted' ? '已封存，等待女神确认' : rule.status === 'active' ? '已生效' : '已揭晓') +
        '</span>' + esc(text || '（无内容）');
    }
    const oppRuleStatus = state.revealed[oppSeat] ? 'revealed' : opponent.rule.status;
    $('opponentRulePill').textContent = ruleLabelShort(oppRuleStatus);
    $('opponentRulePill').className = 'pill ' + (RULE_STATUS_CLASS[oppRuleStatus] || 'muted');
    const opponentHint = $('opponentRuleHint');
    if (state.revealed[oppSeat]) {
      opponentHint.textContent = '对方规则已由女神揭晓，见下方「规则揭晓」。';
    } else {
      opponentHint.textContent = '对方规则原文对你是保密的，只能通过棋盘和公开行动推测。';
    }

    // 猜测卡
    const attemptsUsed = me.attemptsUsed;
    const attemptsLeft = me.attemptsLeft;
    const limit = state.game.guessLimit;
    const attemptsText = limit === 0
      ? '已用 ' + attemptsUsed + ' 次 · 不限次数'
      : '已用 ' + attemptsUsed + ' / ' + limit + ' 次' + (attemptsLeft !== null ? ' · 剩余 ' + attemptsLeft + ' 次' : '');
    const pendingGuess = me.guesses.find((guess) => guess.status === 'pending');
    let guessStateNote = '';
    if (!me.canGuess) {
      if (state.phase === 'lobby') guessStateNote = '对局开始后才能猜测。';
      else if (state.phase === 'paused') guessStateNote = '对局暂停中。';
      else if (state.phase === 'finished') guessStateNote = '本局已结束。';
      else if (pendingGuess) guessStateNote = '等待女神裁定这条猜测。';
      else if (limit !== 0 && attemptsLeft === 0) guessStateNote = '猜测次数已用完。';
      else guessStateNote = '当前不能提交猜测。';
    }
    $('guessMeta').innerHTML = esc(attemptsText) + (pendingGuess ? ' ' + pill('等待裁定', 'pending') : '') +
      (guessStateNote ? '<br><span class="hint">' + esc(guessStateNote) + '</span>' : '');
    $('guessEditBox').hidden = !me.canGuess;
    if (me.canGuess) {
      const input = $('guessInput');
      $('guessSubmitBtn').disabled = input.value.trim().length === 0 || S.busy;
      $('guessCounter').textContent = input.value.length + ' / 300';
    }
    $('guessHistory').innerHTML = me.guesses.length
      ? me.guesses
          .slice()
          .reverse()
          .map((guess) => {
            const statusClass = GUESS_STATUS_CLASS[guess.status] || 'muted';
            const note = guess.note ? '<div class="g-note">女神：' + esc(guess.note) + '</div>' : '';
            return (
              '<div class="guess-item"><div class="g-head">' +
              pill(GUESS_STATUS_TEXT[guess.status] || guess.status, statusClass) +
              '<span class="hint">' + fmtTime(guess.at) + '</span></div>' +
              '<div class="g-text">' + esc(guess.text) + '</div>' + note + '</div>'
            );
          })
          .join('')
      : '<p class="hint">还没有提交过猜测。猜中对方规则即可获胜。</p>';

    // 规则揭晓
    const revealed = state.revealed;
    const revealCard = $('revealCard');
    if (revealed && (revealed.white || revealed.black)) {
      revealCard.hidden = false;
      $('revealBody').innerHTML = ['white', 'black']
        .filter((seat) => revealed[seat])
        .map(
          (seat) =>
            '<div class="reveal-block"><strong>' + seatName(seat) + '的隐藏规则</strong><p>' +
            esc(revealed[seat].text) + '</p></div>',
        )
        .join('');
    } else {
      revealCard.hidden = true;
    }

    // 公告
    const announcements = state.announcements || [];
    $('announceEmpty').hidden = announcements.length > 0;
    $('announceList').innerHTML = announcements
      .slice()
      .reverse()
      .map((item) => '<li><span class="time">' + fmtTime(item.at) + '</span>' + esc(item.text) + '</li>')
      .join('');

    renderStoryCard();
    renderTeammateCard();
  }

  // ---------------- 渲染：女神视图 ----------------

  function renderGoddessView() {
    const state = S.latest;
    if (state.role !== 'goddess') return;
    const game = state.game;
    const goddess = state.goddess;
    const rules = goddess.rules;

    $('goddessPhase').innerHTML =
      '阶段：<strong>' + esc(phaseText(state.phase)) + '</strong> · ' +
      '白方规则 ' + pill(ruleLabelShort(rules.white.status), RULE_STATUS_CLASS[rules.white.status] || 'muted') +
      ' · 黑方规则 ' + pill(ruleLabelShort(rules.black.status), RULE_STATUS_CLASS[rules.black.status] || 'muted') +
      (game.pendingMove ? ' · ' + pill('待裁决', 'pending') : '');

    const bothActive = rules.white.status === 'active' && rules.black.status === 'active';
    $('startBtn').disabled = state.phase !== 'lobby' || !bothActive;
    $('startBtn').textContent = state.phase === 'lobby'
      ? bothActive
        ? '开始对局'
        : '等待双方规则生效'
      : state.phase === 'finished'
        ? '对局已结束'
        : '对局已开始';
    $('pauseBtn').disabled = !(state.phase === 'playing' || state.phase === 'paused');
    $('pauseBtn').textContent = state.phase === 'paused' ? '继续对局' : '暂停对局';
    const undoAfterAutoFinish = Boolean(
      state.phase === 'finished' &&
        game.result &&
        game.result.automatic &&
        !rules.white.revealedAt &&
        !rules.black.revealedAt,
    );
    $('undoBtn').disabled = !(state.phase === 'playing' || state.phase === 'paused' || undoAfterAutoFinish);
    const allRevealed = Boolean(rules.white.revealedAt && rules.black.revealedAt);
    $('revealBothBtn').disabled = allRevealed || (!rules.white.text && !rules.black.text);
    $('resetBtn').disabled = false;
    $('editApplyBtn').disabled = !(state.phase === 'playing' || state.phase === 'paused');
    $('endBtn').disabled = !(state.phase === 'playing' || state.phase === 'paused');

    const reviewToggle = $('reviewToggle');
    if (document.activeElement !== reviewToggle) reviewToggle.checked = Boolean(goddess.settings.reviewMode);
    const guessInput = $('guessLimitInput');
    if (document.activeElement !== guessInput) guessInput.value = goddess.settings.guessLimit;

    // 待裁决
    $('reviewArea').innerHTML = game.pendingMove
      ? (() => {
          const pending = game.pendingMove;
          return (
            '<div class="review-card">' +
            '<div class="rv-move">' + esc(pending.label) + '</div>' +
            '<div class="rv-sub">' + seatName(pending.seat) + ' · ' + esc(pending.from) + ' → ' + esc(pending.to) +
            (pending.promotion ? ' · 升变 ' + esc(pending.promotion.toUpperCase()) : '') + '</div>' +
            '<input id="reviewNote" data-draft="reviewNote" maxlength="300" placeholder="给玩家的驳回说明（驳回时可见）">' +
            '<div class="row">' +
            '<button class="btn primary" data-action="review-approve">通过这一步</button>' +
            '<button class="btn danger" data-action="review-reject">驳回</button>' +
            '</div></div>'
          );
        })()
      : '<p class="hint">当前没有待裁决走子。逐手审核开启时，玩家提交的走子会出现在这里；关闭时走子即时生效，仍可用「撤销一步」纠正。</p>';

    // 规则收件箱
    $('ruleInbox').innerHTML = ['white', 'black']
      .map((seat) => {
        const rule = rules[seat];
        const draftKey = seat;
        let text = rule.text || '';
        if (S.dirty.ruleText[draftKey] && S.goddessDrafts.ruleText[draftKey] !== undefined) {
          text = S.goddessDrafts.ruleText[draftKey];
        }
        let noteValue = '';
        if (S.dirty.ruleNote[draftKey] && S.goddessDrafts.ruleNote[draftKey] !== undefined) {
          noteValue = S.goddessDrafts.ruleNote[draftKey];
        }
        const canHandle = state.phase === 'lobby';
        return (
          '<div class="inbox-rule" data-seat="' + seat + '">' +
          '<div class="ir-head"><strong>' + seatName(seat) + '</strong>' +
          pill(rule.revealedAt ? '已揭晓' : RULE_STATUS_TEXT[rule.status] || rule.status, rule.revealedAt ? 'ok' : RULE_STATUS_CLASS[rule.status] || 'muted') +
          '</div>' +
          '<textarea data-field="rule-text" data-seat="' + seat + '" maxlength="400" placeholder="该方尚未提交规则">' + esc(text) + '</textarea>' +
          '<input class="ir-note" data-field="rule-note" data-seat="' + seat + '" maxlength="300" placeholder="退回说明（玩家可见）" value="' + esc(noteValue) + '">' +
          '<div class="ir-actions">' +
          '<button class="btn small primary" data-action="rule-approve" data-seat="' + seat + '"' + (!canHandle || rule.status !== 'submitted' ? ' disabled' : '') + '>通过生效</button>' +
          '<button class="btn small" data-action="rule-return" data-seat="' + seat + '"' + (!canHandle || (rule.status !== 'submitted' && rule.status !== 'active') ? ' disabled' : '') + '>退回修改</button>' +
          '<button class="btn small" data-action="rule-edit" data-seat="' + seat + '"' + (!canHandle || (rule.status !== 'submitted' && rule.status !== 'active') ? ' disabled' : '') + '>保存文字修正</button>' +
          '<button class="btn small" data-action="rule-reveal" data-seat="' + seat + '"' + (!rule.text || rule.revealedAt ? ' disabled' : '') + '>揭晓该方规则</button>' +
          '</div></div>'
        );
      })
      .join('');

    // 猜测核验
    const guesses = goddess.guesses || [];
    $('guessInbox').innerHTML = guesses.length
      ? guesses
          .slice()
          .reverse()
          .map((guess) => {
            const isPending = guess.status === 'pending';
            let noteValue = '';
            if (S.dirty.guessNote[guess.id] && S.goddessDrafts.guessNote[guess.id] !== undefined) {
              noteValue = S.goddessDrafts.guessNote[guess.id];
            }
            const actions = isPending
              ? '<input data-field="guess-note" data-id="' + esc(guess.id) + '" maxlength="300" placeholder="裁定说明（玩家可见，可选）" value="' + esc(noteValue) + '">' +
                '<div class="g-actions">' +
                '<button class="btn small primary" data-action="guess-correct" data-id="' + esc(guess.id) + '">猜中 · 判其获胜</button>' +
                '<button class="btn small danger" data-action="guess-wrong" data-id="' + esc(guess.id) + '">未命中</button>' +
                '</div>'
              : '<div class="hint">' + esc(guess.note || '已裁定') + '</div>';
            return (
              '<div class="guess-inbox-item"><div class="g-meta"><strong>' + seatName(guess.seat) + '</strong>' +
              pill(GUESS_STATUS_TEXT[guess.status] || guess.status, GUESS_STATUS_CLASS[guess.status] || 'muted') +
              '<span class="hint">' + fmtTime(guess.at) + '</span></div>' +
              '<div class="g-text">' + esc(guess.text) + '</div>' + actions + '</div>'
            );
          })
          .join('')
      : '<p class="hint">还没有任何猜测。玩家提交后会出现在这里，并只对你可见。</p>';

    // 席位链接：默认不渲染令牌，点击按钮后才写入 DOM，避免录屏误拍
    const links = goddess.links || {};
    $('seatLinksWrap').hidden = !S.showLinks;
    $('toggleSeatLinksBtn').textContent = S.showLinks ? '隐藏席位链接（含令牌）' : '显示席位链接（含令牌）';
    $('seatLinks').innerHTML = S.showLinks
      ? ['white', 'black', 'goddess']
          .map((seat) => {
            const label = seat === 'goddess' ? '女神（本席）' : seatName(seat);
            return (
              '<div class="link-row"><div class="lr-head"><span>' + label + '</span>' +
              '<button class="btn small" data-action="copy-link" data-seat="' + seat + '">复制链接</button></div>' +
              '<code>' + esc(links[seat] || '（不可用）') + '</code></div>'
            );
          })
          .join('')
      : '';

    // 事件日志
    const events = (goddess.events || []).slice().reverse();
    $('eventLog').innerHTML = events.length
      ? events
          .map(
            (event) =>
              '<li><span class="seq">#' + event.seq + '</span><span class="ev-text">' +
              fmtTime(event.at) + ' · ' + esc(event.text) + '</span></li>',
          )
          .join('')
      : '<li class="hint">暂无事件。</li>';

    // 表单状态（不覆盖正在输入的字段）
    const announce = $('announceInput');
    if (document.activeElement !== announce) {
      announce.value = S.dirty.announce ? S.goddessDrafts.announce : '';
    }
    $('announceCounter').textContent = announce.value.length + ' / 300';
    $('announceBtn').disabled = announce.value.trim().length === 0;
    const editNote = $('editNote');
    if (document.activeElement !== editNote) {
      editNote.value = S.dirty.editNote ? S.goddessDrafts.editNote : '';
    }
    const endNote = $('endNote');
    if (document.activeElement !== endNote) {
      endNote.value = S.dirty.endNote ? S.goddessDrafts.endNote : '';
    }
    renderGoddessStory();
  }

  // ---------------- 输入与事件 ----------------

  function render() {
    if (!S.latest) return;
    renderHeader();
    renderPlayerBars();
    renderBoard();
    renderTurnLine();
    renderResultBanner();
    renderBoardHint();
    renderMoveStrip();
    renderPlayerView();
    renderGoddessView();
  }

  function updateRuleCounter() {
    const input = $('ruleInput');
    $('ruleCounter').textContent = input.value.length + ' / 400';
    $('ruleSubmitBtn').disabled = input.value.trim().length === 0 || S.busy;
  }

  function updateGuessCounter() {
    const input = $('guessInput');
    $('guessCounter').textContent = input.value.length + ' / 300';
    $('guessSubmitBtn').disabled = input.value.trim().length === 0 || S.busy;
  }

  function copyLink(text, label) {
    if (!text) {
      toast('该链接不可用', 'error');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast(label + '链接已复制', 'ok'),
        () => window.prompt('复制链接：', text),
      );
    } else {
      window.prompt('复制链接：', text);
    }
  }

  async function exportRoom() {
    try {
      const response = await fetch(
        '/api/rooms/' + encodeURIComponent(S.roomId) + '/export?token=' + encodeURIComponent(S.token),
      );
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error((error && error.error) || '导出失败');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'nekofans-' + S.roomId + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('已导出完整对局记录', 'ok');
    } catch (error) {
      toast(error.message || '导出失败', 'error');
    }
  }

  function handleDynamicInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const field = target.dataset.field;
    if (!field) return;
    if (field === 'rule-text') {
      const seat = target.dataset.seat;
      S.goddessDrafts.ruleText[seat] = target.value;
      S.dirty.ruleText[seat] = true;
    } else if (field === 'rule-note') {
      const seat = target.dataset.seat;
      S.goddessDrafts.ruleNote[seat] = target.value;
      S.dirty.ruleNote[seat] = true;
    } else if (field === 'guess-note') {
      const id = target.dataset.id;
      S.goddessDrafts.guessNote[id] = target.value;
      S.dirty.guessNote[id] = true;
    } else if (field === 'private-value' || field === 'public-mark') {
      const square = target.dataset.square;
      const draft = S.fieldDrafts[square] || {};
      if (field === 'private-value') draft.name = target.value;
      else draft.alias = target.value;
      S.fieldDrafts[square] = draft;
      S.fieldDirty[square] = true;
    }
  }

  function clearDraftsForRule(seat) {
    delete S.dirty.ruleText[seat];
    delete S.goddessDrafts.ruleText[seat];
    delete S.dirty.ruleNote[seat];
    delete S.goddessDrafts.ruleNote[seat];
  }

  function handleDynamicClick(event) {
    const target = event.target instanceof HTMLElement ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.dataset.action;
    const seat = target.dataset.seat;
    const id = target.dataset.id;

    if (action === 'review-approve') {
      const pending = S.latest.game.pendingMove;
      if (!pending) return;
      goddessAction('review', { moveId: pending.id, decision: 'approve' });
      return;
    }
    if (action === 'review-reject') {
      const pending = S.latest.game.pendingMove;
      if (!pending) return;
      const noteInput = $('reviewNote');
      const note = noteInput ? noteInput.value.trim() : '';
      if (!note && !window.confirm('不写驳回说明直接驳回？')) return;
      goddessAction('review', { moveId: pending.id, decision: 'reject', note: note || undefined });
      return;
    }
    if (action === 'rule-approve') {
      goddessAction('rule', { seat, action: 'approve' });
      return;
    }
    if (action === 'rule-return') {
      let note = '';
      const noteInput = document.querySelector('[data-field="rule-note"][data-seat="' + seat + '"]');
      if (noteInput) note = noteInput.value.trim();
      if (!note && !window.confirm('不写退回说明直接退回？')) return;
      clearDraftsForRule(seat);
      goddessAction('rule', { seat, action: 'return', note: note || undefined });
      return;
    }
    if (action === 'rule-edit') {
      const textInput = document.querySelector('[data-field="rule-text"][data-seat="' + seat + '"]');
      if (!textInput) return;
      const text = textInput.value.trim();
      if (!text) {
        toast('规则文字不能为空', 'error');
        return;
      }
      if (!window.confirm('确认用当前文字替换' + seatName(seat) + '的规则？（会记录事件，玩家可见其规则文本被修正）')) return;
      clearDraftsForRule(seat);
      goddessAction('rule', { seat, action: 'edit', text });
      return;
    }
    if (action === 'rule-reveal') {
      if (!window.confirm('确认向双方公开' + seatName(seat) + '的规则原文？')) return;
      goddessAction('rule', { seat, action: 'reveal' });
      return;
    }
    if (action === 'guess-correct') {
      if (!window.confirm('确认判定这条猜测命中？该猜测方将立即获胜，并揭晓双方规则。')) return;
      const noteInput = document.querySelector('[data-field="guess-note"][data-id="' + id + '"]');
      const note = noteInput ? noteInput.value.trim() : '';
      goddessAction('judge-guess', { guessId: id, correct: true, note: note || undefined });
      return;
    }
    if (action === 'guess-wrong') {
      const noteInput = document.querySelector('[data-field="guess-note"][data-id="' + id + '"]');
      const note = noteInput ? noteInput.value.trim() : '';
      goddessAction('judge-guess', { guessId: id, correct: false, note: note || undefined });
      return;
    }
    if (action === 'copy-link') {
      const links = (S.latest.goddess && S.latest.goddess.links) || {};
      copyLink(links[seat], seat === 'goddess' ? '女神' : seatName(seat));
      return;
    }
    if (action === 'special-pattern') {
      const type = target.dataset.type;
      if (!S.latest.me || !S.latest.me.story) return;
      if (S.specialType === type) {
        S.specialType = null;
        S.specialFrom = null;
      } else {
        S.specialType = type;
        S.specialFrom = null;
      }
      render();
      return;
    }
    if (action === 'name-save') {
      savePrivateField(target.dataset.square);
      return;
    }
    if (action === 'private-action-submit') {
      submitPrivateAction();
      return;
    }
  }

  function bind() {
    $('board').addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target.closest('[data-square]') : null;
      if (!target) return;
      onBoardClick(target.dataset.square);
    });

    $('promotionCancel').addEventListener('click', hidePromotion);
    $('cancelPendingBtn').addEventListener('click', () => {
      if (window.confirm('撤回你尚未裁决的走子？')) playerAction('/move/cancel', {});
    });

    $('ruleInput').addEventListener('input', () => {
      S.ruleDraft = $('ruleInput').value;
      S.ruleDraftDirty = true;
      updateRuleCounter();
    });
    $('ruleSubmitBtn').addEventListener('click', async () => {
      const text = $('ruleInput').value.trim();
      if (!text) return;
      if (!window.confirm('规则一旦提交将封存，不能自行修改（可被女神退回）。确认提交？')) return;
      const ok = await playerAction('/rule', { text });
      if (ok) {
        S.ruleDraft = null;
        S.ruleDraftDirty = false;
      }
    });

    $('guessInput').addEventListener('input', updateGuessCounter);
    $('guessSubmitBtn').addEventListener('click', async () => {
      const text = $('guessInput').value.trim();
      if (!text) return;
      if (!window.confirm('提交猜测会消耗一次机会；猜错没有额外惩罚。确认提交？')) return;
      const ok = await playerAction('/guess', { text });
      if (ok) {
        $('guessInput').value = '';
        updateGuessCounter();
      }
    });

    $('notesInput').addEventListener('input', () => {
      if (S.noteTimer) clearTimeout(S.noteTimer);
      S.noteTimer = setTimeout(() => {
        try {
          localStorage.setItem(NOTES_KEY, $('notesInput').value);
        } catch {
          /* ignore quota / privacy mode */
        }
      }, 300);
    });

    // 女神静态控件
    $('startBtn').addEventListener('click', () => goddessAction('start', {}));
    $('pauseBtn').addEventListener('click', () => {
      const paused = S.latest.phase === 'paused';
      goddessAction('pause', { paused: !paused });
    });
    $('undoBtn').addEventListener('click', () => {
      if (!window.confirm('撤销上一步已生效的走子或棋盘修改？')) return;
      goddessAction('undo', {});
    });
    $('revealBothBtn').addEventListener('click', () => {
      if (!window.confirm('向双方公开双方规则原文？此操作不可撤回。')) return;
      goddessAction('rule', { seat: 'both', action: 'reveal' });
    });
    $('resetBtn').addEventListener('click', () => {
      if (!window.confirm('重开一局？当前规则、猜测、走子记录和公告都会被清空（事件日志保留）。')) return;
      goddessAction('reset', {});
    });
    $('saveSettingsBtn').addEventListener('click', () => {
      goddessAction('settings', {
        reviewMode: $('reviewToggle').checked,
        guessLimit: Number($('guessLimitInput').value),
      });
    });
    $('editOp').addEventListener('change', () => {
      const op = $('editOp').value;
      $('editSquareField').hidden = op === 'setTurn';
      $('editPieceField').hidden = op !== 'place';
      $('editColorField').hidden = op !== 'place';
      $('editTurnField').hidden = op !== 'setTurn';
    });
    $('editApplyBtn').addEventListener('click', () => {
      const op = $('editOp').value;
      const note = $('editNote').value.trim();
      let body;
      if (op === 'remove') {
        body = { op: 'remove', square: $('editSquare').value.trim(), note: note || undefined };
      } else if (op === 'place') {
        body = {
          op: 'place',
          square: $('editSquare').value.trim(),
          type: $('editPiece').value,
          color: $('editColor').value,
          note: note || undefined,
        };
      } else {
        body = { op: 'setTurn', turn: $('editTurn').value, note: note || undefined };
      }
      if (!window.confirm('执行棋盘修改？该操作会写入事件日志，可撤销一次。')) return;
      S.dirty.editNote = false;
      goddessAction('edit-board', body);
    });
    $('endBtn').addEventListener('click', () => {
      const winner = $('endWinner').value;
      const reason = $('endReason').value;
      const note = $('endNote').value.trim();
      if (!window.confirm('结束并冻结对局？')) return;
      S.dirty.endNote = false;
      goddessAction('end', { winner, reason, note: note || undefined });
    });
    $('announceInput').addEventListener('input', () => {
      S.goddessDrafts.announce = $('announceInput').value;
      S.dirty.announce = true;
      $('announceCounter').textContent = $('announceInput').value.length + ' / 300';
      $('announceBtn').disabled = $('announceInput').value.trim().length === 0;
    });
    $('announceBtn').addEventListener('click', () => {
      const text = $('announceInput').value.trim();
      if (!text) return;
      if (!window.confirm('发送双方可见的公告？请确认其中没有规则原文。')) return;
      S.dirty.announce = false;
      S.goddessDrafts.announce = '';
      $('announceInput').value = '';
      goddessAction('announce', { text });
    });
    $('editNote').addEventListener('input', () => {
      S.goddessDrafts.editNote = $('editNote').value;
      S.dirty.editNote = true;
    });
    $('endNote').addEventListener('input', () => {
      S.goddessDrafts.endNote = $('endNote').value;
      S.dirty.endNote = true;
    });
    $('exportBtn').addEventListener('click', exportRoom);

    $('teammateGuessInput').addEventListener('input', () => {
      const input = $('teammateGuessInput');
      const me = S.latest && S.latest.me;
      if (!me) return;
      $('teammateGuessCounter').textContent = input.value.length + ' / 300';
      $('teammateGuessBtn').disabled = S.busy || !me.canGuess || input.value.trim().length === 0;
    });
    $('teammateGuessBtn').addEventListener('click', submitTeammateGuess);
    $('teammateDecideBtn').addEventListener('click', requestTeammateDecision);
    $('toggleSeatLinksBtn').addEventListener('click', toggleSeatLinks);
    $('secrecyBtn').addEventListener('click', toggleSecrecy);

    document.addEventListener('input', handleDynamicInput);
    document.addEventListener('click', handleDynamicClick);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('promotion').hidden) hidePromotion();
        S.selected = null;
        renderBoard();
      }
    });
  }

  function init() {
    if (!ROOM_ID) {
      fatal('房间地址不正确', '请从本地控制台创建房间，并使用生成的席位链接进入。');
      return;
    }
    const token = readToken();
    if (!token) {
      fatal(
        '缺少访问令牌',
        '这个页面需要控制台生成的私密链接才能进入。\n请回到 http://127.0.0.1:8787/ 重新复制对应席位的链接。',
      );
      return;
    }
    S.token = token;
    try {
      $('notesInput').value = localStorage.getItem(NOTES_KEY) || '';
    } catch {
      /* ignore */
    }
    bind();
    api('GET', '/state')
      .then((data) => {
        applyState(data.state);
        connectStream();
        setConnected(true);
        // 页面回到前台时刷新一次，防止 SSE 长连接被系统挂起
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') refreshState();
        });
      })
      .catch((error) => {
        if (error.status !== 401) {
          fatal('无法读取房间', error.message || '请确认本地服务仍在运行。');
        }
      });
  }

  init();
})();
