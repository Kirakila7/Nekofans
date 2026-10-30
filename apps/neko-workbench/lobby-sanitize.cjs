'use strict';
// Text hygiene for lobby prompts and lobby output. Ported from
// N.E.K.O/main_logic/visit/sanitize.py (strip_control_chars, escape_envelope,
// make_envelope_nonce, wrap_nonce_envelope, defang_markdown_media,
// strip_emotion_tags). Every function is pure and synchronous.
const { randomBytes } = require('node:crypto');

const ENVELOPE_TAG = 'lobby_data';
const TAG_BRACKETS = '<＜‹';
const LINE_BREAK = /\r\n|[\r\u2028\u2029\u0085]/g;
// Keep \n, \t, ZWNJ and ZWJ; drop other control, surrogate and format characters
// (bidi overrides, zero-width spaces, BOM).
const CONTROL = /(?![\n\t\u200c\u200d])[\p{Cc}\p{Cs}\p{Cf}]/gu;

function stripControlChars(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(LINE_BREAK, '\n').replace(CONTROL, '');
}

function stripTagOpeners(text) {
  // Anchor at each tag name and walk left over its bracket / slash / space run,
  // removing every bracket so runs such as "<< /lobby_data" leave no tag behind.
  const name = new RegExp(ENVELOPE_TAG, 'gi'), out = [];
  let pos = 0, match;
  while ((match = name.exec(text))) {
    const j = match.index, end = name.lastIndex;
    let k = j;
    while (k > pos && (TAG_BRACKETS.includes(text[k - 1]) || text[k - 1] === '/' || /\s/.test(text[k - 1]))) k--;
    while (k < j && !TAG_BRACKETS.includes(text[k])) k++;
    if (k < j) {
      const run = text.slice(k, j), slash = run.lastIndexOf('/');
      const keep = slash < 0 ? '' : '/' + [...run.slice(slash + 1)].filter(c => !TAG_BRACKETS.includes(c)).join('');
      out.push(text.slice(pos, k), keep, text.slice(j, end));
    } else out.push(text.slice(pos, end));
    pos = end;
  }
  out.push(text.slice(pos));
  return out.join('');
}

/** Neutralise delimiter runs and forged envelope tags. Linear and idempotent. */
function escapeEnvelope(text) {
  if (typeof text !== 'string' || !text) return '';
  return stripTagOpeners(text.replace(/[=＝]{3,}/g, '---'));
}

function makeNonce() { return randomBytes(8).toString('hex'); }

function wrapEnvelope(text, nonce) {
  if (!/^[0-9a-f]{8,64}$/.test(nonce || '')) throw new Error('nonce must be lowercase hex');
  return `<${ENVELOPE_TAG} nonce="${nonce}">\n${text}\n</${ENVELOPE_TAG} nonce="${nonce}">`;
}

function matchPairs(text, opener, closer) {
  const stack = [], pairs = new Map();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === opener) stack.push(i);
    else if (text[i] === closer && stack.length) pairs.set(i, stack.pop());
  }
  return pairs;
}
function defangInlineOnce(text) {
  if (!text.includes('](')) return text;
  const openOfBracket = matchPairs(text, '[', ']');
  const closeOfParen = new Map([...matchPairs(text, '(', ')')].map(([close, open]) => [open, close]));
  const out = [];
  let pos = 0, k = text.indexOf('](');
  while (k >= 0) {
    const start = openOfBracket.get(k) ?? -1, end = closeOfParen.get(k + 1) ?? -1;
    if (start >= pos && end > k) {
      out.push(start > pos && text[start - 1] === '!' ? text.slice(pos, start - 1) : text.slice(pos, start));
      out.push(`${text.slice(start + 1, k)} (${text.slice(k + 2, end)})`);
      pos = end + 1; k = text.indexOf('](', pos);
    } else k = text.indexOf('](', k + 1);
  }
  out.push(text.slice(pos));
  return out.join('');
}
function defangRound(text) {
  return defangInlineOnce(text)
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g, '$1')
    .replace(/<([^\s<>@]+@[^\s<>@]+)>/g, '$1')
    .replace(/^([ \t]{0,3})\[((?:[^[\]\\\n]|\\.)+)\]:/gm, '$1$2:');
}
/** Markdown images, links, autolinks and reference definitions become plain text. Idempotent. */
function defangMarkdownMedia(text) {
  if (typeof text !== 'string' || !text) return '';
  for (let round = 0; round < 16; round++) {
    const next = defangRound(text);
    if (next === text) break;
    text = next;
  }
  return text.replaceAll('](', '] (');
}

/** Remove short closed decoration tags such as <happy> or </开心>; other angle text stays. */
function stripEmotionTags(text) {
  if (typeof text !== 'string' || !text.includes('<')) return typeof text === 'string' ? text : '';
  let removed = 0;
  const stripped = text.replace(/<\/?([^<>]{1,32})>/g, (whole, name) => {
    if (!/^[\p{L}_]+$/u.test(name)) return whole;
    removed++; return '';
  });
  if (!removed) return text;
  return stripped.split('\n').map(line => line.split(/\s+/).filter(Boolean).join(' ')).join('\n').trim();
}

/** Cut to code points and lines, then trim. */
function clamp(text, { maxChars, maxLines = Infinity } = {}) {
  if (typeof text !== 'string') return '';
  let value = text.split('\n').slice(0, maxLines).join('\n');
  const chars = Array.from(value);
  if (Number.isInteger(maxChars) && chars.length > maxChars) value = chars.slice(0, maxChars).join('');
  return value.trim();
}

function removeCatMentions(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<@c:[^<>\s]{1,64}>/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** One received lobby line for a prompt: single line, escaped, bounded. */
function promptLine(text, maxChars = 300) {
  return clamp(escapeEnvelope(stripControlChars(text)).replace(/\s+/g, ' '), { maxChars });
}

/** Model output bound for the lobby: no decoration tags, Markdown media or cat mentions. */
function cleanOutput(text, { maxChars, maxLines }) {
  const value = removeCatMentions(defangMarkdownMedia(stripEmotionTags(stripControlChars(text))));
  return clamp(value.replace(/\n{3,}/g, '\n\n'), { maxChars, maxLines });
}

module.exports = { ENVELOPE_TAG, stripControlChars, escapeEnvelope, makeNonce, wrapEnvelope, defangMarkdownMedia,
  stripEmotionTags, clamp, removeCatMentions, promptLine, cleanOutput };
