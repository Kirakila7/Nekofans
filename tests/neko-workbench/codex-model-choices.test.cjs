'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCodexModelChoices } = require('../../apps/neko-workbench/codex-model-choices.cjs');
test('Codex model preferences survive runtime port changes and restart without touching native config', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-model-choices-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile/codex-model-choices.json'), store = createCodexModelChoices(file);
  store.set('new', { model: 'fixture-deep', effort: 'high' }); store.set('session-1', { model: null, effort: null });
  const loaded = createCodexModelChoices(file).get(); assert.deepEqual(loaded.new, { model: 'fixture-deep', effort: 'high' }); assert.deepEqual(loaded['session-1'], { model: null, effort: null });
  loaded.new.model = 'tamper'; assert.equal(store.get().new.model, 'fixture-deep'); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['codex-model-choices.json']);
  for (const choice of [{ model: null, effort: 'high' }, { model: 'bad\nmodel', effort: null }, { model: {}, effort: null }]) assert.throws(() => store.set('new', choice));
  assert.throws(() => store.set('../config.toml', { model: null, effort: null }));
  for (let i = 0; i < 205; i++) store.set('session-' + i, { model: 'fixture-fast', effort: null });
  assert.equal(Object.keys(createCodexModelChoices(file).get()).length, 200);
});
