'use strict';
const { randomUUID } = require('node:crypto');
const { imageParts } = require('./screen-vision.cjs');
const silent = text => '[安静]'.startsWith(text.trim()) || text.trim().startsWith('[安静]');
class ScreenObservation {
  constructor({ observe, onState = () => {}, onReply = () => {}, isChatBusy = () => false, now = Date.now, intervalMs = 6000, maxRequests = 120 } = {}) {
    this.observe = observe; this.onState = onState; this.onReply = onReply; this.isChatBusy = isChatBusy;
    this.now = now; this.intervalMs = intervalMs; this.maxRequests = maxRequests;
    this.generation = 0; this.phase = 'idle'; this.requests = 0; this.records = []; this.seq = 0; this.lastAt = 0;
    this.source = null; this.active = null; this.latest = null; this.question = ''; this.error = ''; this.reply = null; this.capability = 'unverified';
  }
  read() { return { phase: this.phase, generation: this.generation, source: this.source, requests: this.requests,
    limit: this.maxRequests, error: this.error, reply: this.reply, records: this.records.slice(-30), capability: this.capability, audio: false }; }
  publish() { this.onState(this.read()); }
  invalidate() {
    this.generation++; clearTimeout(this.timer); this.timer = null; this.latest = null; this.question = ''; this.reply = null;
    this.active?.controller.abort(); this.onReply(null); this.seq = 0;
  }
  start(source, target, contextConsent = null) {
    if (!source || typeof source.id !== 'string' || !/^(window|screen):[0-9]+:[0-9]+$/.test(source.id)) throw new Error('请先选择一个窗口或屏幕');
    const sameSource = this.source?.id === source.id;
    this.invalidate(); this.source = { id: source.id, name: String(source.name).slice(0, 200) }; this.target = target; this.contextConsent = contextConsent; this.phase = 'sharing';
    this.records = sameSource ? this.records : []; this.requests = 0; this.lastAt = -Infinity; this.error = ''; this.capability = 'unverified'; this.publish(); return this.read();
  }
  pause(reason = '') { this.invalidate(); this.phase = this.source ? 'paused' : 'idle'; this.error = reason; this.publish(); return this.read(); }
  stop() { this.invalidate(); this.target = null; this.contextConsent = null; this.phase = 'idle'; this.source = null; this.error = ''; this.publish(); return this.read(); }
  frame(value) {
    if (this.phase !== 'sharing' || value?.generation !== this.generation) return { accepted: false };
    if (!Number.isSafeInteger(value.seq) || value.seq <= this.seq || !Number.isFinite(value.capturedAt)
      || Math.abs(this.now() - value.capturedAt) > 15000 || !Number.isInteger(value.width) || !Number.isInteger(value.height)
      || value.width < 1 || value.height < 1 || value.width > 1280 || value.height > 1280) throw new Error('画面序号、时间或尺寸无效');
    imageParts(value.image); this.seq = value.seq;
    this.latest = { image: value.image, seq: value.seq, capturedAt: value.capturedAt, width: value.width, height: value.height };
    void this.pump(); return { accepted: true };
  }
  ask(text) {
    if (this.phase !== 'sharing') throw new Error('请先开始共享画面');
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('请输入 1～2000 字的问题');
    if (this.question) throw new Error('还有一个问题在等待画面，请稍等再发送');
    this.question = text.trim();
    if (this.active && !this.active.question) this.active.controller.abort();
    void this.pump(); return { queued: true };
  }
  async pump() {
    if (this.phase !== 'sharing' || this.active || !this.latest) return;
    clearTimeout(this.timer); this.timer = null;
    const delay = this.isChatBusy() ? 500 : this.question ? 0 : this.intervalMs - (this.now() - this.lastAt);
    if (delay > 0) { this.timer = setTimeout(() => void this.pump(), delay); this.timer.unref?.(); return; }
    if (this.requests >= this.maxRequests) { this.pause('已达到本轮 120 次请求上限，重新开始前请检查用量'); return; }
    const frame = this.latest; this.latest = null;
    const question = this.question; this.question = '';
    const active = { id: randomUUID(), generation: this.generation, controller: new AbortController(), question, frame };
    this.active = active; this.requests++; this.lastAt = this.now(); this.error = ''; this.publish();
    const valid = () => this.phase === 'sharing' && active.generation === this.generation && !active.controller.signal.aborted;
    try {
      const result = await this.observe({ frame, question, history: this.records, target: this.target, contextConsent: this.contextConsent, signal: active.controller.signal,
        onText: text => { if (!valid() || silent(text)) return; this.reply = { id: active.id, text, streaming: true, source: 'screen' }; this.onReply(this.reply); this.publish(); } });
      if (!valid()) return;
      this.capability = 'responded'; this.reply = null;
      if (!silent(result.text) && result.text !== this.records.at(-1)?.text) {
        const record = { id: active.id, text: result.text, question, capturedAt: frame.capturedAt, elapsedMs: this.now() - this.lastAt, usage: result.usage };
        this.records.push(record); this.records = this.records.slice(-30);
        this.reply = { id: active.id, text: result.text, streaming: false, source: 'screen' }; this.onReply(this.reply);
      } else this.onReply(null);
    } catch (error) {
      if (valid()) this.pause(error?.code ? error.message : '屏幕理解失败，请检查视觉 API 后继续');
    } finally {
      if (this.active === active) this.active = null;
      // No stale frames are retained across pause/source changes. An interrupted auto turn
      // leaves the newest frame available for the explicitly queued question.
      if (this.phase === 'sharing') { this.publish(); void this.pump(); }
    }
  }
}
module.exports = { ScreenObservation, silent };
