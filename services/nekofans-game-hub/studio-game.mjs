export { MAX_STUDIO_BYTES, validateStudioGame, studioWorkshopHtml } from '../nekofans-game-workshop/server/studio-definition.mjs';

const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

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
