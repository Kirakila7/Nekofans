/** Read-only package contract checks: no services, credentials or network IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const json = path => JSON.parse(read(path));
const baseline = json('tests/fixtures/v2-config-baseline.json');
const app = json('config/app.example.json');
const menu = json('config/main-agent-menu.json');
const workbench = json('config/workbench.example.json');

test('v2 app persona, memory, fish and chat configuration values are preserved', () => {
  const { workbench: addition, ...originalApp } = app;
  assert.deepEqual(originalApp, baseline.app);
  assert.equal(addition.config, './workbench.example.json');
  assert.equal(addition.preserveExistingPersonaAndMemory, true);
  assert.equal(addition.mainChatIntegration, 'planned');
  assert.equal(addition.dualMemoryIntegration, 'planned');
});

test('v2 memory contracts, executable reference, original tests, persona and skin are byte-identical', () => {
  for (const [path, expected] of Object.entries(baseline.unchangedFiles)) {
    const bytes = readFileSync(new URL(path, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, path);
  }
});

test('original fish/memory menu and constraints remain intact while top-level entries are additive', () => {
  const { topLevel, ...originalMenu } = menu;
  assert.deepEqual(originalMenu, baseline.mainAgentMenu);
  assert.deepEqual(topLevel.map(item => item.label), ['打开工作台', '工作台选项', '养鱼', '产出文件', '设置', '重新连接工作台']);
  const fish = topLevel.find(item => item.id === 'fish.keeping');
  assert.equal(fish.itemsRef, '#/items');
  assert.equal(fish.status, 'planned');
  assert.equal(fish.enabled, false);
  assert.equal(topLevel.find(item => item.id === 'app.settings').preserveAllNativeItems, true);
});

test('only bigfish role is enabled and it opens an existing runtime-bound DSH Session', () => {
  assert.deepEqual(workbench.roles.map(role => [role.id, role.name]), [['yui', 'Yui'], ['bigfish', '大肥鱼'], ['claude', 'Claude小姐']]);
  assert.deepEqual(workbench.roles.filter(role => role.enabled).map(role => role.id), ['bigfish']);
  for (const role of workbench.roles) {
    assert.equal(Object.hasOwn(role, 'personaId'), false);
    if (!role.enabled) assert.equal(role.sessionBinding, null);
    else {
      assert.equal(role.sessionBinding.sessionId, null);
      assert.equal(role.sessionBinding.source, 'runtime.state.dshRoot.sessionId');
      assert.equal(role.sessionBinding.createOnSelection, false);
    }
  }
  assert.equal(workbench.runtime.workspaceSessionId, null);
  assert.equal(workbench.roleBoundary.selectionDoesNotSendPrompt, true);
  assert.equal(workbench.roleBoundary.selectionDoesNotCreateSession, true);
});

test('global avatar/theme, role identity, account launcher and memory identity stay separate', () => {
  assert.equal(workbench.appearance.globalAvatar.selectedId, 'yui');
  assert.deepEqual(workbench.appearance.theme.presetIds, ['yui', 'devcat', 'bigfish', 'claude', 'gemini']);
  assert.equal(workbench.appearance.globalAvatar.customColorExtraction, 'local-only');
  assert.equal(workbench.appearance.globalAvatar.changesPersona, false);
  assert.equal(workbench.appearance.globalAvatar.changesMemoryNamespace, false);
  assert.equal(workbench.appearance.accountLauncher.name, '开发喵');
  assert.equal(workbench.appearance.accountLauncher.avatarId, 'devcat');
  assert.equal(workbench.appearance.accountLauncher.namePlacement, 'above-avatar');
  assert.equal(app.mainChat.personaId, baseline.app.mainChat.personaId);
  assert.equal(app.memory.namespace, baseline.app.memory.namespace);
});

test('account pets follow real connections; CNY/USD wallet is read-only and unknown never becomes zero', () => {
  assert.deepEqual(workbench.accounts.connections, []);
  assert.deepEqual(workbench.accounts.providers.filter(provider => provider.enabled).map(provider => provider.id), ['deepseek']);
  assert.equal(workbench.accounts.pets.source, 'actual-connected-accounts-only');
  assert.equal(workbench.accounts.pets.showOnlyWhenAuthenticated, true);
  assert.equal(workbench.accounts.pets.videoAsset, 'assets/idle.webm');
  assert.equal(workbench.accounts.wallet.readOnly, true);
  assert.deepEqual(workbench.accounts.wallet.supportedCurrencies, ['CNY', 'USD']);
  assert.equal(workbench.accounts.wallet.unknownAmount, null);
  for (const key of ['unknownIsZero', 'combineCurrencies', 'convertCurrencies', 'includeBonusInNormalBalance', 'isPercentageQuota']) assert.equal(workbench.accounts.wallet[key], false, key);
  assert.equal(workbench.accounts.security.credentialRefLocation, 'native-secure-storage-only');
  assert.ok(workbench.accounts.security.frontendSecretFieldsForbidden.includes('credentialRef'));
});

test('all six workbench options keep existing native action IDs', () => {
  assert.deepEqual(workbench.options.map(option => [option.id, option.nativeAction]), [
    ['nekoSettings', 'neko-settings'], ['openNeko', 'open-neko'], ['taskNotes', 'task-notes'],
    ['connect', 'connect-neko'], ['status', 'connection-status'], ['reconnect', 'reconnect-workbench'],
  ]);
  assert.equal(workbench.options.find(option => option.id === 'connect').explicitUserActionOnly, true);
  assert.equal(workbench.globalTools.perRolePluginRuntime, false);
  assert.equal(workbench.globalTools.preserveOriginalNodesAndEvents, true);
});

test('distributable config contains no credential values or pinned runtime identities', () => {
  const forbiddenKeys = /^(?:credentialRef|apiKey|accessToken|refreshToken|password|secret|privateKey)$/i;
  const secretValue = /(?:\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{12,})/;
  function inspect(value, path = '') {
    if (!value || typeof value !== 'object') { if (typeof value === 'string') assert.equal(secretValue.test(value), false, path); return; }
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.test(key), false, path + '/' + key);
      if (['sessionId', 'workspaceSessionId'].includes(key)) assert.equal(child, null, path + '/' + key);
      inspect(child, path + '/' + key);
    }
  }
  for (const [label, value] of Object.entries({ app, menu, workbench })) inspect(value, label);
});

test('Chat API, both native memory adapters and fish integration stay explicitly planned', () => {
  assert.equal(workbench.plannedIntegrations.chatApi.status, 'planned');
  assert.equal(workbench.plannedIntegrations.chatApi.connected, false);
  assert.equal(workbench.plannedIntegrations.dualMemory.status, 'planned');
  assert.equal(workbench.plannedIntegrations.dualMemory.nativeAdaptersConnected, false);
  assert.equal(workbench.plannedIntegrations.fishKeeping.connected, false);
  for (const key of ['autoStartServices', 'autoAuthenticate', 'autoTopUp', 'autoSelectModel']) assert.equal(workbench.runtime[key], false, key);
  const contract = read('src/workbench-contracts.ts');
  for (const name of ['GlobalAvatarId', 'WorkbenchRole', 'AccountConnection', 'PersonaId', 'SessionId', 'NativeCredentialRef']) assert.ok(contract.includes(name), name);
  assert.ok(contract.includes('credentialRef?: never'));
});
