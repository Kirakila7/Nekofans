'use strict';

// Track close, which also follows spawn errors that never emit exit. All signals
// target this instance's ChildProcess; no process-name or global runtime kill.
function createDshLifecycle(child, { onError = () => {}, onClose = () => {},
  schedule = setTimeout, cancel = clearTimeout, graceMs = 1000, forceMs = 4000, deadlineMs = 5000 } = {}) {
  let closed = false, spawned = child.pid != null, failure = null, stopPromise, resolveStop;
  const timers = [];
  const clearTimers = () => { for (const timer of timers.splice(0)) cancel(timer); };
  const completeStop = timedOut => {
    clearTimers();
    resolveStop?.({ timedOut });
    resolveStop = null;
  };
  child.once('spawn', () => { spawned = true; });
  child.on('error', error => { failure = error; onError(error); });
  child.once('close', (code, signal) => {
    if (closed) return;
    closed = true;
    completeStop(false);
    onClose({ code, signal, error: failure });
  });
  function stop() {
    if (closed || !spawned) return Promise.resolve({ timedOut: false });
    if (stopPromise) return stopPromise;
    stopPromise = new Promise(resolve => { resolveStop = resolve; });
    const send = signal => {
      if (closed) return;
      try { child.kill(signal); } catch (error) { failure = error; onError(error); }
    };
    timers.push(schedule(() => send('SIGTERM'), graceMs));
    timers.push(schedule(() => send('SIGKILL'), forceMs));
    // A broken process/pipe must not keep an explicit application quit pending.
    timers.push(schedule(() => completeStop(true), deadlineMs));
    child.stdin?.once?.('error', () => {}); // stdin can close before graceful EOF.
    try { child.stdin?.end(); } catch (error) { failure = error; onError(error); }
    return stopPromise;
  }
  return Object.freeze({ get closed() { return closed; }, get spawned() { return spawned; }, stop });
}

module.exports = { createDshLifecycle };
