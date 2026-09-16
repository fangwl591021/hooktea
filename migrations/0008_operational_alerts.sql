-- Operational metadata only. No member identifiers, message bodies or balances.
CREATE TABLE operational_alerts (
  alert_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  route TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX operational_alerts_due ON operational_alerts(sent_at,next_attempt_at,lease_until);
