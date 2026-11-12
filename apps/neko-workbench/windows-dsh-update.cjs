'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readWindowsDshVersion } = require('./windows-dsh-runtime.cjs');
const { writeAtomicStateFileSync } = require('./atomic-state-file.cjs');

const feedUrl = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml';
const downloadRoot = 'https://download.deepseek.com/dsh-desk/bin/win-x64/';
const publisher = 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.';
const maxBytes = 1024 ** 3;
const run = promisify(execFile);

function versionParts(version) {
  if (typeof version !== 'string') return null;
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(alpha|beta|rc)\.(\d{1,6}))?$/.exec(version);
  return match && [Number(match[1]), Number(match[2]), Number(match[3]), ['alpha', 'beta', 'rc', undefined].indexOf(match[4]), Number(match[5] || 0)];
}

function isNewer(candidate, current) {
  const next = versionParts(candidate), previous = versionParts(current);
  if (!next || !previous) return false;
  const firstDifference = next.findIndex((value, index) => value !== previous[index]);
  return firstDifference >= 0 && next[firstDifference] > previous[firstDifference];
}

function parseFeed(text) {
  function field(key) {
    const match = new RegExp('^' + key + ':[ \\t]*(?:>-?[ \\t]*\\r?\\n[ \\t]+)?([^\\r\\n]+)$', 'm').exec(text);
    return match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const version = field('version'), url = field('path'), sha512 = field('sha512');
  if (!versionParts(version) || url !== downloadRoot + 'deepseek-harness-' + version + '-win-x64.exe' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(sha512 || '')) throw Error('无法识别 DeepSeek 官方更新清单');
  return { version, url, sha512, date: field('releaseDate') || '' };
}

function createDshUpdateStore(dataDir) {
  const root = path.join(dataDir, 'dsh-engine-updates');
  const file = path.join(root, 'active.json');
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    catch { return {}; }
  }
  function write(value) { writeAtomicStateFileSync(file, JSON.stringify(value) + '\n'); }
  function resources(entry) {
    return versionParts(entry?.version) && /^engine-[a-zA-Z0-9]{6}$/.test(entry.directory || '')
      ? path.join(root, entry.directory, 'engine', 'resources') : null;
  }
  function select(bundledVersion) {
    const pointer = read();
    const selected = resources(pointer);
    if (!selected || !isNewer(pointer.version, bundledVersion)) return null;
    try {
      if (!fs.existsSync(path.join(selected, 'runtime/primary-runtime')) ||
          !fs.existsSync(path.join(selected, 'app.asar.unpacked')) ||
          readWindowsDshVersion(selected) !== pointer.version) return null;
    } catch { return null; }
    return { resources: selected, version: pointer.version, trial: pointer.verified !== true };
  }
  function confirm(version) {
    const active = read();
    if (active.version === version && !active.verified) write({ ...active, verified: true });
  }
  function rollback(version) {
    const active = read();
    if (active.version !== version || active.verified) return false;
    write(resources(active.previous) ? { ...active.previous, verified: true } : {});
    return true;
  }
  function activate(version, directory, currentVersion) {
    const active = read();
    const previous = active.version === currentVersion && active.verified
      ? { version: active.version, directory: active.directory } : undefined;
    write({ version, directory, previous, verified: false });
  }
  return { root, resources, read, select, confirm, rollback, activate };
}

async function fetchOfficial(url, timeout) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) throw Error('DeepSeek 官方更新服务暂不可用');
  return response;
}

async function checkDshUpdate(currentVersion) {
  const response = await fetchOfficial(feedUrl, 15000);
  const chunks = [];
  let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 65536) throw Error('DeepSeek 官方更新清单异常');
    chunks.push(bytes);
  }
  const release = parseFeed(Buffer.concat(chunks).toString('utf8'));
  return isNewer(release.version, currentVersion) ? release : null;
}

async function verifyPublisher(installer) {
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const code = '$ErrorActionPreference="Stop"; Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); ' +
    '$s=Get-AuthenticodeSignature -LiteralPath $env:NEKO_DSH_SIGNED_FILE; ' +
    'if ($s.Status -ne "Valid" -or $s.SignerCertificate.GetNameInfo(0,$false) -ne $env:NEKO_DSH_SIGNER) { exit 1 }';
  await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 60000,
    env: { ...process.env, NEKO_DSH_SIGNED_FILE: installer, NEKO_DSH_SIGNER: publisher },
  }).catch(() => { throw Error('更新包的 DeepSeek 数字签名未通过验证'); });
}

async function installDshUpdate({ store, release, currentVersion, extractor, progress = () => {} }) {
  const verified = parseFeed('version: ' + release.version + '\npath: ' + release.url + '\nsha512: ' + release.sha512);
  if (!isNewer(verified.version, currentVersion)) throw Error('更新版本必须高于当前引擎版本');
  await fsp.mkdir(store.root, { recursive: true });
  const root = await fsp.realpath(store.root);
  const staging = await fsp.mkdtemp(path.join(root, 'engine-'));
  const installer = path.join(staging, 'harness.exe');
  let activated = false;
  try {
    const response = await fetchOfficial(verified.url, 15 * 60_000);
    const expectedBytes = Number(response.headers.get('content-length'));
    const digest = createHash('sha512');
    let received = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > maxBytes) return done(Error('DeepSeek 更新包超过大小限制'));
        digest.update(chunk);
        if (expectedBytes > 0) progress(Math.min(0.95, received / expectedBytes * 0.95));
        done(null, chunk);
      },
    }), fs.createWriteStream(installer, { flags: 'wx' }));
    if (digest.digest('base64') !== verified.sha512) throw Error('DeepSeek 更新包校验失败');
    await verifyPublisher(installer);

    const options = { windowsHide: true, timeout: 5 * 60_000, maxBuffer: 512 * 1024 };
    await run(extractor, ['x', installer, '-ir!app-64.7z', '-o' + staging, '-y', '-bso0', '-bsp0'], options);
    const payload = path.join(staging, '$PLUGINSDIR', 'app-64.7z');
    const extracted = path.join(staging, 'engine');
    await run(extractor, ['x', payload, 'resources/app.asar', 'resources/app.asar.unpacked/*', 'resources/runtime/*',
      '-o' + extracted, '-y', '-bso0', '-bsp0'], options);
    const resources = path.join(extracted, 'resources');
    if (readWindowsDshVersion(resources) !== verified.version ||
        !fs.existsSync(path.join(resources, 'app.asar.unpacked')) ||
        !fs.existsSync(path.join(resources, 'runtime/primary-runtime'))) throw Error('更新包中的 DSH 引擎不完整或版本不匹配');
    store.activate(verified.version, path.basename(staging), currentVersion);
    activated = true;
    progress(1);
  } finally {
    await Promise.allSettled([fsp.unlink(installer), fsp.unlink(path.join(staging, '$PLUGINSDIR', 'app-64.7z'))]);
    if (!activated && path.dirname(staging) === root) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { createDshUpdateStore, checkDshUpdate, installDshUpdate, isNewer, parseFeed };
