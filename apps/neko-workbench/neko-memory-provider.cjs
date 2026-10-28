'use strict';
const fs = require('node:fs');
const { atomicBytes } = require('./main-chat-secret.cjs');

// Each submitted turn is written to the queue before transport. A request
// whose outcome is unknown is never automatically replayed: upstream /cache
// does not provide general-purpose idempotency keys.
class NekoMemoryProvider {
  constructor({ service, queueFile, personaId = 'bigfish', character = '大肥鱼' }) {
    this.service = service; this.queueFile = queueFile; this.personaId = personaId; this.character = character;
    this.tail = Promise.resolve(); this.error = ''; this.queue = [];
    if (fs.existsSync(queueFile)) {
      const value = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      if (!Array.isArray(value)) throw Error('记忆同步队列损坏');
      this.queue = value.map(item => item.state === 'sending' ? { ...item, state: 'unknown' } : item);
      if (this.queue.some(item => item.state === 'unknown' || item.state === 'pending')) this.error = '有记忆写入尚未完成或结果待确认，未自动重复发送';
    }
  }
  save() { atomicBytes(this.queueFile, Buffer.from(JSON.stringify(this.queue, null, 2) + '\n')); }
  async recall(personaId, query, budgetTokens) {
    if (personaId !== this.personaId) throw Error('角色记忆不匹配');
    let result;
    try { result = await this.service.request('/query_memory/' + encodeURIComponent(this.character), { method: 'POST', body: { query }, timeoutMs: 10000 }); }
    catch (error) { this.error = 'N.E.K.O. 记忆检索失败，请检查记忆服务'; throw error; }
    if (!Array.isArray(result.results)) { this.error = 'N.E.K.O. 记忆检索失败，请检查记忆服务'; throw Error('记忆检索结果无效'); }
    this.error = this.queue.some(row => row.state === 'unknown' || row.state === 'pending') ? '有记忆写入尚未完成或结果待确认，未自动重复发送' : '';
    let budget = Math.max(0, budgetTokens * 2);
    return result.results.filter(row => typeof row.text === 'string' && row.text.trim()).map((row, index) => ({
      id: String(row.id || 'neko-' + index), personaId, kind: 'fact', text: row.text.slice(0, 500),
      sourceMessageIds: [], confirmation: 'confirmed', updatedAt: Date.now(),
    })).filter(row => { const size = row.text.length + 8; if (size > budget) return false; budget -= size; return true; });
  }
  // The N.E.K.O. backend extracts facts from complete turns; it does not use
  // the workbench's independent candidate-proposal store.
  async propose() {}
  async list() {
    const result = await this.service.request('/f07/facts/' + encodeURIComponent(this.character));
    if (!Array.isArray(result.facts)) throw Error('记忆列表无效');
    return result.facts.filter(row => typeof row.text === 'string').map((row, index) => ({
      id: String(row.id || 'neko-' + index), personaId: this.personaId, kind: 'fact', text: row.text,
      sourceMessageIds: [], confirmation: 'confirmed', updatedAt: Date.parse(row.created_at || '') || 0,
    }));
  }
  async confirm() { throw Error('请在 N.E.K.O. 记忆管理中操作'); }
  async update() { throw Error('请在 N.E.K.O. 记忆管理中操作'); }
  async remove() { throw Error('请在 N.E.K.O. 记忆管理中操作'); }
  commitTurn(user, assistant) {
    const task = this.tail.then(async () => {
      if (user.personaId !== this.personaId || assistant.personaId !== this.personaId) throw Error('角色记忆不匹配');
      if (this.queue.some(item => item.id === assistant.id)) return;
      const item = { id: assistant.id, state: 'pending', user: user.text, assistant: assistant.text };
      this.queue.push(item); this.save();
      item.state = 'sending'; this.save();
      try {
        const result = await this.service.request('/cache/' + encodeURIComponent(this.character), { method: 'POST', timeoutMs: 10000,
          body: { input_history: JSON.stringify([{ role: 'user', content: item.user }, { role: 'assistant', content: item.assistant }]), language: 'zh' } });
        if (result.status !== 'cached') throw Error('记忆服务未确认写入');
        this.queue = this.queue.filter(row => row !== item); this.save();
        if (!this.error.startsWith('N.E.K.O. 记忆检索失败')) this.error = this.queue.some(row => row.state === 'unknown' || row.state === 'pending') ? '有记忆写入尚未完成或结果待确认，未自动重复发送' : '';
      } catch (error) {
        item.state = 'unknown'; this.save(); this.error = '记忆写入结果待确认，未自动重复发送'; throw error;
      }
    });
    this.tail = task.catch(() => {}); return task;
  }
}
module.exports = { NekoMemoryProvider };
