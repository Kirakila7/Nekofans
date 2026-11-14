import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTrial } from './deepseek-seat-trial.mjs';

const profiles = ['红帽', '蓝帽'].map((name, index) => ({
  request: async (action, payload) => {
    if (action === 'choose') return { status: 'ready', choiceId: (payload.choices.find(choice => choice.label.startsWith('向右跳')) || payload.choices.at(-1)).id };
    return { status: 'ready', id: `project-lobby-demo-${index}`, name };
  },
}));
const model = process.env.NEKO_GAME_OLLAMA_MODEL?.trim();
const directory = await mkdtemp(path.join(tmpdir(), 'nekofans-game-preview-'));
const preview = await startTrial({ gamePort: model ? 3107 : 3097, identityPort: model ? 3108 : 3098, profiles, simulated: true,
  defaultOllamaModel: model, directory });
console.log(preview.issuer);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => preview.close().then(() => process.exit(0)));
}
