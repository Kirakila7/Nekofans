import { gameChoiceRules } from './agent-choice.mjs';
import { reject } from './platform.mjs';

export async function listOllamaModels({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(1800) });
    if (!response.ok) { await response.body?.cancel(); return { status: 'offline', models: [] }; }
    const { models } = await response.json();
    if (!Array.isArray(models)) return { status: 'offline', models: [] };
    const names = models.filter(model => !model?.remote_model && !model?.remote_host).map(model => model?.name)
      .filter(name => typeof name === 'string' && name.length <= 120 && /^[\w./:-]+$/.test(name) && !/[-:]cloud$/i.test(name));
    return { status: 'online', models: [...new Set(names)].sort().slice(0, 40) };
  } catch { return { status: 'offline', models: [] }; }
}

export function createOllamaAgent({ model, fetchImpl = fetch }) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('请填写已安装的 Ollama 模型名');
  const modelName = model.trim();
  return async function choose({ player, observation, choices, signal, rules = gameChoiceRules }) {
    const timeout = AbortSignal.timeout(22000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response, content;
    try {
      response = await fetchImpl('http://127.0.0.1:11434/api/chat', {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName, stream: false,
          format: { type: 'object', required: ['choiceId'], additionalProperties: false,
            properties: { choiceId: { type: 'integer', enum: choices.map(choice => choice.id) } } },
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: rules + '输出一个 JSON 对象，唯一字段是整数 choiceId。' },
            { role: 'user', content: JSON.stringify({ player, observation, choices }) },
          ],
        }),
      });
      if (response.ok) content = (await response.json())?.message?.content;
      else await response.body?.cancel();
    } catch {
      reject(503, requestSignal.aborted ? 'Ollama 请求已停止或超时' : '无法连接本机 Ollama');
    }
    if (requestSignal.aborted) reject(503, 'Ollama 请求已停止或超时');
    if (!response.ok) reject(503, response.status === 404 ? 'Ollama 找不到所选模型' : 'Ollama 无法执行模型请求');
    let result;
    try { result = typeof content === 'string' ? JSON.parse(content) : null; } catch {}
    if (!result || Object.keys(result).length !== 1 || !choices.some(choice => choice.id === result.choiceId)) {
      reject(422, 'Ollama 未返回合法动作编号');
    }
    return result.choiceId;
  };
}
