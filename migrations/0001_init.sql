-- pencil.md initial schema
-- Stores all pages. Spec section 2.

CREATE TABLE pages (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  api_token    TEXT NOT NULL UNIQUE,
  views        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_pages_owner ON pages(owner_id);
CREATE INDEX idx_pages_created ON pages(created_at);
