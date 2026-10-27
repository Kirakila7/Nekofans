'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Main-process SecretStore; ciphertext only, with no plaintext fallback. */
class WorkbenchSecretStore {
  constructor(file, safeStorage) { this.file = file; this.safeStorage = safeStorage; this.cache = undefined; }
  available() {
    try {
      return this.safeStorage?.isEncryptionAvailable() === true
        && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }
  has() { return fs.existsSync(this.file); }
  async get() {
    if (this.cache !== undefined) return this.cache;
    if (!this.has()) return null;
    if (!this.available()) throw new Error('系统加密存储不可用');
    try { return this.cache = this.safeStorage.decryptString(fs.readFileSync(this.file)); }
    catch { throw new Error('已保存的密钥无法解密，请重新保存或清除'); }
  }
  async set(secret) {
    if (typeof secret !== 'string' || !secret.trim() || /[\r\n]/.test(secret) || secret.length > 16384) throw new Error('密钥格式无效');
    if (!this.available()) throw new Error('系统加密存储不可用，未保存密钥');
    const value = secret.trim();
    try {
      const cipher = this.safeStorage.encryptString(value);
      if (!Buffer.isBuffer(cipher) || !cipher.length) throw new Error('invalid cipher');
      atomicBytes(this.file, cipher);
      this.cache = value;
    } catch { throw new Error('密钥未能加密保存'); }
  }
  async clear() { fs.rmSync(this.file, { force: true }); this.cache = null; }
  async prepareRollback() {
    const previous = this.has() ? fs.readFileSync(this.file) : null;
    return async () => {
      if (previous === null) await this.clear();
      else { atomicBytes(this.file, previous); this.cache = undefined; }
    };
  }
}

module.exports = { WorkbenchSecretStore, atomicBytes };
