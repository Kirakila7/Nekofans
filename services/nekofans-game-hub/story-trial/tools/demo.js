'use strict';

/*
 * 本地演示/截图辅助脚本。
 *
 * 创建三个演示房间（仅用于本地界面检查与录制彩排）：
 *   - lobby    : 双方已提交演示占位规则，等待女神审核
 *   - playing  : 已开局，走子使用逐手审核，留有一条待裁决走子和一条待裁定猜测
 *   - finished : 快速模式下走完学者/傻瓜将死，并揭晓演示占位规则
 *
 * 注意：这里的规则文本全部是「演示占位」，不是用户之后要提交的真实隐藏规则，
 * 也不会被写进应用代码。真实规则只应在对局前由双方通过界面提交。
 *
 * 用法：
 *   node server.js                 # 另开一个终端
 *   node tools/demo.js             # 默认 http://127.0.0.1:8787
 *   node tools/demo.js --base http://127.0.0.1:8787 --out data/demo-rooms.json
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { base: process.env.DEMO_BASE || 'http://127.0.0.1:8787', out: 'data/demo-rooms.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base' && argv[i + 1]) args.base = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

const PLACEHOLDER_WHITE = '【演示占位 · 非正式】白方规则：仅用于界面演示，不代表真实隐藏规则';
const PLACEHOLDER_BLACK = '【演示占位 · 非正式】黑方规则：仅用于界面演示，不代表真实隐藏规则';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base.replace(/\/+$/, '');

  async function request(method, pathname, token, body) {
    const url = new URL(base + pathname);
    if (token) url.searchParams.set('token', token);
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(method + ' ' + pathname + ' -> ' + response.status + ' ' + (data.error || ''));
    }
    return data;
  }

  async function createRoom(options) {
    const data = await request('POST', '/api/rooms', null, options);
    const token = (link) => new URL(link).searchParams.get('token');
    return {
      roomId: data.roomId,
      links: data.links,
      tokens: {
        white: token(data.links.white),
        black: token(data.links.black),
        goddess: token(data.links.goddess),
      },
    };
  }

  async function state(room, seat) {
    const token = seat === 'goddess' ? room.tokens.goddess : room.tokens[seat];
    const data = await request('GET', '/api/rooms/' + room.roomId + '/state', token);
    return data.state;
  }

  async function submitRules(room) {
    await request('POST', '/api/rooms/' + room.roomId + '/rule', room.tokens.white, { text: PLACEHOLDER_WHITE });
    await request('POST', '/api/rooms/' + room.roomId + '/rule', room.tokens.black, { text: PLACEHOLDER_BLACK });
  }

  async function approveRules(room) {
    for (const seat of ['white', 'black']) {
      await request('POST', '/api/rooms/' + room.roomId + '/goddess/rule', room.tokens.goddess, {
        seat,
        action: 'approve',
      });
    }
  }

  async function start(room) {
    await request('POST', '/api/rooms/' + room.roomId + '/goddess/start', room.tokens.goddess, {});
  }

  async function playWithReview(room, seat, from, to) {
    const move = await request('POST', '/api/rooms/' + room.roomId + '/move', room.tokens[seat], { from, to });
    const pending = move.state.game.pendingMove;
    if (!pending) throw new Error('逐手审核模式下没有生成待裁决走子');
    await request('POST', '/api/rooms/' + room.roomId + '/goddess/review', room.tokens.goddess, {
      moveId: pending.id,
      decision: 'approve',
    });
  }

  async function playFast(room, seat, from, to) {
    await request('POST', '/api/rooms/' + room.roomId + '/move', room.tokens[seat], { from, to });
  }

  // 1) 等待审核的房间
  const lobby = await createRoom({ reviewMode: true, guessLimit: 3 });
  await submitRules(lobby);

  // 2) 对局中的房间（逐手审核）
  const playing = await createRoom({ reviewMode: true, guessLimit: 3 });
  await submitRules(playing);
  await approveRules(playing);
  await start(playing);
  await request('POST', '/api/rooms/' + playing.roomId + '/goddess/announce', playing.tokens.goddess, {
    text: '女神公告：本局用于本地界面检查，双方请按规则出子。',
  });
  for (const [seat, from, to] of [
    ['white', 'e2', 'e4'],
    ['black', 'e7', 'e5'],
    ['white', 'g1', 'f3'],
    ['black', 'b8', 'c6'],
    ['white', 'f1', 'c4'],
    ['black', 'g8', 'f6'],
  ]) {
    await playWithReview(playing, seat, from, to);
  }
  // 留一条待裁决走子（白方）
  await request('POST', '/api/rooms/' + playing.roomId + '/move', playing.tokens.white, { from: 'd2', to: 'd4' });
  // 再留一条待裁定猜测（黑方）
  await request('POST', '/api/rooms/' + playing.roomId + '/guess', playing.tokens.black, {
    text: '【演示占位猜测】我猜白方规则与「先手台词」有关。',
  });

  // 3) 已结束并揭晓的房间（快速模式，傻瓜将死）
  const finished = await createRoom({ reviewMode: false, guessLimit: 3 });
  await submitRules(finished);
  await approveRules(finished);
  await start(finished);
  for (const [seat, from, to] of [
    ['white', 'f2', 'f3'],
    ['black', 'e7', 'e5'],
    ['white', 'g2', 'g4'],
    ['black', 'd8', 'h4'],
  ]) {
    await playFast(finished, seat, from, to);
  }
  await request('POST', '/api/rooms/' + finished.roomId + '/goddess/rule', finished.tokens.goddess, {
    seat: 'both',
    action: 'reveal',
  });

  const output = {
    generatedAt: new Date().toISOString(),
    base,
    note: '演示占位规则与猜测，仅用于界面检查；真实隐藏规则应在对局前由双方通过界面提交。',
    rooms: { lobby, playing, finished },
  };
  const outPath = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('演示房间已创建（数据写入 ' + outPath + '）：');
  console.log('');
  for (const [name, room] of Object.entries(output.rooms)) {
    console.log('【' + name + '】房间 ' + room.roomId);
    console.log('  白方 : ' + room.links.white);
    console.log('  黑方 : ' + room.links.black);
    console.log('  女神 : ' + room.links.goddess);
    console.log('');
  }
  console.log('提示：女神链接含私密令牌，不要放进共享/录制画面。');
}

main().catch((error) => {
  console.error('演示房间创建失败：' + error.message);
  console.error('请确认本地服务已启动：node server.js');
  process.exitCode = 1;
});
