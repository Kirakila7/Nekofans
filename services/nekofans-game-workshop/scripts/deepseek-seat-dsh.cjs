'use strict';

// Loaded by the local DSH test host. Only projected account details and
// official sign-in progress cross the private parent/child pipe.
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

exports.name = 'nekofans-local-game-seat';
exports.inject = ['webApp', 'deepseekAccount', 'llm'];
exports.apply = ctx => {
  const input = createInterface({ input: process.stdin });
  const write = value => process.stdout.write(JSON.stringify(value) + '\n');
  const client = { version: process.env.DSH_CLIENT_VERSION, locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
  let choice;
  async function choose(id, payload) {
    if (choice) return { status: 'unavailable' };
    const controller = new AbortController();
    choice = { id, controller };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    try {
      if ((await ctx.deepseekAccount.getState()).status !== 'credential-stored' || signal.aborted) return { status: 'unavailable' };
      const llmPath = path.resolve(path.dirname(process.argv[1]), '../../dsh-llm/lib/index.js');
      const { createUserMessage } = await import(pathToFileURL(llmPath).href);
      const call = await ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 256 }, signal);
      const message = createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ player: payload.player, observation: payload.observation, choices: payload.choices }) }], source: { kind: 'user' } });
      let output = '';
      let complete = false;
      for await (const event of call.stream({ ...call.config, messages: [message], system: payload.instruction, signal })) {
        if (event.type === 'text-delta') output += event.text;
        if (event.type === 'block-end' && event.block?.type === 'text') output = event.block.text;
        if (event.type === 'finish') complete = event.reason?.kind === 'stop';
        if (output.length > 256) return { status: 'invalid' };
      }
      if (signal.aborted) return { status: 'unavailable' };
      return complete && /^\d{1,3}$/.test(output.trim()) ? { status: 'ready', choiceId: Number(output.trim()) } : { status: 'invalid' };
    } catch { return { status: 'unavailable' }; }
    finally { controller.abort(); choice = undefined; }
  }
  async function handle(action, id, payload) {
    const service = ctx.deepseekAccount;
    if (!service) return { status: 'unavailable' };
    if (action === 'choose') return choose(id, payload);
    if (action === 'profile') {
      if ((await service.getState()).status === 'signed-out') return { status: 'signed-out' };
      const profile = await service.getProfile(client);
      if (profile?.status === 'ready' && typeof profile.value?.id === 'string' && profile.value.id) {
        return { status: 'ready', id: profile.value.id, name: profile.value.name };
      }
      const state = await service.getState();
      return { status: state.status === 'signed-out' ? 'signed-out' : 'unavailable' };
    }
    if (action === 'login' && (await service.getState()).status !== 'credential-stored') {
      await service.startSignIn(client, ctx.webApp.getAdvertisedUrl(), 'web');
    }
    const state = await service.getState();
    const attempt = state.attempt;
    if (attempt?.phase === 'waiting-browser') {
      const url = new URL(attempt.authorizeUrl);
      if (url.origin === 'https://platform.deepseek.com') return { status: attempt.phase, url: url.href };
    }
    return { status: state.status === 'credential-stored' ? 'signed-in' : attempt?.phase || 'signed-out' };
  }
  input.on('line', async line => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.action === 'cancel-choice') { if (choice?.id === request.id) choice.controller.abort(); return; }
      if (!['profile', 'login', 'state', 'choose'].includes(request.action)) throw Error('unknown action');
      write({ id: request.id, result: await handle(request.action, request.id, request.payload) });
    } catch { if (request?.id) write({ id: request.id, result: { status: 'unavailable' } }); }
  });
  input.once('close', () => { void Promise.resolve().then(() => ctx.root.dispose?.() ?? ctx.dispose?.()).finally(() => process.exit(0)); });
  ctx.on('dispose', () => input.removeAllListeners('close').close());
  write({ ready: true });
};
