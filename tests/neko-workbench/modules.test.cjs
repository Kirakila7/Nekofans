'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '../../apps/neko-workbench');
const { migrateChatRouting, actorBySession } = require(path.join(base, 'chat-routing.cjs'));
const { cleanPrompt, humanMessage, acceptHuman, preview, historyContext } = require(path.join(base, 'pet-context.js'));
const { catalogOrder, selectHelpers, nickname, displayName } = require(path.join(base, 'pet-roster.cjs'));
const { readOriginalSize, petLayout } = require(path.join(base, 'pet-layout.cjs'));

test('main companion and real DSH child sessions keep separate identity and activity', () => {
  const state = { rootId: 'root', actors: [{ id: 'main', sessionId: 'root', name: '大肥鱼', messages: [] },
    { id: 'subagent-child', sessionId: 'child', parentSessionId: 'root', work: { state: 'working' } }] };
  migrateChatRouting(state);
  assert.equal(state.neko.enabled, false);
  assert.equal(state.actors[0].chatBackend, 'chat-api');
  assert.equal(state.actors[0].sessionId, null);
  assert.equal(actorBySession(state, 'root'), state.dshRoot);
  assert.equal(actorBySession(state, 'child'), state.actors[1]);
  assert.equal(preview({ ...state.actors[0], activeChildren: 2, displayWork: { task: '后台工作' } }).work, '陪你聊天');
  assert.equal(state.actors[1].work.state, 'working');
  migrateChatRouting(state);
  assert.equal(state.neko.enabled, false, 'state migration never opts into a real service');
});

test('task preview uses actual human messages and excludes delegated seed and internal context', () => {
  const message = (kind, text, time) => ({ type: 'user/message', time, data: { source: { kind }, content: [{ type: 'text', text }] } });
  const internal = '你好\n\n[桌宠本地上下文]\nprivate task notes';
  assert.equal(cleanPrompt(internal), '你好');
  for (const kind of ['agent-message', 'runtime-context', 'goal', 'subagent-settled']) assert.equal(humanMessage(message(kind, 'internal', 1)), null);
  const actor = { id: 'subagent-child', dshName: '统计 CSV', status: 'success', messages: [] };
  acceptHuman(actor, humanMessage(message('user', internal, 20)));
  acceptHuman(actor, humanMessage(message('user', '旧消息', 10)));
  assert.equal(preview(actor).lastUser, '你好');
  const seed = { ...message('user', 'delegated seed', 1), seq: 9 };
  const history = historyContext({ events: [seed, message('user', '实际跟进', 2)], inheritedEventCount: 0 }, true);
  assert.equal(history.lastUserMessage.text, '实际跟进');
  assert.equal(history.delegatedPromptSeq, 9);
});

test('real catalog ordering, pinned helpers and local nicknames retain stable session routing', () => {
  const tree = new Map([['root', ['second', 'first']], ['second', ['nested']]]);
  assert.deepEqual(catalogOrder('root', tree), ['second', 'nested', 'first']);
  const helpers = ['first', 'second', 'nested'].map(sessionId => ({ id: `subagent-${sessionId}`, sessionId, metadataReady: true, active: true }));
  helpers[0].pinned = true;
  assert.deepEqual(selectHelpers(helpers, catalogOrder('root', tree), 2, 100).map(item => item.sessionId), ['first', 'second']);
  const named = { ...helpers[1], dshName: '真实任务', nickname: nickname('小鲸鱼') };
  assert.equal(displayName(named), '小鲸鱼');
  named.dshName = '更新后的真实任务';
  assert.equal(named.sessionId, 'second');
  assert.equal(displayName(named), '小鲸鱼');
  assert.throws(() => nickname('name\nspoof'));
});

test('pet dimensions are configured in this copy without reading the global DSH profile', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-workbench-layout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(readOriginalSize(directory).stageWidth, 462);
  fs.writeFileSync(path.join(directory, 'pet-config.jsonc'), '// independent copy\n{"pets":[{"id":"main","size":320}]}');
  const original = readOriginalSize(directory);
  assert.equal(original.stageWidth, 320);
  assert.equal(original.source, path.join(directory, 'pet-config.jsonc'));
  assert.equal(petLayout(true, original).stageWidth, 320);
  assert.equal(petLayout(false, original).stageWidth, 239);
});

for (const script of ['check-workbench.cjs', 'check-workbench-roles.cjs',
  'embedded-dsh/check-skin-patch.cjs', 'embedded-dsh/check-avatar-theme.cjs',
  'embedded-dsh/check-account-habitat.cjs', 'embedded-dsh/check-sidebar-avatar-accessibility.cjs',
  'embedded-dsh/b0-skin/packages/dsh-client-ui-skin/scripts/smoke.mjs',
  'embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/scripts/smoke.mjs']) {
  test(`preserved offline module check: ${script}`, () => {
    const result = spawnSync(process.execPath, [path.join(base, script)], { encoding: 'utf8', cwd: os.tmpdir() });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}

test('source snapshot excludes installed runtimes, sessions, private evidence and reference photos', () => {
  const forbidden = new Set(['data', 'runtime', 'workspaces', 'evidence', 'node_modules', 'claude-delivery', 'references']);
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'SOURCE_SNAPSHOT.json'), 'utf8'));
  assert.equal(manifest.sourceVersion, '0.13.0');
  assert.deepEqual(manifest.sourceFilesChangedDuringCapture, []);
  for (const record of manifest.files) {
    assert(!record.path.split('/').some(part => forbidden.has(part)), record.path);
    assert(!record.path.endsWith('.zip'), record.path);
    assert(!record.path.endsWith('neko-character-reference.jpg'), record.path);
    assert(!['verification.json', 'reference-test-results.txt'].includes(path.basename(record.path)), record.path);
    assert.equal(typeof record.sha256, 'string');
  }
  for (const name of ['assets/LICENSE.dsh-pet', 'assets/sources.json', 'original/SOURCE.json', 'embedded-dsh/SOURCE.json']) assert(fs.existsSync(path.join(base, name)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).type, 'commonjs');
});
