'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const RETRY_DELAYS = [25, 50, 100, 200];
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const pauseSync = milliseconds => Atomics.wait(waitBuffer, 0, 0, milliseconds);

// main.save remains synchronous: callers rely on a failed save throwing before
// they publish the new state. Never remove the old target to make a retry work.
function writeAtomicStateFileSync(file, contents, {io = fs, platform = process.platform, pause = pauseSync} = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof contents !== 'string') throw new TypeError('Invalid state file write');
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  let descriptor, created = false;
  try {
    descriptor = io.openSync(temporary, 'wx', 0o600);
    created = true;
    io.writeFileSync(descriptor, contents, 'utf8');
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    for (let attempt = 0; ; attempt++) {
      try { io.renameSync(temporary, file); return; }
      catch (error) {
        if (platform !== 'win32' || attempt >= RETRY_DELAYS.length || !RETRY_CODES.has(error?.code)) throw error;
        pause(RETRY_DELAYS[attempt]);
      }
    }
  } finally {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
    // An exclusive-open failure may mean this name belongs to another writer.
    // Only a file created by this invocation can be cleaned up here.
    if (created) { try { io.unlinkSync(temporary); } catch {} }
  }
}

module.exports = { writeAtomicStateFileSync };
