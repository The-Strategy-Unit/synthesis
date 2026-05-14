DROP TABLE IF EXISTS embeddings;

CREATE VIRTUAL TABLE embeddings USING vec0(
  zettel_id INTEGER PRIMARY KEY,
  vector    FLOAT[4096] distance_metric=cosine
);
