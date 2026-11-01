'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readDshWorkspaceCatalog, checkDshWorkspaceSession, publicDshWorkspaceSessionIds } = require('../../apps/neko-workbench/dsh-workspace-catalog.cjs');
const { createWorkspaceController } = require('../../apps/neko-workbench/workspace-controller.cjs');
const { createChannelSessionPrivacy } = require('../../apps/neko-workbench/channel-session-privacy.cjs');

function fixture() {
  const data = path.resolve('synthetic-data'), fish = path.resolve('synthetic-fish');
  const privacy = createChannelSessionPrivacy(data, { fishWorkspace: fish });
  const headers = [{ id: 'qq', cwd: path.join(data, 'qqbot-runtime/workspace') }, { id: 'fish', cwd: fish },
    { id: 'work', cwd: path.resolve('synthetic-work') }, { id: 'late' }, { id: 'last' }];
  const disposed = [], observed = [];
  const ctx = { agents: new Map(), sessionQuery: {
    listSessions: async () => headers.map(header => ({ header })),
    observeSession: async id => {
      observed.push(id);
      return { header: { ...headers.find(h => h.id === id), ...(id === 'late' ? { cwd: fish } : {}) },
        projections: { values: { title: 'Synthetic ' + id } }, events: [], [Symbol.dispose]() { disposed.push(id); } };
    },
  } };
  return { ctx, disposed, observed, options: { isPrivateSession: (id, row) => privacy.isPrivate(id, row) } };
}

test('cached-session checks return only requested public root IDs without observations', async () => {
  const f = fixture();
  f.ctx.sessionQuery.observeSession = async () => { throw Error('must not observe cached sessions'); };
  assert.deepEqual(await publicDshWorkspaceSessionIds(f.ctx, ['qq', 'fish', 'work', 'missing'], f.options), ['work']);
  assert.deepEqual(await publicDshWorkspaceSessionIds(f.ctx, [], f.options), []);
  for (const ids of [null, [''], [1], ['x'.repeat(241)]]) await assert.rejects(publicDshWorkspaceSessionIds(f.ctx, ids, f.options));
});

for (const cacheHit of [false, true]) {
  test(`host revalidates cached privacy and keeps the next public page reachable (cache hit: ${cacheHit})`, async () => {
    const f = fixture();
    const headers = Array.from({ length: 82 }, (_, index) => ({ id: 's' + index, cwd: path.resolve(index ? 'synthetic-work' : 'synthetic-private-project') }));
    f.ctx.sessionQuery.listSessions = async () => headers.map(header => ({ header }));
    f.ctx.sessionQuery.observeSession = async id => ({ header: headers.find(h => h.id === id), projections: { values: { title: id === 's0' ? 'SYNTHETIC_PRIVATE_TITLE' : id } }, events: [] });
    let reads = 0;
    const controller = createWorkspaceController({ layout: { get: () => ({ seats: [] }) }, codex: {}, codexAvailable: false,
      readDsh: params => { reads++; return readDshWorkspaceCatalog(f.ctx, params, f.options); },
      validateDsh: ids => publicDshWorkspaceSessionIds(f.ctx, ids, f.options),
    });
    const first = await controller.catalog();
    assert.equal(first.nextDshOffset, 80);
    f.ctx.agents.set('s0', { session: { header: { cwd: path.resolve('synthetic-data/qqbot-runtime/workspace') } } });
    if (cacheHit) {
      const cached = await controller.catalog();
      assert.equal(reads, 1, 'privacy revalidation does not reload titles');
      assert(!JSON.stringify(cached).includes('SYNTHETIC_PRIVATE_TITLE'));
      assert.equal(cached.nextDshOffset, 79);
    }
    // A caller may still hold the old cursor; the host must correct it.
    const next = await controller.catalog({ force: true, dshOffset: first.nextDshOffset });
    assert(!JSON.stringify(next).includes('SYNTHETIC_PRIVATE_TITLE'));
    assert(!next.projects.some(project => project.cwd === headers[0].cwd));
    assert.deepEqual(new Set(next.sessions.map(row => row.id)), new Set(headers.slice(1).map(row => row.id)));
    assert.equal(next.nextDshOffset, null);
  });
}

