CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL UNIQUE,
  video_id    TEXT NOT NULL UNIQUE,
  title       TEXT,
  raw_transcript TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
