'use strict';
const path = require('node:path');

// QQ sessions use this host-owned cwd, including persisted sessions that have
// not been resumed yet. Their UUIDs and user/message sources are otherwise
// indistinguishable from ordinary human-owned workbench tasks.
function createChannelSessionPrivacy(dataDir, { fishWorkspace } = {}) {
  const normalize = value => {
    if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) return null;
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const qqWorkspace = normalize(path.resolve(dataDir, 'qqbot-runtime', 'workspace'));
  const fishRoot = normalize(fishWorkspace);
  const privateIds = new Set();
  return {
    isPrivate(id, session) {
      const header = session?.header;
      const cwd = normalize(header?.cwd);
      if (privateIds.has(id) || cwd === qqWorkspace || (fishRoot && cwd === fishRoot) || privateIds.has(header?.parentSession)) {
        privateIds.add(id);
        return true;
      }
      return false;
    },
  };
}

module.exports = { createChannelSessionPrivacy };
