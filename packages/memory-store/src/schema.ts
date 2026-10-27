// memories.sqlite schema: one row per memory item, always owned by one persona.
// seq is the rowid alias and breaks ties when updated_at is equal.
// source_message_ids holds a JSON array of message ids; audio_ref is optional.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  persona_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'episode', 'summary')),
  text               TEXT NOT NULL,
  source_message_ids TEXT NOT NULL,
  confirmation       TEXT NOT NULL CHECK (confirmation IN ('pending', 'confirmed')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  audio_ref          TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS memories_by_persona
  ON memories (persona_id, confirmation);
`;
