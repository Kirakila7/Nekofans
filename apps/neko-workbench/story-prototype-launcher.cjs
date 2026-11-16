'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const FIXED_ORIGIN = 'http://127.0.0.1:8787';
const SEATS = ['white', 'black', 'goddess'];

function roomLink(value, origin, roomId) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.hash ||
      url.pathname !== '/room/' + roomId || url.searchParams.size !== 1 ||
      !url.searchParams.get('token')) throw Error('Invalid local room link');
  return url.href;
}

// Only the main process supplies executable and project paths. Role links and
// credentials stay here and in the selected local browser page.
function createStoryPrototypeLauncher({projectDir, executable, relay, dataDir, fetchImpl = fetch}) {
  const root = typeof projectDir === 'string' && path.isAbsolute(projectDir) ? projectDir : null;
  const bundled = Boolean(dataDir);
  let child = null;
  let origin = null;
  let hostToken = null;
  let room = null;
  let starting = false;
  let opening = false;
  let generation = 0;

  async function stop() {
    generation++;
    origin = hostToken = room = null;
    const running = child;
    child = null;
    if (running && running.exitCode === null && running.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL');
          finish();
        }, 1500);
        function finish() {
          clearTimeout(timer);
          running.removeListener('exit', finish);
          resolve();
        }
        running.once('exit', finish);
        running.kill('SIGTERM');
      });
    }
    return relay.stop('story-stopped');
  }

  async function start() {
    if (starting) return {status: 'busy'};
    if (child && child.exitCode === null && child.signalCode === null) return {status: 'running', origin};
    if (!root || !fs.statSync(path.join(root, 'server.js'), {throwIfNoEntry: false})?.isFile()) {
      return {status: 'missing-project'};
    }
    starting = true;
    const current = generation;
    try {
      await relay.stop('story-restart');
      if (current !== generation) return {status: 'cancelled'};
      const info = await relay.start({ttlMs: 2 * 60 * 60 * 1000});
      if (current !== generation) {
        await relay.stop('story-cancelled');
        return {status: 'cancelled'};
      }
      if (info.status !== 'started' || !info.token || !info.baseUrl) return {status: 'bridge-unavailable'};
      const env = Object.fromEntries(['HOME','PATH','TMPDIR','LANG','LC_ALL','LC_CTYPE','USER','SHELL']
        .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
      const running = spawn(executable, [path.join(root, 'server.js')], {
        cwd: root,
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: '1',
          PORT: bundled ? '0' : '8787',
          NEKO_AI_BRIDGE_URL: info.baseUrl,
          NEKO_AI_BRIDGE_TOKEN: info.token,
          NEKO_AI_MODEL: info.model,
          NEKO_AI_BRIDGE_LABEL: info.label,
          ...(bundled ? {DATA_DIR: dataDir, NEKO_STORY_HOSTED: '1'} : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = running;
      running.stdout.setEncoding('utf8');
      const result = await new Promise(resolve => {
        let out = '';
        // First launch of a freshly signed macOS bundle can take longer while
        // the system verifies the executable.
        const timer = setTimeout(() => finish({status: 'timeout'}), bundled ? 30000 : 10000);
        function finish(value) {
          clearTimeout(timer);
          running.stdout.removeListener('data', onData);
          resolve(value);
        }
        function onData(chunk) {
          out = (out + chunk).slice(-4096);
          const match = out.match(/127\.0\.0\.1:(\d{1,5})（仅本机/u);
          if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) {
            const localOrigin = 'http://127.0.0.1:' + match[1];
            if (bundled || localOrigin === FIXED_ORIGIN) finish({status: 'started', origin: localOrigin});
          }
        }
        running.stdout.on('data', onData);
        running.stderr.resume();
        running.once('error', () => finish({status: 'failed'}));
        running.once('exit', () => finish({status: 'failed'}));
      });
      running.stdout.resume();
      if (current !== generation) return {status: 'cancelled'};
      if (result.status !== 'started' || running.exitCode !== null || running.signalCode !== null) {
        await stop();
        return {status: result.status === 'started' ? 'failed' : result.status};
      }
      running.once('exit', () => {
        if (child !== running) return;
        child = origin = hostToken = room = null;
        void relay.stop('story-exited').catch(() => {});
      });
      origin = result.origin;
      hostToken = info.token;
      return result;
    } catch {
      await stop();
      return {status: 'failed'};
    } finally {
      starting = false;
    }
  }

  async function openRoom(openExternal, seat = 'white') {
    if (!SEATS.includes(seat)) return {status: 'invalid-seat'};
    if (opening) return {status: 'busy'};
    opening = true;
    const current = generation;
    try {
      const previous = relay.status();
      if (previous.bound && room?.id !== previous.roomId) return {status: 'already-bound'};
      const startup = await start();
      if (!['started', 'running'].includes(startup.status)) return {status: startup.status};
      if (current !== generation) return {status: 'cancelled'};
      const status = relay.status();
      if (status.bound && room?.id !== status.roomId) return {status: 'already-bound'};
      if (!room) {
        const response = await fetchImpl(origin + '/api/rooms', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: {'content-type': 'application/json', ...(bundled ? {authorization: 'Bearer ' + hostToken} : {})},
          body: JSON.stringify({scenario: 'story-v1', reviewMode: 'manual', guessLimit: 3}),
        });
        if (!response.ok) return {status: 'room-unavailable'};
        const {ok, roomId, links} = await response.json();
        if (current !== generation) return {status: 'cancelled'};
        if (!ok || !/^r-[0-9a-f]{8}$/.test(roomId)) return {status: 'room-unavailable'};
        const openedSeats = bundled ? SEATS : ['white'];
        room = {id: roomId, links: Object.fromEntries(openedSeats.map(role =>
          [role, roomLink(links?.[role], origin, roomId)]))};
      }

      let modelConnected = status.bound === true;
      if (!modelConnected && status.status === 'running') {
        const binding = await relay.bind({roomId: room.id, prototypeOrigin: origin});
        modelConnected = binding.status === 'bound';
        if (!modelConnected && !bundled) return {status: binding.status};
      }
      if (current !== generation || !room) return {status: 'cancelled'};
      if (bundled && modelConnected && !room.modelEnabled) {
        try {
          const result = await fetchImpl(origin + '/api/rooms/' + room.id + '/enable-model', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
            headers: {authorization: 'Bearer ' + hostToken},
          });
          if (current !== generation || !room) return {status: 'cancelled'};
          room.modelEnabled = result.ok;
        } catch {
          if (current !== generation || !room) return {status: 'cancelled'};
        }
        modelConnected = room.modelEnabled === true;
      }
      if (!room.links[seat]) return {status: 'room-unavailable'};
      const roomId = room.id;
      await openExternal(room.links[seat]);
      return {status: 'opened', roomId, ...(bundled ? {modelConnected} : {})};
    } catch {
      return {status: 'room-unavailable'};
    } finally {
      opening = false;
    }
  }
  return {start, stop, openRoom};
}
module.exports = {createStoryPrototypeLauncher};
