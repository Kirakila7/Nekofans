'use strict';

/*
 * DOM 静态回归：A/B 共用的玩家视图片段不得包含 B 的能力名或真名输入。
 * 真正的动态 DOM（SSE 后 A 页面）由 Chromium 双席检查覆盖；这里守住模板。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('玩家视图片段不包含对方能力命名/真名输入', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('<div id="playerView"');
  const end = html.indexOf('<div id="goddessView"');
  assert.ok(start >= 0, 'playerView 存在');
  assert.ok(end > start, 'goddessView 在 playerView 之后');
  const playerView = html.slice(start, end);

  for (const forbidden of ['真名', '抹除', 'erase', 'erase-king', 'erase-attempt', 'erase-note']) {
    assert.equal(playerView.includes(forbidden), false, '玩家模板不应包含 ' + forbidden);
  }
  assert.match(playerView, /<div id="privateActionBox" hidden><\/div>/, 'B 私密面板由脚本动态创建');
  assert.match(playerView, /id="teammateCard"/, 'A 大肥鱼面板保留');
  assert.match(playerView, /id="specialList"/, '公开行动池保留');

  // 女神私密面板必须存在，但静态模板只能用中性标签。
  const goddessView = html.slice(end);
  assert.ok(goddessView.includes('私密信息'));
  assert.ok(goddessView.includes('私密行动'));

  // 公共静态资源整体扫描：能力文案/真名线索只允许由服务端按席位下发。
  const publicDir = path.join(__dirname, '..', 'public');
  const forbiddenInAssets = [
    '真名', '抹除', '开源', '共享走法', 'erase', 'open-source', 'erase-note',
    'erase-king', 'erase-attempt', 'trueName', 'privateName', '名称', 'pool', '梁文峰', '梁武帝', '小泡泡',
  ];
  for (const name of fs.readdirSync(publicDir)) {
    const file = path.join(publicDir, name);
    if (!fs.statSync(file).isFile()) continue;
    if (!/\.(html|js|css|svg)$/.test(name)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const forbidden of forbiddenInAssets) {
      assert.equal(text.includes(forbidden), false, name + ' 公共静态资源不应包含 ' + forbidden);
    }
  }
});
