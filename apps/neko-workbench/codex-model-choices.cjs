'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
function validChoice(id, choice) {
  const field = (value, max) => value === null || typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
  return typeof id === 'string' && /^[A-Za-z0-9_:-]{1,180}$/.test(id) && choice && field(choice.model, 160) && field(choice.effort, 80) && (choice.model !== null || choice.effort === null);
}
function createCodexModelChoices(file) {
  const choices = new Map();
  try {
    if (fs.statSync(file).size < 160000) for (const [id, choice] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).slice(-200)) if (validChoice(id, choice)) choices.set(id, { model: choice.model, effort: choice.effort });
  } catch {}
  return {
    get: () => Object.fromEntries([...choices].map(([id, choice]) => [id, { ...choice }])),
    set(id, choice) {
      if (!validChoice(id, choice)) throw Error('Codex 模型选项无效');
      const next = new Map(choices); next.delete(id); next.set(id, { model: choice.model, effort: choice.effort });
      while (next.size > 200) next.delete(next.keys().next().value);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(next)) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
      finally { fs.rmSync(temporary, { force: true }); }
      choices.clear(); for (const [key, value] of next) choices.set(key, value);
      return { ...choice };
    },
  };
}
module.exports = { createCodexModelChoices };
