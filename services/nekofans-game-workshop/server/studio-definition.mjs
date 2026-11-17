// Shared by the creation desk and game servers. Only declarative data from
// the model is accepted; the workshop compiles its own fixed client.
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

export function nextStudioNode(game, index, action, player) {
  const node = game.nodes[index];
  if (!node?.choices || node.seat !== player || !exact(action, ['type', 'option']) ||
      action.type !== 'choose' || !Number.isInteger(action.option)) return undefined;
  return node.choices[action.option]?.next;
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
