CREATE TABLE IF NOT EXISTS zettels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  insight     TEXT NOT NULL,
  tags        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
