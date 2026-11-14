import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.mjs';
import { createCommunitySeatAuthorizer } from '../server/community-seats.mjs';
import { createOllamaAgent, listOllamaModels } from '../server/ollama-agent.mjs';

const script = fileURLToPath(new URL('./deepseek-seat-dsh.cjs', import.meta.url));
const gameTitle = '蘑菇岛 · 双人跳跳';
const clientVersion = '0.2.2-rc.1';

// Keep the DeepSeek ID private and in a distinct namespace from N.E.K.O. IDs.
function seatIdentity(profile, identityKey) {
  if (profile?.status !== 'ready' || typeof profile.id !== 'string' || !profile.id.trim() || profile.id.length > 256) return null;
  const hex = createHmac('sha256', identityKey).update('nekofans:deepseek-seat:v1\0' + profile.id).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { id, name: typeof profile.name === 'string' ? profile.name : 'DeepSeek 玩家' };
}

export async function startDshProfile({ executable, cli, directory }) {
  const dshHome = path.join(directory, 'dsh');
  const patch = path.join(directory, 'dsh.patch.json');
  await mkdir(dshHome, { recursive: true });
  await writeFile(patch, JSON.stringify([
    { id: 'credentials', config: { path: path.join(dshHome, '.credentials.yaml') } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
    { insert: [{ id: 'nekofans-local-game-seat', name: script }] },
  ]));
  const child = spawn(executable, [cli, '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, DSH_HOME: dshHome, DSH_CLIENT_VERSION: clientVersion, DSH_TELEMETRY_MODE: 'DISABLED', ELECTRON_RUN_AS_NODE: '1' },
  });
  const pending = new Map();
  let sequence = 0;
  let available = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.ready === true) available = true;
    pending.get(message.id)?.(message.result);
  });
  const close = () => {
    available = false;
    for (const finish of pending.values()) finish({ status: 'unavailable' });
  };
  child.on('error', close);
  child.on('exit', close);
  child.stdin.on('error', close);
  return {
    request(action, payload, signal) {
      if (signal?.aborted) return Promise.resolve({ status: 'unavailable' });
      if (!available) return Promise.resolve({ status: 'unavailable' });
      const id = ++sequence;
      return new Promise(resolve => {
        const finish = result => { clearTimeout(timer); pending.delete(id); signal?.removeEventListener('abort', cancel); resolve(result); };
        const cancel = () => {
          if (available && action === 'choose') child.stdin.write(JSON.stringify({ id, action: 'cancel-choice' }) + '\n');
          finish({ status: 'unavailable' });
        };
        const timer = setTimeout(cancel, action === 'choose' ? 23000 : 12000);
        pending.set(id, finish);
        signal?.addEventListener('abort', cancel, { once: true });
        child.stdin.write(JSON.stringify({ id, action, payload }) + '\n');
      });
    },
    get ready() { return available; },
    stop() { child.stdin.end(); },
  };
}

