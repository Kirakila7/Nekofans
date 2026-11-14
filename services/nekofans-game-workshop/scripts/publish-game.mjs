import { readFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
try {
  const file = args.get('--file'), server = args.get('--server') || process.env.NEKOFANS_GAME_SERVER, key = process.env.NEKOFANS_PUBLISH_KEY;
  if (!file || !server || !key) throw new Error('请传 --file 文件 --server 服务地址；发布凭证从 NEKOFANS_PUBLISH_KEY 环境变量读取');
  const origin = new URL(server);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('服务地址应为 http(s)://主机，不含凭证或参数');
  const html = await readFile(path.resolve(file), 'utf8');
  if (!html.includes('NekofansGame.connect')) throw new Error('HTML 尚未接入 NekofansGame.connect，请先按联机提示词生成或改造');
  async function post(route, body, authorized = false) {
    const response = await fetch(new URL(route, origin), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  const game = await post('/api/games', { title: args.get('--title') || path.basename(file).replace(/\.html?$/i, ''), mode: args.get('--mode') || 'turns', html }, true);
  console.log(JSON.stringify({ title: game.title, gameId: game.id, gameUrl: new URL('/?game=' + game.id, origin).href, next: '打开作品链接创建房间，再复制房间邀请到聊天室。此脚本不会自动发送公共消息。' }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
