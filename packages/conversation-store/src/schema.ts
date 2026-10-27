// conversations.sqlite schema: raw chat messages, one row per message.
// seq is the rowid alias and gives a stable insertion order when created_at ties.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  persona_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS messages_by_conversation
  ON messages (persona_id, conversation_id, seq);
`;
