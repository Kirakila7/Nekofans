'use strict';
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

// A private process per utterance avoids exposing an unauthenticated localhost
// speech service. Killing it also closes its upstream socket on interruption.
function createTtsController({ repositoryRoot, python, onEvent = () => {}, spawnImpl = spawn, timeoutMs = 90000 } = {}) {
  if (!repositoryRoot) throw new Error('repositoryRoot required');
  const script = path.join(repositoryRoot, 'apps/neko-workbench/tts-worker.py');
  const bundled = path.join(repositoryRoot, process.platform === 'win32' ? 'services/neko-memory/.venv/Scripts/python.exe' : 'services/neko-memory/.venv/bin/python');
  const interpreter = python || process.env.NEKO_TTS_PYTHON || (fs.existsSync(bundled) ? bundled : 'python');
  let active = null, closed = false;
  function emit(value) { try { onEvent(value); } catch {} }
  function finish(item, type, message) {
    if (!item || item.done) return;
    item.done = true; clearTimeout(item.timer);
    if (active === item) active = null;
    item.lines?.close();
    if (!item.process.killed && item.process.exitCode === null) item.process.kill();
    emit({ requestId: item.id, type, ...(message ? { message } : {}) });
  }
  function stop(requestId) {
    if (active && (!requestId || requestId === active.id)) finish(active, 'stopped');
  }
  function speak(text, requestId) {
    if (closed) throw new Error('语音服务已关闭');
    if (typeof text !== 'string' || !text.trim() || text.length > 8000 || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('语音请求无效');
    stop();
    let proc;
    try { proc = spawnImpl(interpreter, ['-u', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } }); }
    catch { throw new Error('无法启动 N.E.K.O. 语音环境'); }
    const item = { id: requestId, process: proc, done: false }; active = item;
    item.timer = setTimeout(() => finish(item, 'error', 'N.E.K.O. 语音请求超时'), timeoutMs);
    proc.on('error', () => finish(item, 'error', '无法启动 N.E.K.O. 语音环境'));
    // `close` fires after stdout is drained. On `exit`, the final audio/ended
    // frame may still be buffered and would otherwise be discarded as an error.
    proc.on('close', () => finish(item, 'error', 'N.E.K.O. 免费语音暂不可用'));
    proc.stdin.on('error', () => finish(item, 'error', 'N.E.K.O. 免费语音暂不可用'));
    item.lines = readline.createInterface({ input: proc.stdout });
    item.lines.on('line', line => {
      if (active !== item || item.done) return;
      if (line.length > 4 * 1024 * 1024) return finish(item, 'error', '语音数据过大');
      let msg; try { msg = JSON.parse(line); } catch { return finish(item, 'error', '语音数据无效'); }
      if (msg.type === 'audio' && typeof msg.pcm === 'string' && /^[a-zA-Z0-9+/]*={0,2}$/.test(msg.pcm) && msg.sampleRate === 48000) emit({ requestId, type: 'audio', pcm: msg.pcm, sampleRate: 48000 });
      else if (msg.type === 'ended') finish(item, 'ended');
      else if (msg.type === 'error') finish(item, 'error', 'N.E.K.O. 免费语音暂不可用');
      else finish(item, 'error', '语音数据无效');
    });
    try { proc.stdin.end(JSON.stringify({ text }) + '\n'); } catch { finish(item, 'error', 'N.E.K.O. 免费语音暂不可用'); }
    return requestId;
  }
  function close() { closed = true; stop(); }
  return { speak, stop, close };
}
module.exports = { createTtsController };
