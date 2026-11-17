// This data is shared by the editor, room server, and the trusted board renderer.
// The model supplies public text and transitions. It never supplies executable code.
export const MAX_STUDIO_BYTES = 16000;
const MAX_NODES = 24;
const MAX_CHOICES = 4;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const clean = (value, limit) => typeof value === 'string' && value.trim() &&
  [...value.trim()].length <= limit && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)
  ? value.trim() : null;

export function validateStudioGame(value) {
  if (!exact(value, ['title', 'description', 'nodes'])) return null;
  const title = clean(value.title, 40), description = clean(value.description, 220);
  if (!title || !description || !Array.isArray(value.nodes) ||
      value.nodes.length < 3 || value.nodes.length > MAX_NODES) return null;

  const nodes = [];
  for (const [index, node] of value.nodes.entries()) {
    const text = clean(node?.text, 160);
    if (!text) return null;
    if (exact(node, ['text', 'winner'])) {
      if (index < 2 || ![0, 1, 'draw'].includes(node.winner)) return null;
      nodes.push({text, winner: node.winner});
      continue;
    }
    if (!exact(node, ['text', 'seat', 'choices']) || ![0, 1].includes(node.seat) ||
        (index === 0 && node.seat !== 0) || !Array.isArray(node.choices) ||
        node.choices.length < 1 || node.choices.length > MAX_CHOICES) return null;
    const choices = [];
    for (const choice of node.choices) {
      if (!exact(choice, ['label', 'next'])) return null;
      const label = clean(choice.label, 56);
      const next = choice.next;
      if (!label || choices.some(item => item.label === label) || !Number.isInteger(next) ||
          next <= index || next >= value.nodes.length) return null;
      choices.push({label, next});
    }
    nodes.push({text, seat: node.seat, choices});
  }

  const reachable = new Set([0]);
  for (const [index, node] of nodes.entries()) {
    if (!reachable.has(index)) return null;
    for (const {next} of node.choices || []) {
      const destination = nodes[next];
      if (destination.seat === node.seat || (index === 0 && !destination.choices)) return null;
      reachable.add(next);
    }
  }
  const game = {title, description, nodes};
  return Buffer.byteLength(JSON.stringify(game), 'utf8') <= MAX_STUDIO_BYTES ? game : null;
}

export function studioPreview(game) {
  return {title: game.title, description: game.description, opening: game.nodes[0].text,
    choices: game.nodes[0].choices.map(choice => choice.label)};
}

export function createStudioRoom(game) {
  const rules = [null, null];
  let active = false;
  function current(actions) {
    let index = 0;
    for (const {action} of actions) index = game.nodes[index].choices[Number(action)].next;
    return game.nodes[index];
  }
  return {
    view(seat) {
      return {ownStatus: rules[seat] ? 'ready' : 'empty', opponentReady: !!rules[1-seat], rulesActive: active};
    },
    submit({seat, rule, preset}) {
      if (rule !== undefined) return {status: 'unsupported'};
      if (!exact(preset, ['choice', 'turns']) || !['first', 'last', 'none'].includes(preset.choice) ||
          preset.turns !== 1 || ![0, 1].includes(seat)) return {status: 'invalid'};
      if (rules[seat]) return {status: 'already-submitted'};
      rules[seat] = preset.choice;
      return {status: 'ready'};
    },
    start() { active = rules.every(Boolean); },
    turnStatus(actions) { return current(actions).choices ? 'normal' : 'finished'; },
    permitsMove({actions, seat, action}) {
      const node = current(actions), choice = Number(action);
      if (!active || node.seat !== seat || !node.choices?.[choice]) return false;
      if (actions.length >= 2 || node.choices.length < 2) return true;
      const opponentRule = rules[1-seat];
      return !(opponentRule === 'first' && choice === 0) &&
        !(opponentRule === 'last' && choice === node.choices.length - 1);
    },
  };
}