const shell = (title, content) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{background:#edf3fb;color:#243654;font:16px system-ui;margin:0}main{max-width:520px;margin:10vh auto;padding:28px;background:white;border-radius:16px}a{display:block;margin:12px 0;color:#234c98}p{line-height:1.55}</style><main><h1>${title}</h1>${content}</main></html>`;

export async function startTrial({ gamePort, identityPort, profiles, directory = null, identityKey = randomBytes(32), simulated = false,
  chooseLocalAction, defaultOllamaModel, ollamaFetch = fetch }) {
  const gameOrigin = `http://127.0.0.1:${gamePort}`;
  const issuer = `http://localhost:${identityPort}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const cookieIds = profiles.map(() => randomBytes(24).toString('base64url'));
  const sessions = new Map(cookieIds.map((id, index) => [id, profiles[index]]));
  const accountProfiles = new Map();
  const useOllama = simulated || Boolean(defaultOllamaModel);
  let lastOllamaCheck = 0, ollamaCatalog, pendingDiscovery;
  function discoverOllama() {
    if (!useOllama) return { status: 'disabled', models: [] };
    if (Date.now() - lastOllamaCheck < 2500 && ollamaCatalog) return ollamaCatalog;
    pendingDiscovery ??= listOllamaModels({ fetchImpl: ollamaFetch }).then(result => {
      lastOllamaCheck = Date.now();
      ollamaCatalog = result;
      return result;
    }).finally(() => { pendingDiscovery = undefined; });
    return pendingDiscovery;
  }
  const app = createApp({ directory, publicOrigin: gameOrigin, publishKey: '', community: { issuer, publicKey, label: simulated ? '模拟 DeepSeek' : 'DeepSeek' },
    async listAgentModels() {
      const ollama = await discoverOllama();
      const models = [{ id: 'default', label: simulated ? '模拟模型' : 'DeepSeek · DSH' },
        ...ollama.models.map(name => ({ id: 'ollama:' + name, label: 'Ollama · ' + name }))];
      const preferred = 'ollama:' + defaultOllamaModel;
      return { models, preferredModel: models.some(model => model.id === preferred) ? preferred : 'default', ollama: ollama.status };
    },
    async chooseAgentAction({ accountId, player, observation, choices, signal, model, rules }) {
      const profile = accountProfiles.get(accountId);
      if (!profile || seatIdentity(await profile.request('profile', undefined, signal), identityKey)?.id !== accountId) {
        throw Object.assign(Error('请重新登录 DeepSeek 并入座'), { status: 403 });
      }
      if (model.startsWith('ollama:')) {
        const name = model.slice('ollama:'.length);
        if (!(await discoverOllama()).models.includes(name)) throw Object.assign(Error('所选 Ollama 模型不可用，请刷新模型列表'), { status: 422 });
        return createOllamaAgent({ model: name, fetchImpl: ollamaFetch })({ player, observation, choices, signal, rules });
      }
      if (model !== 'default') throw Object.assign(Error('所选模型不可用'), { status: 400 });
      if (chooseLocalAction) return chooseLocalAction({ player, observation, choices, signal, rules });
      const result = await profile.request('choose', { instruction: rules + '只输出一个十进制动作编号。', player, observation, choices }, signal);
      if (result?.status === 'unavailable') throw Object.assign(Error('大肥鱼暂时不可用，请检查 DeepSeek 登录'), { status: 503 });
      return result?.choiceId;
    },
  });
  const examples = [
    { file: 'two-player.html', title: '一起落一颗星 · 双人井字棋', mode: 'turns' },
    { file: 'mushroom-trail.html', title: gameTitle, mode: 'shared' },
  ];
  const [, game] = await Promise.all(examples.map(async ({ file, title, mode }) =>
    app.platform.publish({ title, mode, html: await readFile(new URL('../examples/' + file, import.meta.url), 'utf8') })));
  const gameUrl = gameOrigin + '/?game=' + game.id;
  const authorize = createCommunitySeatAuthorizer({ issuer, gameOrigin, privateKey, authenticate: req => req.seatIdentity });

  const identity = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.headers.host !== `localhost:${identityPort}`) { res.writeHead(403); return res.end(); }
    const url = new URL(req.url, issuer);
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('neko_dsh_trial='));
    const session = sessions.get(cookie?.slice('neko_dsh_trial='.length));
    const launcher = async (profile, returnPath) => {
      let state = await profile.request('profile');
      if (state.status === 'signed-out') state = await profile.request('login');
      let link = '';
      if (state.status === 'waiting-browser') {
        const loginUrl = new URL(state.url);
        if (loginUrl.origin === 'https://platform.deepseek.com') {
          link = `<a href="${loginUrl.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" target="_blank" rel="noopener noreferrer">打开 DeepSeek 官方登录</a>`;
        }
      }
      if (state.status === 'ready') return true;
      const preparing = state.status === 'initializing';
      const message = link ? '在新标签页登录，再回这里继续。' : preparing ? '正在准备 DeepSeek 官方登录。' : '账号服务暂时不可用，请重试。';
      const refresh = preparing ? '<meta http-equiv="refresh" content="2">' : '';
      res.end(shell('连接 DeepSeek 账号', `${refresh}<p>${message}</p>${link}<a href="${returnPath}">继续检查登录</a>`));
      return false;
    };
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        const title = simulated ? '游戏工坊 · 本地试玩' : '游戏工坊 · DeepSeek 联机测试';
        const note = simulated ? '<p>这里使用模拟账号，打开普通窗口和无痕窗口就能试两边。</p>' : '';
        return res.end(shell(title, `${note}<p>先用玩家一选项目建房，再把房间链接发给玩家二。</p><form method="post" action="/player/1"><button>连接玩家一</button></form><form method="post" action="/player/2"><button>连接玩家二</button></form>`));
      }
      const player = /^\/player\/([12])$/.exec(url.pathname);
      if (player) {
        const index = Number(player[1]) - 1;
        if (req.method === 'POST' && req.headers.origin === issuer) {
          res.setHeader('Set-Cookie', `neko_dsh_trial=${cookieIds[index]}; HttpOnly; SameSite=Lax; Path=/`);
          res.writeHead(303, { Location: url.pathname });
          return res.end();
        }
        if (req.method !== 'GET' || session !== profiles[index]) { res.writeHead(403); return res.end(); }
        if (await launcher(profiles[index], url.pathname)) {
          if (index === 0) { res.writeHead(303, { Location: gameOrigin + '/#projects' }); return res.end(); }
          return res.end(shell('玩家二已连接', '<p>现在可以打开玩家一发来的房间邀请。</p>'));
        }
        return;
      }
      if (url.pathname === '/game-seats/authorize' && req.method === 'GET') {
        if (!session) return res.end(shell('请选择测试玩家', '<p>先在同一个浏览器窗口连接玩家账号，再重新打开房间邀请。</p><a href="/" target="_blank" rel="noopener">打开测试入口</a>'));
        req.seatIdentity = seatIdentity(await session.request('profile'), identityKey);
        if (!req.seatIdentity) {
          return res.end(shell('需要 DeepSeek 登录', '<p>在同一个浏览器窗口连接玩家账号，再重新打开房间邀请。</p><a href="/" target="_blank" rel="noopener">打开测试入口</a>'));
        }
        const result = await authorize(req, url.searchParams);
        if (result.status === 200) accountProfiles.set(req.seatIdentity.id, session);
        res.writeHead(result.status === 200 ? 303 : result.status, result.location ? { Location: result.location } : {});
        return res.end();
      }
      res.writeHead(404); res.end();
    } catch {
      res.writeHead(503); res.end(shell('暂时无法连接账号', '<a href="/">回到测试入口</a>'));
    }
  });
  await new Promise((resolve, reject) => identity.once('error', reject).listen(identityPort, 'localhost', resolve));
  try {
    await new Promise((resolve, reject) => app.server.once('error', reject).listen(gamePort, '127.0.0.1', resolve));
  } catch (error) {
    await new Promise(resolve => identity.close(resolve));
    throw error;
  }
  return { app, issuer, gameOrigin, gameUrl, close: async () => {
    await Promise.all([app.close(), new Promise(resolve => identity.close(resolve))]);
    for (const profile of profiles) profile.stop?.();
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [application, trialDir] = process.argv.slice(2);
  if (!application || !trialDir || !path.isAbsolute(application) || !path.isAbsolute(trialDir)) throw Error('需要 Nekofans 应用目录和独立测试目录的绝对路径');
  const executable = path.join(application, 'NEKOfuns.exe');
  const cli = path.join(application, 'resources/dsh/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  await mkdir(trialDir, { recursive: true });
  const keyPath = path.join(trialDir, 'identity.key');
  try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const identityKey = await readFile(keyPath);
  if (identityKey.length !== 32) throw Error('测试身份密钥无效');
  const profiles = await Promise.all([1, 2].map(player => startDshProfile({ executable, cli, directory: path.join(trialDir, `player-${player}`) })));
  try {
    const trial = await startTrial({ gamePort: 3095, identityPort: 3096, profiles, directory: path.join(trialDir, 'rooms'), identityKey });
    console.log(trial.issuer);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => trial.close().then(() => process.exit(0)));
  } catch (error) {
    for (const profile of profiles) profile.stop();
    throw error;
  }
}
