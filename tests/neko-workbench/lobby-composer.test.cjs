'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const C = require('../../apps/neko-workbench/lobby-composer.js');
const card = (text = '我也想去！', targetId = 'm-target') => ({ id: 'card-1', targetId, text, state: 'ready' });

test('adopting into an empty draft fills it, sets the marker and the reply target', () => {
  const s = C.adopt(C.create(), card(), 'c-mine');
  assert.equal(s.text, '我也想去！'); assert.equal(s.assistCatId, 'c-mine'); assert.equal(s.replyToId, 'm-target');
  assert.equal(s.pendingAdopt, null); assert.equal(s.undo, null);
  assert.deepEqual(C.sendPayload(s), { text: '我也想去！', replyToId: 'm-target', origin: 'human_ai', assistCatId: 'c-mine' });
});

test('a non-empty draft asks first; replace keeps an undo snapshot, append keeps the user text', () => {
  const typed = C.edit(C.create(), '我自己写的');
  const waiting = C.adopt(typed, card(), 'c-mine');
  assert.equal(waiting.text, '我自己写的'); assert.equal(waiting.assistCatId, null); assert(waiting.pendingAdopt);

  const replaced = C.chooseAdopt(waiting, 'replace');
  assert.equal(replaced.text, '我也想去！'); assert.equal(replaced.assistCatId, 'c-mine'); assert.equal(replaced.undo.text, '我自己写的');
  const undone = C.undoReplace(replaced);
  assert.equal(undone.text, '我自己写的'); assert.equal(undone.assistCatId, null); assert.equal(undone.replyToId, null); assert.equal(undone.undo, null);
  assert.equal(C.sendPayload(undone).origin, 'human');

  const appended = C.chooseAdopt(waiting, 'append');
  assert.equal(appended.text, '我自己写的\n我也想去！'); assert.equal(appended.assistCatId, 'c-mine'); assert.equal(appended.undo, null);

  const declined = C.chooseAdopt(waiting, 'cancel');
  assert.equal(declined.text, '我自己写的'); assert.equal(declined.pendingAdopt, null); assert.equal(declined.assistCatId, null);
});

test('without adopting, the payload origin is human', () => {
  const s = C.setReplyTarget(C.edit(C.create(), '  你好  '), 'm-1');
  assert.deepEqual(C.sendPayload(s), { text: '你好', replyToId: 'm-1', origin: 'human' });
  assert.equal(C.sendPayload(C.edit(C.create(), '   ')), null);
});

test('editing an adopted draft keeps the marker; clearing it removes the marker and starts a new epoch', () => {
  let s = C.adopt(C.create(), card(), 'c-mine');
  s = C.edit(s, s.text + '（我改了一下）');
  assert.equal(s.assistCatId, 'c-mine'); assert.equal(C.sendPayload(s).origin, 'human_ai');
  const epoch = s.draftEpoch;
  s = C.edit(s, '');
  assert.equal(s.assistCatId, null); assert.equal(s.draftEpoch, epoch + 1);
  assert.equal(C.sendPayload(C.edit(s, '新写的')).origin, 'human');
});

test('a mode switch keeps the adopted draft and marker but drops a pending choice', () => {
  const adopted = C.adopt(C.create(), card(), 'c-mine');
  assert.deepEqual(C.modeChanged(adopted), adopted);
  const waiting = C.adopt(C.edit(C.create(), '草稿'), card(), 'c-mine');
  const after = C.modeChanged(waiting);
  assert.equal(after.pendingAdopt, null); assert.equal(after.text, '草稿');
});

test('changing the reply target bumps the draft epoch; the same target does not', () => {
  const a = C.setReplyTarget(C.create(), 'm-1'), b = C.setReplyTarget(a, 'm-1'), c = C.setReplyTarget(b, 'm-2');
  assert.equal(b, a); assert.equal(c.draftEpoch, a.draftEpoch + 1); assert.equal(C.setReplyTarget(c, '').replyToId, null);
});

test('sent() resets everything and starts a new epoch; bad cards and cat ids are ignored', () => {
  const s = C.adopt(C.create(), card(), 'c-mine'), after = C.sent(s);
  assert.equal(after.text, ''); assert.equal(after.assistCatId, null); assert.equal(after.replyToId, null); assert.equal(after.draftEpoch, s.draftEpoch + 1);
  const empty = C.create();
  for (const [bad, cat] of [[null, 'c'], [card('  '), 'c'], [card(), ''], [{ text: 1 }, 'c']]) assert.equal(C.adopt(empty, bad, cat), empty);
  assert(Object.isFrozen(s));
});

test('drafts are capped at 2000 characters', () => {
  const s = C.chooseAdopt(C.adopt(C.edit(C.create(), '长'.repeat(1500)), card('短'.repeat(1500)), 'c'), 'append');
  assert.equal(Array.from(s.text).length, 2000);
  assert.equal(Array.from(C.edit(C.create(), '🐟'.repeat(2100)).text).length, 2000);
});

test('the module loads as a browser global without require or module', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../apps/neko-workbench/lobby-composer.js'), 'utf8');
  const sandbox = { globalThis: {} }; sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.WorkbenchLobbyComposer.adopt, 'function');
  assert.equal(/require\(|ipcRenderer|fetch\(|WebSocket/.test(source), false);
});
