'use strict';

const http = require('node:http');

const PROTOCOL = 'nekofans-lobby-agent';
const PORT = 48925;
const PATH = '/nekofans/agent-bridge';
const MAX_RESPONSE_BYTES = 16 * 1024;

async function requestBridge(payload, signal) {
  const body = Buffer.from(JSON.stringify({ protocol: PROTOCOL, version: 1, ...payload }));
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: PORT, path: PATH, method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, resolve);
    request.once('error', reject);
    request.end(body);
  });
  if (response.statusCode !== 200 || !/^application\/json\b/i.test(response.headers['content-type'] || '')) {
    response.destroy();
    throw new Error('Invalid agent bridge response');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('Agent bridge response too large');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result?.protocol !== PROTOCOL || result.version !== 1) throw new Error('Incompatible agent bridge');
  return result;
}

async function connectLobbyAgentBridge({ signal, onStatus }) {
  const result = await requestBridge({ type: 'probe' }, AbortSignal.any([signal, AbortSignal.timeout(2500)]));
  if (result.ready !== true || result.publicTextOnly !== true) throw new Error('Agent bridge is not ready for public text');
  return {
    async *stream(input) {
      const message = input.messages.at(-1);
      try {
        // The independent lobby turn supplies public text here. The adapter
        // never receives the private persona, memory, or account credentials.
        const result = await requestBridge({
          type: 'reply', requestId: message.id, audience: 'public-lobby', allowTools: false, text: message.text,
        }, input.signal);
        if (typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 4000) throw new Error('Invalid agent reply');
        onStatus(true);
        yield { type: 'delta', text: result.reply };
      } catch (error) {
        if (!input.signal.aborted) onStatus(false);
        throw error;
      }
    },
  };
}

module.exports = { connectLobbyAgentBridge };
