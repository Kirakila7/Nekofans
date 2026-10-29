'use strict';

// Project the host's existing in-memory log buffer into bounded, non-content
// diagnostics. Never return log arguments, identifiers, request bodies or URLs.
function qqDiagnostics(buffer) {
  const result = { accepted: 0, sessionRequested: 0, sessionReady: 0, modelQueued: 0, errors: [] };
  for (const entry of Array.isArray(buffer) ? buffer.slice(-1000) : []) {
    const named = /qqbot|qq-bot/i.test(entry?.name || '');
    for (const arg of Array.isArray(entry.args) ? entry.args : []) {
      const text = typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : '';
      if (!named && !/^(?:Processing an incoming QQ message|ERROR creating session:|getOrCreate:|resumed session:|created session:|reusing live agent:|→ followup sent:|im-qqbot:)/.test(text) && !text.includes('QQ 会话工具防护不可用')) continue;
      if (text === 'Processing an incoming QQ message') result.accepted++;
      if (text.startsWith('getOrCreate:')) result.sessionRequested++;
      if (/^(?:resumed session:|created session:|reusing live agent:)/.test(text)) result.sessionReady++;
      if (text.includes('followup sent:')) result.modelQueued++;
      if (entry.type !== 'error' && !text.startsWith('ERROR creating session:')) continue;
      let kind = 'runtime-error';
      if (text.includes('QQ 会话工具防护不可用')) kind = 'tool-guard-unavailable';
      else if (text.includes('creating session')) kind = 'session-create-failed';
      else if (/invalid appid or secret/.test(text)) kind = 'qq-credentials-rejected';
      else if (/sendMarkdown|fallback reply|flush failed|stream complete/.test(text)) kind = 'reply-send-failed';
      else if (/access|permission|forbidden/i.test(text)) kind = 'access-denied';
      const missingMethod = text.match(/\b(?:this\.agents\.(?:resume|create|get)|(?:scoped|agentCtx)\.tools\.(?:guard|restrict)|agent\.model\.select) is not a function\b/)?.[0];
      const httpStatus = text.match(/\bHTTP ([45]\d\d)\b/)?.[1];
      const nativeCode = text.match(/\b(?:ERR_[A-Z_]+|EACCES|EPERM|ENOENT|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/)?.[0];
      const row = { kind, ...(missingMethod ? { missingMethod } : {}), ...(httpStatus ? { httpStatus: Number(httpStatus) } : {}), ...(nativeCode ? { nativeCode } : {}) };
      if (!result.errors.some(x => JSON.stringify(x) === JSON.stringify(row))) result.errors.push(row);
    }
  }
  result.errors = result.errors.slice(-8);
  return result;
}
module.exports = { qqDiagnostics };
