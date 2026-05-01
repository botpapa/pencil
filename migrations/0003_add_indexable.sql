-- Default pages to noindex; owners opt-in via the settings page.
ALTER TABLE pages ADD COLUMN indexable INTEGER NOT NULL DEFAULT 0;
