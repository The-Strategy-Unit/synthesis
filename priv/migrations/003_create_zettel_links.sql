CREATE TABLE IF NOT EXISTS zettel_links (
  zettel_id         INTEGER NOT NULL REFERENCES zettels(id) ON DELETE CASCADE,
  related_zettel_id INTEGER NOT NULL REFERENCES zettels(id) ON DELETE CASCADE,
  PRIMARY KEY (zettel_id, related_zettel_id),
  CHECK (zettel_id != related_zettel_id)
);
