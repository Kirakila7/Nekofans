// app.sqlite schema for character identity (F05).
// memory_receipts is created here so the foreign key to characters exists from
// the first run; writing receipts belongs to F06.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS characters (
  character_id  TEXT PRIMARY KEY CHECK (character_id GLOB 'character_[0-9a-f]*' AND length(character_id) = 42),
  -- NOCASE: the memory store lives on a case-insensitive filesystem on Windows,
  -- so "Fish" and "fish" would share one directory.
  upstream_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'renaming'))
) STRICT;

CREATE TABLE IF NOT EXISTS appearance_bindings (
  character_id  TEXT NOT NULL REFERENCES characters (character_id) ON DELETE CASCADE,
  appearance_id TEXT NOT NULL,
  bound_at      TEXT NOT NULL,
  is_active     INTEGER NOT NULL CHECK (is_active IN (0, 1))
) STRICT;

CREATE INDEX IF NOT EXISTS appearance_bindings_by_character
  ON appearance_bindings (character_id, bound_at);

-- At most one active appearance per character.
CREATE UNIQUE INDEX IF NOT EXISTS appearance_bindings_one_active
  ON appearance_bindings (character_id) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS memory_receipts (
  receipt_id    TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters (character_id) ON DELETE CASCADE,
  turn_id       TEXT NOT NULL UNIQUE,
  submitted_at  TEXT NOT NULL,
  status        TEXT NOT NULL
) STRICT;
`;
