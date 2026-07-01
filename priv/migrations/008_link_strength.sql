ALTER TABLE zettel_links ADD COLUMN strength REAL;
ALTER TABLE zettel_links ADD COLUMN source TEXT DEFAULT 'auto';
