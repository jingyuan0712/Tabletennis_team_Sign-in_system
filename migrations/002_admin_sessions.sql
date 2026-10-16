-- Short-lived, revocable administrator sessions. No passwords or registration history.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
