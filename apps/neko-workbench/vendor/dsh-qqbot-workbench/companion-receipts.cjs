'use strict';

const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const RECEIPT_LIMIT = 4096;

// The file lives in the workbench's private QQ profile. Keep only hashes of
// delivery identifiers. The claim is committed before calling the model.
function claimQQCompanionReceipt(file, scope, messageId) {
  const key = createHash('sha256').update(JSON.stringify([scope, messageId])).digest('hex');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = 1000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS receipts (
        sequence INTEGER PRIMARY KEY,
        delivery_key TEXT NOT NULL UNIQUE
      );
      BEGIN IMMEDIATE;`);
    const { changes } = db.prepare('INSERT INTO receipts (delivery_key) VALUES (?) ON CONFLICT(delivery_key) DO NOTHING').run(key);
    if (changes) {
      db.prepare(`DELETE FROM receipts WHERE sequence <= (
        SELECT sequence FROM receipts ORDER BY sequence DESC LIMIT 1 OFFSET ?
      )`).run(RECEIPT_LIMIT);
    }
    db.exec('COMMIT');
    return changes > 0;
  } finally {
    // Closing also rolls back any transaction interrupted before commit.
    db.close();
  }
}

module.exports = { claimQQCompanionReceipt };
