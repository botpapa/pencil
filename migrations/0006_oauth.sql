-- OAuth 2.1 authorization server backing the MCP connector (/mcp).
-- pencil.md has no accounts: the "user" an agent acts as is the same cookie
-- identity (owner_id) the browser uses, so pages an agent publishes show up in
-- that browser's /pages list and stay editable there.

-- Dynamically registered clients (RFC 7591) — Claude, ChatGPT, anything else.
CREATE TABLE oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_secret_hash         TEXT,                -- NULL for public clients
  client_name                TEXT NOT NULL,
  redirect_uris              TEXT NOT NULL,       -- JSON array of exact URIs
  token_endpoint_auth_method TEXT NOT NULL,       -- none | client_secret_post | client_secret_basic
  client_uri                 TEXT,
  logo_uri                   TEXT,
  created_at                 INTEGER NOT NULL
);

-- Short-lived authorization codes (PKCE S256 only, single use).
CREATE TABLE oauth_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  resource              TEXT,
  expires_at            INTEGER NOT NULL,
  used                  INTEGER NOT NULL DEFAULT 0
);

-- Access + refresh tokens, stored hashed. `grant_id` ties a refresh chain to
-- its access tokens so revoking one revokes the connection.
CREATE TABLE oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                      -- access | refresh
  grant_id     TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  scope        TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX idx_oauth_tokens_owner ON oauth_tokens(owner_id);
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);

-- One-time "sign this browser in" links minted by the connector so a user can
-- edit agent-published pages from any browser.
CREATE TABLE login_links (
  code_hash   TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
