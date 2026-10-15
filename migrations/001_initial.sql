-- No history/archive tables. Only the API and scheduler OS user can open this file.
CREATE TABLE entries (
  id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 20 AND length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('leave', 'late')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200 AND length(trim(reason)) > 0),
  eta TEXT CHECK (eta IS NULL OR (length(eta) = 5 AND eta GLOB '[0-2][0-9]:[0-5][0-9]' AND eta < '24:00')),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status = 'late' OR eta IS NULL)
) STRICT;
CREATE INDEX entries_day_name ON entries(day, name);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
