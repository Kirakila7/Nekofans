'use strict';

const { createHash } = require('node:crypto');

// DSH names its local browser session cookie after the SHA-256 of the HTTP
// authority. Cookies are host-scoped rather than port-scoped, so prior random
// ports otherwise accumulate in every new request and can exceed header limits.
// This only changes outgoing headers; it never removes stored cookies.
function createDshLoopbackCookieFilter() {
  const boundSessions = new WeakSet();
  let activeOrigin = null, activeCookieName = null;

  function setUrl(value) {
    if (value == null) { activeOrigin = activeCookieName = null; return; }
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('DSH URL 必须是本机 HTTP 地址');
    activeOrigin = url.origin;
    activeCookieName = 'dsh-auth-' + createHash('sha256').update(url.host).digest('base64url');
  }

  function filter(details, callback) {
    const headers = details.requestHeaders || {};
    let origin;
    try {
      const url = new URL(details.url);
      // A DSH WebSocket handshake uses the same local HTTP authority and
      // browser cookie jar. It must receive the same bounded cookie header.
      origin = url.protocol === 'ws:' ? 'http://' + url.host : url.origin;
    } catch { callback({ requestHeaders: headers }); return; }
    if (!activeOrigin || origin !== activeOrigin) { callback({ requestHeaders: headers }); return; }
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'cookie');
    if (!key || typeof headers[key] !== 'string') { callback({ requestHeaders: headers }); return; }
    const parts = headers[key].split(';');
    const kept = parts.filter(part => {
      const name = part.slice(0, part.indexOf('=') < 0 ? part.length : part.indexOf('=')).trim();
      return name === activeCookieName || !/^dsh-auth-[A-Za-z0-9_-]{43}$/.test(name);
    });
    if (kept.length === parts.length) { callback({ requestHeaders: headers }); return; }
    const output = { ...headers };
    if (kept.length) output[key] = kept.join(';'); else delete output[key];
    callback({ requestHeaders: output });
  }

  function bind(session) {
    if (!session?.webRequest || boundSessions.has(session)) return;
    session.webRequest.onBeforeSendHeaders(filter);
    boundSessions.add(session);
  }

  return { setUrl, bind };
}

module.exports = { createDshLoopbackCookieFilter };
