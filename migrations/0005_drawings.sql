-- Drawing canvases for draw.pencil.md. Separate from `pages` because the shape
-- is different: `scene` holds the canvas JSON (elements + viewport), and
-- `thumb_key` points at an R2-stored PNG used for the share/OG card.
CREATE TABLE drawings (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  scene        TEXT NOT NULL,
  thumb_key    TEXT,
  owner_id     TEXT NOT NULL,
  views        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  password_hash TEXT
);

CREATE INDEX idx_drawings_owner ON drawings(owner_id);
CREATE INDEX idx_drawings_created ON drawings(created_at);
