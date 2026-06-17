CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  template TEXT NOT NULL,
  queries TEXT NOT NULL DEFAULT '{}',
  validation_errors TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT pages_status_check CHECK (status in ('draft','published','archived')),
  CONSTRAINT pages_owner_slug_unique UNIQUE (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS pages_owner_status_idx ON pages(owner_id, status);
CREATE INDEX IF NOT EXISTS pages_owner_slug_idx ON pages(owner_id, slug);

CREATE TABLE IF NOT EXISTS page_access_links (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  label TEXT,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS page_access_links_owner_page_idx ON page_access_links(owner_id, page_id);
CREATE INDEX IF NOT EXISTS page_access_links_secret_hash_idx ON page_access_links(secret_hash);
CREATE INDEX IF NOT EXISTS page_access_links_expires_at_idx ON page_access_links(expires_at);
