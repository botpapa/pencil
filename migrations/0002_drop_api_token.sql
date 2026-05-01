-- Remove the per-page API token column. Edit access is now cookie-only;
-- there is no out-of-band token to maintain anymore.
--
-- SQLite refuses `ALTER TABLE ... DROP COLUMN` on columns covered by a
-- UNIQUE constraint, so we rebuild the table the long way:
--   1. create new table without api_token
--   2. copy rows
--   3. drop old table
--   4. rename new table to old name
--   5. recreate indexes

CREATE TABLE pages_new (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  views        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO pages_new (slug, title, content, owner_id, views, created_at, updated_at)
SELECT slug, title, content, owner_id, views, created_at, updated_at
FROM pages;

DROP TABLE pages;
ALTER TABLE pages_new RENAME TO pages;

CREATE INDEX idx_pages_owner ON pages(owner_id);
CREATE INDEX idx_pages_created ON pages(created_at);