test('failed cached privacy checks withhold DSH rows, preserve Codex and retry without cached disclosure', async () => {
  let fail = false, reads = 0;
  const dsh = { id: 'dsh', provider: 'dsh', title: 'SYNTHETIC_PRIVATE_TITLE', cwd: path.resolve('synthetic-private-project') };
  const codex = { id: 'codex', provider: 'codex', cwd: path.resolve('synthetic-codex') };
  const controller = createWorkspaceController({ layout: { get: () => ({ seats: [] }) }, codexAvailable: true,
    codex: { list: async () => ({ sessions: [codex], status: 'ready' }) },
    readDsh: async () => { reads++; return { sessions: [dsh], status: 'ready', nextOffset: null }; },
    validateDsh: async ids => { if (fail) throw Error('synthetic private diagnostic'); return ids; },
  });
  await controller.catalog();
  fail = true;
  const hidden = await controller.catalog();
  assert.deepEqual(hidden.sessions.map(row => row.provider), ['codex']);
  assert.equal(hidden.providers.dsh, 'unavailable');
  assert(!JSON.stringify(hidden).includes('SYNTHETIC_PRIVATE_TITLE'));
  assert(!JSON.stringify(hidden).includes('synthetic private diagnostic'));
  fail = false;
  const recovered = await controller.catalog();
  assert.equal(reads, 2);
  assert.equal(recovered.providers.dsh, 'ready');
  assert.equal(recovered.sessions.length, 2);
});

test('private channel roots are excluded before pagination and late discoveries are disposed', async () => {
  const f = fixture();
  const first = await readDshWorkspaceCatalog(f.ctx, { limit: 2 }, f.options);
  assert.deepEqual(first.sessions.map(s => s.id), ['work']);
  assert.equal(first.nextOffset, 1);
  assert.deepEqual(f.observed.sort(), ['late', 'work']);
  assert.deepEqual(f.disposed.sort(), ['late', 'work']);
  const next = await readDshWorkspaceCatalog(f.ctx, { offset: first.nextOffset, limit: 2 }, f.options);
  assert.deepEqual(next.sessions.map(s => s.id), ['last']);
});

test('opening checks both persisted and observed privacy, missing sessions and live ownership', async () => {
  const f = fixture();
  for (const id of ['qq', 'fish', 'late', 'missing']) await assert.rejects(checkDshWorkspaceSession(f.ctx, id, f.options));
  assert.deepEqual(await checkDshWorkspaceSession(f.ctx, 'work', f.options), { allowed: true });
  assert.equal(f.disposed.filter(id => id === 'late').length, 1);
  f.ctx.agents.set('last', { session: { header: { cwd: path.resolve('synthetic-fish') } } });
  await assert.rejects(checkDshWorkspaceSession(f.ctx, 'last', f.options));
  assert(!f.observed.includes('last'));
});

for (const channel of ['qq', 'fish']) for (const classification of ['live-agent', 'header', 'remembered']) {
  test(`catalog drops ${channel} ownership discovered after a worker completes (${classification})`, async () => {
    const data = path.resolve('synthetic-data'), fish = path.resolve('synthetic-fish');
    const privateCwd = channel === 'qq' ? path.join(data, 'qqbot-runtime/workspace') : fish;
    const privacy = createChannelSessionPrivacy(data, { fishWorkspace: fish });
    const options = { isPrivateSession: (id, row) => privacy.isPrivate(id, row) };
    const headers = ['first', 'slow', 'tail'].map(id => ({ id, cwd: path.resolve('synthetic-work') }));
    const disposed = [], agents = new Map();
    let finishFirst, releaseSlow;
    const firstDone = new Promise(resolve => { finishFirst = resolve; });
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const ctx = { agents, sessionQuery: {
      listSessions: async () => headers.map(header => ({ header })),
      observeSession: async id => {
        if (id === 'slow') await slow;
        return { header: { ...headers.find(header => header.id === id) },
          projections: { values: { title: id === 'first' ? 'SYNTHETIC_PRIVATE_TITLE' : id } }, events: [],
          [Symbol.dispose]() { disposed.push(id); if (id === 'first') finishFirst(); } };
      },
    } };
    const pending = readDshWorkspaceCatalog(ctx, { limit: 2 }, options);
    try {
      await firstDone;
      // Let the first worker finish assigning its result while another worker waits.
      await new Promise(resolve => setImmediate(resolve));
      if (classification === 'live-agent') agents.set('first', { session: { header: { cwd: privateCwd } } });
      else if (classification === 'header') headers[0].cwd = privateCwd;
      else privacy.isPrivate('first', { header: { cwd: privateCwd } });
    } finally { releaseSlow(); }
    const result = await pending;
    assert.deepEqual(result.sessions.map(row => row.id), ['slow']);
    assert(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_TITLE'));
    assert.equal(result.nextOffset, 1);
    assert.deepEqual(disposed.sort(), ['first', 'slow']);
    const next = await readDshWorkspaceCatalog(ctx, { offset: result.nextOffset, limit: 2 }, options);
    assert.deepEqual(next.sessions.map(row => row.id), ['tail']);
    await assert.rejects(checkDshWorkspaceSession(ctx, 'first', options));
  });
}
