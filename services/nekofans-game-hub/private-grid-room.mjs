const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const forbidden = {center:[4], corners:[0,2,6,8]};
const hasWon = board => lines.some(([a,b,c]) => board[a] && board[a] === board[b] && board[a] === board[c]);

export function createGridRoom() {
  const rules = [null,null];
  let active = false;
  return Object.freeze({
    view(seat) {
      return {ownStatus:rules[seat] ? 'ready' : 'empty', opponentReady:!!rules[1-seat], rulesActive:active};
    },
    submit({seat,rule,preset}) {
      if (![0,1].includes(seat)) return {status:'invalid'};
      if (active || rules[seat]) return {status:'already-submitted'};
      if (rule !== undefined) return {status:'unsupported'};
      if (!preset || Object.keys(preset).sort().join(',') !== 'choice,turns' ||
          !Object.hasOwn(forbidden,preset.choice) || preset.turns !== 1) return {status:'invalid'};
      rules[seat] = preset.choice;
      return {status:'ready'};
    },
    start() { if (rules.every(Boolean)) active = true; },
    turnStatus() { return active ? 'normal' : 'unavailable'; },
    permitsMove({actions,seat,action}) {
      if (!active || actions.length % 2 !== seat || !/^[0-8]$/.test(action)) return false;
      const board = Array(9).fill(null);
      for (const item of actions) board[Number(item.action)] = item.seat === 0 ? 'X' : 'O';
      const square = Number(action);
      if (board[square] || hasWon(board)) return false;
      return actions.length >= 2 || !forbidden[rules[1-seat]].includes(square);
    },
  });
}

export const gridBoard = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>井字棋</title><style>
body{margin:1rem auto;max-width:380px;font:16px system-ui;text-align:center;color:#293850}
.board{display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem}
button{aspect-ratio:1;border:1px solid #bdcbe0;border-radius:.5rem;background:#eef4fc;font:bold 2rem system-ui}
</style><h2>井字棋</h2><p id="status" role="status">等待双方准备</p><div id="board" class="board"></div>
<script>
const statusLabel = document.querySelector('#status'), board = document.querySelector('#board');
const lines = ${JSON.stringify(lines)};
const marks = ['X','O'];
let current = null;
const cells = Array.from({length:9}, (_,i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.disabled = true; b.setAttribute('aria-label','第 '+(i+1)+' 格');
  b.addEventListener('click', () => {
    if (!current) return;
    parent.postMessage({type:'nekofans:action',action:String(i),expectedVersion:current.actions.length},'*');
  });
  board.appendChild(b); return b;
});
window.addEventListener('message', event => {
  const data = event.data;
  if (event.source !== parent || data?.type !== 'nekofans:state' || !Array.isArray(data.actions)) return;
  current = data;
  const grid = Array(9).fill('');
  for (const {seat,action} of data.actions) grid[Number(action)] = marks[seat];
  const win = lines.find(([a,b,c]) => grid[a] && grid[a] === grid[b] && grid[a] === grid[c]);
  const turn = data.actions.length % 2, done = win || grid.every(Boolean);
  statusLabel.textContent = win ? grid[win[0]]+' 方获胜' : done ? '平局' :
    data.ready ? '轮到 '+marks[turn]+' · 已同步 '+data.actions.length+' 步' : '等待双方准备';
  for (const [i,cell] of cells.entries()) {
    cell.textContent = grid[i]; cell.disabled = !data.ready || !!done || turn !== data.seat || !!grid[i];
    cell.setAttribute('aria-label','第 '+(i+1)+' 格'+(grid[i]?' '+grid[i]:' 空'));
  }
});
parent.postMessage({type:'nekofans:ready'},'*');
</script></html>`;
