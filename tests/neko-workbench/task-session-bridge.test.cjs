'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskSessionTracker } = require('../../apps/neko-workbench/task-session-tracker.cjs');
const session = (id, extra = {}) => ({ id, header: { id, createdAt: 100, ...extra }, inheritedEventCount: 0 });
const event = (type, data, seq = 1) => ({ type, data, seq, time: 100 + seq });
const message = (value, seq = 1, kind = 'user') => event('user/message', { source: { kind }, content: [{ type: 'text', text: value }] }, seq);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ observeSession = async () => { throw Error('not available'); }, getLiveJobs } = {}) {
  const frames = [], agents = new Map();
  const tracker = createTaskSessionTracker({ emit: (method, params) => frames.push({ method, params }), getAgent: id => agents.get(id), observeSession, getLiveJobs });
  return { tracker, frames, agents, roster: () => frames.findLast(frame => frame.method === 'task-roster')?.params.sessionIds,
    meta: id => frames.findLast(frame => frame.method === 'task-meta' && frame.params.sessionId === id)?.params };
}

if (!process.argv.includes('--bridge-harness')) {
  test('QQ privacy matches only its isolated workspace and remains known after agent disposal', () => {
    const path = require('node:path');
    const { createChannelSessionPrivacy } = require('../../apps/neko-workbench/channel-session-privacy.cjs');
    const data = path.resolve('fixture-data'), cwd = path.join(data, 'qqbot-runtime', 'workspace');
    const privacy = createChannelSessionPrivacy(data);
    assert.equal(privacy.isPrivate('ordinary', session('ordinary', { cwd: cwd + '-ordinary' })), false);
    assert.equal(privacy.isPrivate('missing', session('missing')), false);
    assert.equal(privacy.isPrivate('qq', session('qq', { cwd: path.join(cwd, 'nested', '..') })), true);
    assert.equal(privacy.isPrivate('qq'), true);
    assert.equal(privacy.isPrivate('child', session('child', { parentSession: 'qq' })), true);
  });

  test('background fish sessions and their children stay out of desktop task pets', () => {
    const path = require('node:path');
    const { createChannelSessionPrivacy } = require('../../apps/neko-workbench/channel-session-privacy.cjs');
    const fishWorkspace = path.resolve('fixture-work','fish-care');
    const privacy = createChannelSessionPrivacy(path.resolve('fixture-data'),{fishWorkspace});
    assert.equal(privacy.isPrivate('ordinary',session('ordinary',{cwd:fishWorkspace+'-other'})),false);
    assert.equal(privacy.isPrivate('fish',session('fish',{cwd:fishWorkspace})),true);
    assert.equal(privacy.isPrivate('fish-child',session('fish-child',{parentSession:'fish'})),true);
    assert.equal(privacy.isPrivate('fish'),true);
  });

  test('only real own human work creates medium task metadata; title/todo and ordinary forks retain separate identity', () => {
    const f = fixture(), current = session('workbench-session');
    f.tracker.onEvent(current, event('turn/start', { turn: 1 }));
    f.tracker.onStatus({ id: current.id, session: current }, 'running');
    f.tracker.onEvent(current, message('自动续跑', 2, 'goal'));
    f.tracker.onEvent(current, message('委派文本', 3, 'agent-message'));
    f.tracker.onEvent(current, message('   ', 4)); assert.deepEqual(f.roster(), []);
    f.tracker.onEvent(current, message('修复页面布局', 5));
    assert.deepEqual(f.roster(), ['workbench-session']);
    assert.deepEqual(f.meta(current.id), { source: 'dsh-task-session', sessionId: current.id, name: '修复页面布局', title: '', task: '修复页面布局', running: true, backgroundJobs: 0, outcome: null, createdAt: 100 });
    f.tracker.onEvent(current, event('session/title', { title: '布局修复' }, 6));
    f.tracker.onEvent(current, event('todo/write', { todos: [{ content: '核对窄屏', status: 'in_progress' }] }, 7));
    assert.equal(f.meta(current.id).name, '布局修复'); assert.equal(f.meta(current.id).task, '核对窄屏');
    const fork = session('normal-fork', { parentSession: 'ancestor' });
    f.tracker.onEvent(fork, message('我在普通分支里的新任务')); assert.equal(f.tracker.has(fork.id), true);
    assert.deepEqual(f.roster(), [current.id, fork.id]); f.tracker.dispose();
  });

  test('native origin, own descriptor and late catalog permanently exclude subagents from medium roster', () => {
    const f = fixture();
    f.tracker.onEvent(session('native-child', { origin: 'subagent', parentSession: 'parent' }), message('initial delegated instruction'));
    assert.equal(f.tracker.has('native-child'), false);
    f.tracker.onEvent(session('descriptor-child'), event('subagent/descriptor', { version: 3 }));
    f.tracker.onEvent(session('descriptor-child'), message('initial delegated instruction')); assert.equal(f.tracker.has('descriptor-child'), false);
    f.tracker.onEvent(session('late-child'), message('before catalog arrives')); assert.equal(f.tracker.has('late-child'), true);
    f.tracker.exclude('late-child'); assert.deepEqual(f.roster(), []);
    f.tracker.onEvent(session('late-child'), message('later user followup', 4));
    f.tracker.onStatus({ id: 'late-child', session: session('late-child') }, 'running'); assert.equal(f.tracker.has('late-child'), false);
    f.tracker.dispose();
  });

  test('real registered and settled jobs keep tasks running after parent turn ends, deduplicate and respect owner', () => {
    const f = fixture(), current = session('job-owner'); f.tracker.onEvent(current, message('运行后台检查'));
    f.tracker.onEvent(current, event('job/registered', { jobId: 'bash-1', kind: 'bash', owner: current.id }, 2));
    f.tracker.onEvent(current, event('job/registered', { jobId: 'bash-1', kind: 'bash', owner: current.id }, 2));
    f.tracker.onStatus({ id: current.id, session: current }, 'idle'); f.tracker.onEvent(current, event('turn/end', { reason: 'complete' }, 3));
    assert.equal(f.meta(current.id).running, true); assert.equal(f.meta(current.id).backgroundJobs, 1);
    f.tracker.onEvent(current, event('job/registered', { jobId: 'foreign', kind: 'workflow', owner: 'other-session' }, 4));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'bash-1', kind: 'bash', owner: current.id, status: 'running' }, 5));
    assert.equal(f.meta(current.id).backgroundJobs, 1);
    f.tracker.onEvent(current, event('job/settled', { jobId: 'bash-1', kind: 'bash', owner: current.id, status: 'completed' }, 6));
    assert.equal(f.meta(current.id).running, false); assert.equal(f.meta(current.id).backgroundJobs, 0);
    f.tracker.onEvent(current, event('job/registered', { jobId: 'bash-1', kind: 'bash' }, 2));
    assert.equal(f.meta(current.id).backgroundJobs, 0, 'late duplicate registrations cannot revive a settled job');
    f.tracker.dispose();
  });

  test('real terminal outcomes aggregate across active siblings and reset only after that batch ends', () => {
    const f = fixture(), current = session('outcome-owner'); f.tracker.onEvent(current, message('background batch'));
    for (const id of ['a', 'b', 'c']) f.tracker.onEvent(current, event('job/registered', { jobId: id, kind: 'bash' }, 2));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'a', kind: 'bash', status: 'failed' }, 3));
    assert.equal(f.meta(current.id).running, true); assert.equal(f.meta(current.id).outcome, 'failed');
    f.tracker.onEvent(current, event('turn/start', { turn: 2 }, 4));
    f.tracker.onEvent(current, message('followup while siblings still run', 5));
    assert.equal(f.meta(current.id).outcome, 'failed', 'new foreground turns cannot erase active-batch evidence');
    f.tracker.onEvent(current, event('job/settled', { jobId: 'b', kind: 'bash', status: 'killed' }, 6));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'c', kind: 'bash', status: 'completed' }, 7));
    assert.equal(f.meta(current.id).running, false); assert.equal(f.meta(current.id).outcome, 'failed');
    f.tracker.onEvent(current, event('job/settled', { jobId: 'a', kind: 'bash', status: 'completed' }, 8));
    assert.equal(f.meta(current.id).outcome, 'failed', 'duplicate terminal facts are first-wins by job id');
    f.tracker.onEvent(current, message('a new batch', 9)); assert.equal(f.meta(current.id).outcome, null);
    for (const id of ['d', 'e']) f.tracker.onEvent(current, event('job/registered', { jobId: id, kind: 'bash' }, 10));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'd', kind: 'bash', status: 'killed' }, 11));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'e', kind: 'bash', status: 'completed' }, 12));
    assert.equal(f.meta(current.id).outcome, 'killed');
    f.tracker.onEvent(current, event('turn/start', { turn: 3 }, 13)); assert.equal(f.meta(current.id).outcome, null);
    f.tracker.onEvent(current, event('job/registered', { jobId: 'f', kind: 'bash' }, 14));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'f', kind: 'bash', status: 'completed' }, 15));
    assert.equal(f.meta(current.id).outcome, 'completed'); f.tracker.dispose();
  });

  test('unknown settlements and jobs disappearing without a terminal fact never aggregate to completed', () => {
    let live = [];
    const f = fixture({ getLiveJobs: () => live }), current = session('unknown-owner'); f.tracker.onEvent(current, message('inspect outcomes'));
    for (const id of ['ok', 'unknown']) f.tracker.onEvent(current, event('job/registered', { jobId: id, kind: 'bash' }, 2));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'ok', kind: 'bash', status: 'completed' }, 3));
    f.tracker.onEvent(current, event('job/settled', { jobId: 'unknown', kind: 'bash', status: 'future-terminal' }, 4));
    assert.equal(f.meta(current.id).running, false); assert.equal(f.meta(current.id).outcome, 'unknown');
    f.tracker.onEvent(current, message('new work', 5));
    f.tracker.onEvent(current, event('job/registered', { jobId: 'disappeared', kind: 'bash' }, 6));
    f.tracker.refresh(); assert.equal(f.meta(current.id).running, false); assert.equal(f.meta(current.id).outcome, 'unknown');
    f.tracker.onEvent(current, event('job/settled', { jobId: 'disappeared', kind: 'bash', status: 'completed' }, 7));
    assert.equal(f.meta(current.id).outcome, 'completed', 'a later real terminal fact can resolve missing evidence'); f.tracker.dispose();
  });

  test('idle restore has no fresh outcome, while live batches retain durable failure evidence', async () => {
    const histories = {
      idle: [message('old work'), event('job/registered', { jobId: 'old', kind: 'bash' }, 2), event('job/settled', { jobId: 'old', kind: 'bash', status: 'completed' }, 3)],
      live: [message('still running work'), event('job/registered', { jobId: 'bad', kind: 'bash' }, 2), event('job/registered', { jobId: 'pending', kind: 'bash' }, 3), event('job/settled', { jobId: 'bad', kind: 'bash', status: 'failed' }, 4), event('turn/start', { turn: 2 }, 5)],
    };
    const f = fixture({ observeSession: async id => ({ header: session(id).header, events: histories[id], inheritedEventCount: 0 }),
      getLiveJobs: id => id === 'live' ? [{ id: 'pending', owner: id, kind: 'bash', status: 'running' }] : [] });
    await f.tracker.restore('idle'); assert.equal(f.meta('idle').running, false); assert.equal(f.meta('idle').outcome, null);
    await f.tracker.restore('live'); assert.equal(f.meta('live').running, true); assert.equal(f.meta('live').outcome, 'failed');
    f.tracker.onEvent(session('live'), event('job/settled', { jobId: 'pending', kind: 'bash', status: 'completed' }, 6));
    assert.equal(f.meta('live').running, false); assert.equal(f.meta('live').outcome, 'failed'); f.tracker.dispose();
  });

  test('explicit restore checks own human history, releases observations and never revives stale background jobs', async () => {
    let releases = 0;
    const observations = {
      normal: { header: session('normal').header, inheritedEventCount: 0, events: [message('已保存任务'), event('job/registered', { jobId: 'old', kind: 'bash' }, 2)] },
      fork: { header: session('fork', { parentSession: 'old' }).header, inheritedEventCount: 2, events: [event('subagent/descriptor', {}), message('ancestor task', 2), message('own fork task', 3)] },
      inherited: { header: session('inherited', { parentSession: 'old' }).header, inheritedEventCount: 1, events: [message('ancestor task')] },
      descriptor: { header: session('descriptor').header, inheritedEventCount: 0, events: [message('delegated'), event('subagent/descriptor', {}, 2)] },
      empty: { header: session('empty').header, inheritedEventCount: 0, events: [] },
    };
    const f = fixture({ observeSession: async id => { if (!observations[id]) throw Error('private detail must not echo'); return { ...observations[id], [Symbol.dispose]: () => releases++ }; } });
    assert.equal(await f.tracker.restore('normal'), true); assert.equal(f.meta('normal').running, false); assert.equal(f.meta('normal').backgroundJobs, 0); assert.equal(f.meta('normal').outcome, null);
    assert.equal(await f.tracker.restore('fork'), true); assert.equal(f.meta('fork').task, 'own fork task');
    for (const id of ['inherited', 'descriptor', 'empty', 'missing']) assert.equal(await f.tracker.restore(id), false);
    assert.deepEqual(f.roster(), ['normal', 'fork']); assert.equal(releases, 5);
    assert.equal(JSON.stringify(f.frames).includes('private detail'), false); f.tracker.dispose();
  });

  test('restoration uses the actual current job registry and fences concurrent human events, status and late catalog', async () => {
    let finish, releases = 0;
    const f = fixture({ observeSession: () => new Promise(resolve => { finish = resolve; }), getLiveJobs: id => [{ id: 'live-job', owner: id, kind: 'bash', status: 'running' }, { id: 'other', owner: 'other', kind: 'bash', status: 'running' }] });
    const pending = f.tracker.restore('restoring');
    f.tracker.onEvent(session('restoring'), message('new live prompt', 5));
    f.tracker.onStatus({ id: 'restoring', session: session('restoring') }, 'idle');
    finish({ header: session('restoring').header, events: [message('older prompt', 1)], cursor: 1, [Symbol.dispose]: () => releases++ });
    assert.equal(await pending, true); assert.equal(f.meta('restoring').task, 'new live prompt'); assert.equal(f.meta('restoring').backgroundJobs, 1);
    assert.equal(f.frames.findLast(frame => frame.method === 'session-context' && frame.params.sessionId === 'restoring').params.lastUserMessage.text, 'new live prompt');
    const late = f.tracker.restore('late'); f.tracker.exclude('late');
    finish({ header: session('late').header, events: [message('task')], [Symbol.dispose]: () => releases++ });
    assert.equal(await late, false); assert.equal(f.tracker.has('late'), false); assert.equal(releases, 2); f.tracker.dispose();
  });

  test('restore replays old settlement then new human before reconciling the final new job', async () => {
    let finish; const current = session('batch-race');
    const f = fixture({ observeSession: () => new Promise(resolve => { finish = resolve; }),
      getLiveJobs: id => [{ id: 'new-job', owner: id, kind: 'bash', status: 'running' }] });
    const pending = f.tracker.restore(current.id);
    f.tracker.onEvent(current, event('job/settled', { jobId: 'old-job', kind: 'bash', status: 'killed' }, 3));
    f.tracker.onEvent(current, message('new task', 4));
    f.tracker.onEvent(current, event('job/registered', { jobId: 'new-job', kind: 'bash' }, 5));
    finish({ header: current.header, events: [message('old task', 1), event('job/registered', { jobId: 'old-job', kind: 'bash' }, 2)], cursor: 2 });
    await pending; assert.equal(f.meta(current.id).task, 'new task'); assert.equal(f.meta(current.id).outcome, null);
    f.tracker.onEvent(current, event('job/settled', { jobId: 'new-job', kind: 'bash', status: 'completed' }, 6));
    assert.equal(f.meta(current.id).running, false); assert.equal(f.meta(current.id).outcome, 'completed'); f.tracker.dispose();
  });

  test('restore preserves a failed result when the same turn registers a new job after the old last job ends', async () => {
    let finish; const current = session('same-turn-race');
    const f = fixture({ observeSession: () => new Promise(resolve => { finish = resolve; }),
      getLiveJobs: id => [{ id: 'new-job', owner: id, kind: 'bash', status: 'running' }] });
    const pending = f.tracker.restore(current.id);
    f.tracker.onEvent(current, event('job/settled', { jobId: 'old-last', kind: 'bash', status: 'completed' }, 5));
    f.tracker.onEvent(current, event('job/registered', { jobId: 'new-job', kind: 'bash' }, 6));
    finish({ header: current.header, events: [message('same task', 1), event('job/registered', { jobId: 'old-bad', kind: 'bash' }, 2),
      event('job/registered', { jobId: 'old-last', kind: 'bash' }, 3), event('job/settled', { jobId: 'old-bad', kind: 'bash', status: 'failed' }, 4)], cursor: 4 });
    await pending; assert.equal(f.meta(current.id).running, true); assert.equal(f.meta(current.id).outcome, 'failed');
    f.tracker.onEvent(current, event('job/settled', { jobId: 'new-job', kind: 'bash', status: 'completed' }, 7));
    assert.equal(f.meta(current.id).running, false); assert.equal(f.meta(current.id).outcome, 'failed'); f.tracker.dispose();
  });

  test('restore retains a failed sibling when its last live job settles before the observation returns', async () => {
    let finish; const current = session('last-job-race');
    const f = fixture({ observeSession: () => new Promise(resolve => { finish = resolve; }), getLiveJobs: () => [] });
    const pending = f.tracker.restore(current.id);
    f.tracker.onEvent(current, event('job/settled', { jobId: 'last', kind: 'bash', status: 'completed' }, 5));
    finish({ header: current.header, events: [message('one batch', 1), event('job/registered', { jobId: 'bad', kind: 'bash' }, 2),
      event('job/registered', { jobId: 'last', kind: 'bash' }, 3), event('job/settled', { jobId: 'bad', kind: 'bash', status: 'failed' }, 4)], cursor: 4 });
    await pending; assert.equal(f.meta(current.id).running, false); assert.equal(f.meta(current.id).backgroundJobs, 0);
    assert.equal(f.meta(current.id).outcome, 'failed'); f.tracker.dispose();
  });

  test('a real native running status can discover resumed human history, while an empty running session stays absent', async () => {
    const seen = [];
    const f = fixture({ observeSession: async id => { seen.push(id); return { header: session(id).header,
      inheritedEventCount: 0, events: id === 'resumed' ? [message('native resumed work')] : [] }; } });
    f.tracker.onStatus({ id: 'resumed', session: session('resumed') }, 'running');
    f.tracker.onStatus({ id: 'blank', session: session('blank') }, 'running');
    assert.deepEqual(f.roster(), []); await tick();
    assert.deepEqual(f.roster(), ['resumed']); assert.equal(f.meta('resumed').running, true);
    assert.equal(f.tracker.has('blank'), false); assert.deepEqual(seen, ['resumed', 'blank']); f.tracker.dispose();
  });

  test('dispose suppresses delayed observation and later session/status publications', async () => {
    let finish, released = false;
    const f = fixture({ observeSession: () => new Promise(resolve => { finish = resolve; }) }); const pending = f.tracker.restore('late');
    f.tracker.dispose(); finish({ header: session('late').header, events: [message('task')], [Symbol.dispose]: () => { released = true; } });
    assert.equal(await pending, false); assert.equal(released, true);
    const count = f.frames.length; f.tracker.onEvent(session('late'), message('later')); f.tracker.onStatus({ id: 'late', session: session('late') }, 'running'); f.tracker.refresh();
    assert.equal(f.frames.length, count);
  });

  test('actual bridge restores approved tasks and streams real task/job events while preserving subagent catalog and stop RPC', async () => {
    const { execFile } = require('node:child_process');
    await new Promise((resolve, reject) => execFile(process.execPath, [__filename, '--bridge-harness'], { timeout: 15000, maxBuffer: 2e6 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${stdout}\n${stderr}`));
      try { assert.match(stdout, /task session bridge fixture passed/); resolve(); } catch (error) { reject(error); }
    }));
  });
} else {
  (async () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module'), { EventEmitter } = require('node:events');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-task-bridge-'));
    const originalLoad = Module._load, originalWrite = process.stdout.write;
    const lines = new EventEmitter(), frames = [], handlers = new Map(), agents = new Map(), canceled = [], interrupted = [], prompts = [], observations = [], mounted = [], killed = [], released = [], parentQueries = [];
    const dataDir = path.join(directory, 'data'), qqCwd = path.join(dataDir, 'qqbot-runtime', 'workspace');
    const privateText = 'fixture-private-qq-conversation';
    let jobRows = [], registry;
    const nativeKill = (id, caller, reason) => { killed.push([id, caller, reason]); return 'requested'; };
    registry = { list: () => jobRows, kill: nativeKill };
    const sessions = new Map([['root', session('root')], ['catalog-child', session('catalog-child', { origin: 'subagent', parentSession: 'root' })], ['restored', session('restored')], ['fork', session('fork', { parentSession: 'ancestor' })], ['empty', session('empty')]]);
    const histories = new Map([['root', []], ['catalog-child', [message('delegated')]], ['restored', [message('restored own task')]], ['fork', [message('fork own task')]], ['empty', []]]);
    for (const id of ['qq-restored', 'qq-parent', 'qq-catalog']) {
      sessions.set(id, session(id, { cwd: qqCwd })); histories.set(id, [message(privateText)]);
    }
    sessions.set('fish-background',session('fish-background',{cwd:path.join(directory,'work','fish-care')}));
    histories.set('fish-background',[message('background fish reading')]);
    const root = { id: 'root', status: 'idle', session: sessions.get('root'), cancel: reason => canceled.push(['root', reason]), followup: value => prompts.push(value) }; agents.set('root', root);
    const rows = [{ id: 'catalog-child', mode: 'continuable', label: 'real child', createdAt: 120 },
      { id: 'qq-catalog', mode: 'continuable', label: privateText, createdAt: 121 }];
    let resumes = 0;
    const ctx = { on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
      get: name => name === 'loader' ? { await: async () => {} } : name === 'jobs' ? registry : undefined,
      agents: { get: id => agents.get(id), resume: async () => { resumes++; return { agent: root }; }, create: async () => { throw Error('must not create an agent for task restoration'); } },
      sessionQuery: { observeSession: async id => { observations.push(id); if (!sessions.has(id)) throw Error('missing fixture'); return { header: sessions.get(id).header, events: histories.get(id), inheritedEventCount: 0, projections: { values: { title: id === 'catalog-child' ? 'Catalog title' : '' } }, [Symbol.dispose]() { released.push(id); } }; } },
      subagents: { listChildren: async id => { parentQueries.push(id); return id === 'root' ? rows : []; }, interrupt: (id, reason) => interrupted.push([id, reason]), prompt: (...args) => prompts.push(args) },
      agentPresets: { mount: (...args) => mounted.push(args) }, connection: { authenticatedUrl: url => url }, webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:59099/fixture' }, root: { dispose: async () => {} } };
    lines.close = () => lines.emit('close');
    const emitCtx = (name, ...args) => { for (const fn of handlers.get(name) || []) fn(...args); };
    const invoke = async (method, params) => { const id = Math.random(); lines.emit('line', JSON.stringify({ id, method, params })); for (let n = 0; n < 200; n++) { const response = frames.find(frame => frame.id === id); if (response) return response; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('bridge fixture RPC timeout'); };
    const last = (method, id) => frames.findLast(frame => frame.method === method && (!id || frame.params.sessionId === id))?.params;
    try {
      for (const [name, source] of [['dsh-llm', 'export const createUserMessage=value=>value;'], ['dsh-scope', 'export const carrierKeyOf=()=>undefined;']]) {
        const moduleDir = path.join(directory, name); fs.mkdirSync(path.join(moduleDir, 'lib'), { recursive: true }); fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"type":"module"}'); fs.writeFileSync(path.join(moduleDir, 'lib/index.js'), source);
      }
      Module._load = function (name, parent, ...args) {
        if (parent?.filename.replaceAll('\\', '/').endsWith('/apps/neko-workbench/bridge.cjs')) {
          if (name === './runtime-config.cjs') return { resolveRuntimePaths: () => ({ modulesDir: directory, dataDir, workspaceDir: path.join(directory, 'work') }) };
          if (name === 'node:readline') return { createInterface: () => lines };
        }
        return originalLoad.call(this, name, parent, ...args);
      };
      process.stdout.write = value => { for (const line of String(value).trim().split('\n')) if (line) frames.push(JSON.parse(line)); return true; };
      require('../../apps/neko-workbench/bridge.cjs').apply(ctx);
      const initialized = await invoke('init', { rootId: 'root', resume: true, parentIds: ['qq-parent'], taskIds: ['restored', 'fork', 'catalog-child', 'empty', 'missing', 'qq-restored', 'fish-background'] });
      assert.equal(initialized.result.sessionId, 'root'); assert.equal(resumes, 1); assert.equal(prompts.length, 0);
      assert.deepEqual(last('agent-roster').sessionIds, ['catalog-child']);
      assert.equal(last('agent-meta', 'catalog-child').source, 'dsh-subagent-catalog');
      assert.deepEqual(last('task-roster').sessionIds, ['restored', 'fork']); assert(observations.includes('empty')); assert(observations.includes('missing'));
      assert.equal(JSON.stringify(frames).includes(privateText), false, 'restored QQ content and catalog labels never cross the bridge');
      for (const id of ['qq-restored', 'qq-parent', 'qq-catalog']) {
        assert(released.includes(id), `private observation must be released: ${id}`);
        assert.equal(frames.some(frame => frame.params?.sessionId === id), false);
      }
      assert.equal(parentQueries.includes('qq-parent'), false, 'a persisted private parent cannot enumerate or publish children');
      emitCtx('session/event',sessions.get('fish-background'),message('background fish reading'));
      assert.equal(frames.some(frame=>frame.params?.sessionId==='fish-background'),false,'background fish must not create or update a second desktop pet');
      const qqLive = session('qq-live', { cwd: path.join(qqCwd, 'nested', '..') });
      const qqAgent = { id: qqLive.id, session: qqLive };
      emitCtx('session/event', qqLive, message(privateText));
      emitCtx('agent/status', { agent: qqAgent, status: 'running' });
      emitCtx('agent/error', { agent: qqAgent, error: Error(privateText) });
      emitCtx('subagent/start', { id: qqLive.id, local: true });
      emitCtx('subagent/end', { id: qqLive.id, local: true, stopReason: privateText });
      emitCtx('session/event', sessions.get('root'), event('subagent/catalog', { childId: 'qq-catalog', mode: 'continuable', label: privateText }, 8));
      await tick();
      assert.equal(JSON.stringify(frames).includes(privateText), false);
      assert.equal(frames.some(frame => frame.params?.sessionId === qqLive.id), false, 'QQ user messages, status, error and late lifecycle events are private');
      assert.equal((await invoke('stop', { sessionId: 'qq-restored' })).result, undefined, 'private old task ids never enter task controls');
      const latePrivate = session('late-private', { cwd: path.join(directory, 'work') });
      emitCtx('session/event', latePrivate, message('public task before ownership classification'));
      assert(last('task-roster').sessionIds.includes(latePrivate.id));
      latePrivate.header.cwd = qqCwd;
      emitCtx('agent/error', { agent: { id: latePrivate.id, session: latePrivate }, error: Error(privateText) });
      assert.equal(last('task-roster').sessionIds.includes(latePrivate.id), false, 'private ownership removes stale task metadata');
      const lateChild = session('late-private-child', { cwd: path.join(directory, 'work'), origin: 'subagent', parentSession: 'root' });
      sessions.set(lateChild.id, lateChild); histories.set(lateChild.id, []);
      emitCtx('session/event', sessions.get('root'), event('subagent/catalog', { childId: lateChild.id, mode: 'continuable', label: 'public child' }, 9));
      await tick(); assert(last('agent-roster').sessionIds.includes(lateChild.id));
      lateChild.header.cwd = qqCwd;
      emitCtx('agent/status', { agent: { id: lateChild.id, session: lateChild }, status: 'running' });
      assert.equal(last('agent-roster').sessionIds.includes(lateChild.id), false, 'private ownership removes stale catalog entries');
      assert.equal(JSON.stringify(frames).includes(privateText), false);
      const active = session('ui-task', { parentSession: 'ordinary-fork-parent' });
      emitCtx('session/event', active, event('turn/start', { turn: 1 })); assert.equal(last('task-meta', active.id), undefined);
      emitCtx('session/event', active, message('UI human task', 2)); assert.equal(last('event', active.id).delegatedPrompt, false, 'ordinary forks are not delegated subagents');
      agents.set(active.id, { id: active.id, session: active, status: 'running', cancel: reason => canceled.push([active.id, reason]) });
      emitCtx('agent/status', { agent: agents.get(active.id), status: 'running' });
      emitCtx('session/event', active, event('job/registered', { jobId: 'real-job', owner: active.id, kind: 'bash' }, 3));
      agents.get(active.id).status = 'idle'; emitCtx('agent/status', { agent: agents.get(active.id), status: 'idle' });
      emitCtx('session/event', active, event('turn/end', { turn: 1, reason: 'complete' }, 4));
      assert.equal(last('task-meta', active.id).running, true); assert.equal(last('task-meta', active.id).backgroundJobs, 1);
      jobRows = [{ id: 'real-job', owner: active.id, kind: 'bash', status: 'running' },
        { id: 'unowned-public', kind: 'bash', status: 'running' },
        { id: 'other-private', owner: 'other-session', kind: 'bash', status: 'running' },
        { id: 'already-done', owner: active.id, kind: 'bash', status: 'completed' }];
      const stopped = await invoke('stop', { sessionId: active.id }); assert.equal(stopped.result.accepted, true); assert.equal(canceled.at(-1)[0], active.id);
      assert.deepEqual(killed, [['real-job', active.id, 'workbench task stop']]);
      assert.equal(last('task-meta', active.id).backgroundJobs, 1, 'accepted cancellation does not invent settlement');
      const beforeUnknown = killed.length;
      assert((await invoke('stop', { sessionId: 'unregistered-session' })).error); assert.equal(killed.length, beforeUnknown);
      const validRegistry = registry;
      registry = undefined;
      const unavailable = await invoke('stop', { sessionId: active.id }); assert.equal(unavailable.result, undefined); assert.match(unavailable.error, /未能完整停止/);
      registry = { list: () => jobRows };
      assert.match((await invoke('stop', { sessionId: active.id })).error, /未能完整停止/);
      registry = { list: () => { throw Error('private registry diagnostic'); }, kill: nativeKill };
      const listFailure = await invoke('stop', { sessionId: active.id }); assert.match(listFailure.error, /未能完整停止/); assert(!listFailure.error.includes('private'));
      registry = { list: () => jobRows, kill: () => { throw Error('private cancel diagnostic'); } };
      const killFailure = await invoke('stop', { sessionId: active.id }); assert.equal(killFailure.result, undefined); assert.match(killFailure.error, /未能完整停止/); assert(!killFailure.error.includes('private'));
      registry = { list: () => jobRows, kill: () => 'unsupported-result' };
      assert.match((await invoke('stop', { sessionId: active.id })).error, /未能完整停止/);
      registry = { list: () => jobRows, kill: () => 'already-finished' };
      assert.equal((await invoke('stop', { sessionId: active.id })).result.accepted, true);
      registry = validRegistry;
      assert.equal((await invoke('stop', { sessionId: 'restored' })).result.accepted, false); assert.equal(resumes, 1);
      emitCtx('session/event', active, event('job/settled', { jobId: 'real-job', owner: active.id, kind: 'bash', status: 'completed' }, 5));
      assert.equal(last('task-meta', active.id).running, false); assert.equal(last('task-meta', active.id).outcome, 'completed');
      emitCtx('session/event', sessions.get('root'), message('real root task', 6));
      emitCtx('session/event', sessions.get('root'), event('job/registered', { jobId: 'root-job', owner: 'root', kind: 'bash' }, 7));
      jobRows = [{ id: 'root-job', owner: 'root', kind: 'bash', status: 'stopping' }, { id: 'unowned-public', kind: 'bash', status: 'running' }];
      assert.equal((await invoke('stop', { sessionId: 'root' })).result.accepted, true);
      assert.deepEqual(killed.at(-1), ['root-job', 'root', 'workbench task stop'], 'tracked root tasks use the same exact-owner background cancellation');
      await invoke('stop', { sessionId: 'catalog-child' }); assert.equal(interrupted.at(-1)[0], 'catalog-child'); assert.equal(interrupted.at(-1)[1].parentSessionId, 'root');
      sessions.set(active.id, active); histories.set(active.id, [message('UI human task', 2)]);
      emitCtx('session/event', sessions.get('root'), event('subagent/catalog', { childId: active.id, mode: 'continuable', label: 'late native child' }, 10)); await tick();
      assert.equal(last('task-roster').sessionIds.includes(active.id), false); assert.equal(last('agent-meta', active.id).source, 'dsh-subagent-catalog');
      assert.deepEqual(last('agent-roster').sessionIds, ['catalog-child', active.id]);
      assert.equal(prompts.length, 0, 'metadata, restoration and stop never prompt a model or tool');
      emitCtx('dispose'); process.stdout.write = originalWrite; console.log('task session bridge fixture passed');
    } finally { process.stdout.write = originalWrite; Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
