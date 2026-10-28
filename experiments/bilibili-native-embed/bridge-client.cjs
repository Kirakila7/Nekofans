const readline = require('node:readline');

// A lost reply invalidates the whole session: EOF asks the native helper to restore.
// Never assign a late reply to another operation or destroy a host on an uncertain attach.
class BridgeClient {
  constructor(process, { timeout = 8000, onEvent = () => {} } = {}) {
    this.process = process;
    this.timeout = timeout;
    this.onEvent = onEvent;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.pending = null;
    this.failure = null;
    this.safeToClose = false;
    this.exited = false;
    this.restoreWaiters = new Set();
    readline.createInterface({ input: process.stdout }).on('line', line => {
      let event;
      try { event = JSON.parse(line.replace(/^\uFEFF/, '')); }
      catch { this.fail(new Error('Malformed native helper response')); return; }
      this.onEvent(event);
      if (event.type === 'bridge-closed') {
        this.safeToClose = event.safeToClose === true;
        for (const waiter of this.restoreWaiters) waiter();
        return;
      }
      if (!this.pending || event.requestId !== this.pending.id) return;
      const current = this.pending;
      this.pending = null;
      clearTimeout(current.timer);
      if (event.type === 'error' || event.type === 'restore-error') current.reject(new Error(event.message));
      else current.resolve(event);
    });
    process.on('error', error => this.fail(error));
    process.stdin.on('error', error => this.fail(error));
    process.on('close', () => {
      this.exited = true;
      this.fail(new Error('Native helper closed'));
      for (const waiter of this.restoreWaiters) waiter();
    });
  }
  fail(error) {
    if (!this.failure) this.failure = error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = null;
    }
    if (!this.process.stdin.destroyed && !this.process.stdin.writableEnded) this.process.stdin.end();
  }
  command(payload) {
    const result = this.queue.then(() => new Promise((resolve, reject) => {
      if (this.failure) { reject(this.failure); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(new Error(`Native helper timed out: ${payload.op}`)), this.timeout);
      this.pending = { id, resolve, reject, timer };
      this.process.stdin.write(JSON.stringify({ ...payload, requestId: id }) + '\n', error => {
        if (error) this.fail(error);
      });
    }));
    this.queue = result.catch(() => {});
    return result;
  }
  waitForRestore() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Native restoration acknowledgement missing; keep host open')), this.timeout);
      const finish = error => {
        clearTimeout(timer);
        this.restoreWaiters.delete(check);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        if (this.safeToClose) finish();
        else if (this.exited) finish(new Error('Helper exited without confirming restoration; keep host open'));
      };
      this.restoreWaiters.add(check);
      check();
    });
  }
}

// Serialize whole lifecycle actions, not just individual native commands.
class SerialSession {
  constructor() { this.queue = Promise.resolve(); this.closing = false; this.closeTask = null; }
  run(action) {
    const result = this.queue.then(() => {
      if (this.closing) throw new Error('Trial is closing');
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  close(action) {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = this.queue.then(action).catch(error => {
      this.closing = false;
      this.closeTask = null;
      throw error;
    });
    this.queue = this.closeTask.catch(() => {});
    return this.closeTask;
  }
}
module.exports = { BridgeClient, SerialSession };
