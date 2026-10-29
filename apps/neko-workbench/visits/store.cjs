'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Deliberately independent of the main-chat and memory databases. Tickets and keys
// never enter this schema. History is viewable after restart, never auto-resumed.
class VisitStore {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS visits (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, vid TEXT NOT NULL,
        persona TEXT NOT NULL, phase TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visit_messages (
        visit_id TEXT NOT NULL REFERENCES visits(id), id TEXT NOT NULL,
        seq INTEGER NOT NULL, sender_vid TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, PRIMARY KEY(visit_id,id), UNIQUE(visit_id,seq));`);
    this.db.prepare("UPDATE visits SET phase='ended',reason='interrupted',updated_at=? WHERE phase IN ('connecting','active')")
      .run(new Date().toISOString());
  }
  openVisit({ visitId, role, vid, persona }) {
    if (this.getVisit(visitId)) throw new Error('visit_already_recorded');
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO visits VALUES (?,?,?,?,?,?,?,?)').run(
      visitId, role, vid, JSON.stringify({ name: persona.name, description: persona.description }), 'connecting', '', now, now);
  }
  appendMessage(visitId, message) {
    this.db.prepare('INSERT INTO visit_messages VALUES (?,?,?,?,?,?)').run(
      visitId, message.id, message.seq, message.senderVid, message.role, message.text);
  }
  setState(visitId, phase, reason = '') {
    this.db.prepare('UPDATE visits SET phase=?,reason=?,updated_at=? WHERE id=?')
      .run(phase, reason, new Date().toISOString(), visitId);
  }
  getVisit(visitId) {
    const row = this.db.prepare('SELECT * FROM visits WHERE id=?').get(visitId);
    if (!row) return null;
    return { visitId: row.id, role: row.role, vid: row.vid, persona: JSON.parse(row.persona),
      phase: row.phase, reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
      messages: this.db.prepare('SELECT id,seq,sender_vid AS senderVid,role,text FROM visit_messages WHERE visit_id=? ORDER BY seq').all(visitId).map(m => ({ ...m })) };
  }
  listVisits() {
    return this.db.prepare('SELECT id AS visitId,role,phase,reason,created_at AS createdAt,updated_at AS updatedAt FROM visits ORDER BY created_at DESC LIMIT 100').all().map(v => ({ ...v }));
  }
  close() { this.db.close(); }
}
module.exports = { VisitStore };