export function studioBoard(game) {
  const safeData = JSON.stringify(game).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<style>
body{margin:1rem;font:16px system-ui;color:#26364c}
button{display:block;margin:.5rem 0;padding:.5rem .8rem;font:inherit}
</style>
<h2 id="title"></h2><p id="description"></p><p id="scene"></p>
<p id="status" role="status"></p><div id="choices"></div>
<script>
const game = ${safeData};
const byId = id => document.getElementById(id);
byId('title').textContent = game.title;
byId('description').textContent = game.description;
function render({actions, seat, ready}) {
  let index = 0;
  for (const {action} of actions) index = game.nodes[index].choices[Number(action)].next;
  const node = game.nodes[index];
  byId('scene').textContent = node.text;
  byId('status').textContent = node.choices ? (ready ? (node.seat === seat ? '轮到你' : '等待对方行动') : '等待双方准备') :
    (node.winner === 'draw' ? '平局' : node.winner === seat ? '你赢了' : '对方获胜');
  const buttons = (node.choices || []).map(({label}, option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = !ready || node.seat !== seat;
    button.onclick = () => parent.postMessage({type:'nekofans:action',action:String(option),expectedVersion:actions.length}, '*');
    return button;
  });
  byId('choices').replaceChildren(...buttons);
}
render({actions: [], seat: -1, ready: false});
window.addEventListener('message', event => {
  if (event.source === parent && event.data?.type === 'nekofans:state' && Array.isArray(event.data.actions)) render(event.data);
});
parent.postMessage({type:'nekofans:ready'}, '*');
</script></html>`;
}

export function studioWorkshopHtml(definition) {
  const game = validateStudioGame(definition);
  if (!game) throw new TypeError('Invalid game studio definition');
  const safeData = JSON.stringify(game).replaceAll('<', '\\u003c');
  return `<html lang="zh-CN"><head><meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;align-items:center;padding:clamp(16px,5vw,48px);font:16px system-ui,sans-serif;background:#101b2c;color:#edf4ff}
main{width:min(100%,660px);margin:auto;border:1px solid #4a6080;border-radius:20px;padding:clamp(18px,5vw,38px);background:#19283e}
h1{font-size:clamp(24px,5vw,40px);margin:0 0 .45em}
p{line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
#description{color:#bbcbe0}
#scene{margin-top:1.5rem}
#status{color:#b3d9ff}
#choices{display:grid;gap:10px}
button{font:inherit;text-align:left;color:inherit;border:1px solid #648bb8;border-radius:9px;padding:.75em 1em;background:#254265;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
button:focus-visible{outline:2px solid #a8d5ff;outline-offset:3px}
</style></head><body><main><h1 id="title"></h1><p id="description"></p>
<p id="scene"></p><p id="status" role="status">等待同步</p><div id="choices"></div></main>
<script>
const game = ${safeData};
const byId = id => document.getElementById(id);
byId('title').textContent = game.title;
byId('description').textContent = game.description;
function choicesFor(state, player) {
  const node = game.nodes[state.node];
  return node.seat === player ? node.choices : [];
}
const room = NekofansGame.connect({
  initialState: { node: 0 },
  reducer(state, action, context) {
    if (action.type !== 'choose' || !Number.isInteger(action.option)) return state;
    const choice = choicesFor(state, context.player)[action.option];
    return choice ? { node: choice.next } : state;
  },
  onChange(state, context) {
    const node = game.nodes[state.node];
    byId('scene').textContent = node.text;
    const canChoose = context.isMyTurn && !context.agentActive && node.seat === context.player;
    byId('status').textContent = node.choices
      ? (canChoose ? '轮到你' : context.agentActive ? '伙伴接手中' : context.ready ? '等待对方操作' : '等待同步')
      : (node.winner === 'draw' ? '平局' : node.winner === context.player ? '你赢了' : '好友获胜');
    byId('choices').replaceChildren(...(node.choices ?? []).map(({ label }, option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = !canChoose;
      button.addEventListener('click', () => room.submit({ type: 'choose', option }));
      return button;
    }));
  },
  onError(message) { byId('status').textContent = message; },
  agent: {
    observe(state) { return { title: game.title, objective: game.description, scene: game.nodes[state.node].text }; },
    legalActions(state, context) {
      return choicesFor(state, context.player).map(({ label }, option) => ({ label, action: { type: 'choose', option } }));
    },
  },
});
</script></body></html>`;
}
