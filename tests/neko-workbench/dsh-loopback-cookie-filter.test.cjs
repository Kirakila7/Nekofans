'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createDshLoopbackCookieFilter } = require('../../apps/neko-workbench/dsh-loopback-cookie-filter.cjs');

const name = authority => 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
const first = name('127.0.0.1:61111'), second = name('127.0.0.1:62222');
function fixture() {
  let listener, calls = 0;
  const session = { webRequest: { onBeforeSendHeaders(fn) { calls++; listener = fn; } } };
  const filter = createDshLoopbackCookieFilter();
  filter.bind(session); filter.bind(session);
  assert.equal(calls, 1, 'listener is installed once for the reused partition');
  const request = (url, requestHeaders) => {
    let output;
    listener({url, requestHeaders}, result => { output = result.requestHeaders; });
    assert(output); return output;
  };
  return { filter, request };
}

test('filters stale DSH auth cookies only on the current loopback origin', () => {
  const {filter, request} = fixture();
  filter.setUrl('http://127.0.0.1:61111/?token=synthetic');
  const input = {Cookie:`theme=blue; ${second}=synthetic-old; ${first}=synthetic-current; dsh-auth-invalid=keep`, Accept:'text/html'};
  const out = request('http://127.0.0.1:61111/?token=synthetic', input);
  assert.equal(out.Cookie, `theme=blue; ${first}=synthetic-current; dsh-auth-invalid=keep`);
  assert.equal(out.Accept, input.Accept);
  assert.equal(input.Cookie.includes('synthetic-old'), true, 'input headers are not mutated');
  assert.equal(request('http://127.0.0.1:61111/assets/example.js', input).Cookie, out.Cookie, 'ordinary resources use the same filter');
  assert.equal(request('ws://127.0.0.1:61111/api/remote.mux', input).Cookie, out.Cookie, 'the local WebSocket handshake uses the same filter');
  assert.equal(request('ws://127.0.0.1:62222/api/remote.mux', input).Cookie, input.Cookie, 'WebSocket on a different port is unaffected');
  assert.equal(request('wss://127.0.0.1:61111/api/remote.mux', input).Cookie, input.Cookie, 'secure WebSocket remains unaffected');
  assert.equal(request('http://127.0.0.1:62222/', input).Cookie, input.Cookie, 'other port is unaffected');
  assert.equal(request('http://localhost:61111/', input).Cookie, input.Cookie, 'other hostname is unaffected');
  assert.equal(request('https://example.org/', input).Cookie, input.Cookie, 'external requests are unaffected');
  assert.deepEqual(request('http://127.0.0.1:61111/', {Accept:'text/html'}), {Accept:'text/html'});
});

test('changing DSH port updates the cookie allowed for the new bootstrap', () => {
  const {filter, request} = fixture();
  const headers = {cookie:`${first}=first; ${second}=second; theme=blue`};
  filter.setUrl('http://127.0.0.1:61111/');
  assert.equal(request('http://127.0.0.1:61111/', headers).cookie, `${first}=first; theme=blue`);
  filter.setUrl('http://127.0.0.1:62222/?token=synthetic');
  assert.equal(request('http://127.0.0.1:62222/?token=synthetic', headers).cookie, ` ${second}=second; theme=blue`);
  assert.equal(request('ws://127.0.0.1:62222/api/remote.mux', headers).cookie, ` ${second}=second; theme=blue`);
  assert.equal(request('ws://127.0.0.1:61111/api/remote.mux', headers).cookie, headers.cookie);
  assert.equal(request('http://127.0.0.1:61111/', headers).cookie, headers.cookie);
  filter.setUrl(null);
  assert.equal(request('http://127.0.0.1:62222/', headers).cookie, headers.cookie);
  assert.throws(() => filter.setUrl('https://example.org/'));
});

test('removes the header only when no cookies remain', () => {
  const {filter, request} = fixture(); filter.setUrl('http://127.0.0.1:61111/');
  assert.deepEqual(request('http://127.0.0.1:61111/', {Cookie:`${second}=synthetic`}), {});
});
