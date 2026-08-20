-- Atomic daily sign-in claims prevent duplicate rewards from LINE webhook redelivery.
CREATE TABLE IF NOT EXISTS daily_signin_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  claim_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reconciling', 'claimed', 'failed')),
  line_event_id TEXT,
  member_uid TEXT,
  point_uid TEXT,
  reward_points INTEGER NOT NULL DEFAULT 0,
  mother_balance_before INTEGER,
  mother_balance_after INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(line_user_id, claim_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_signin_claims_line_event_id
  ON daily_signin_claims(line_event_id)
  WHERE line_event_id IS NOT NULL AND line_event_id <> '';

CREATE INDEX IF NOT EXISTS idx_daily_signin_claims_status
  ON daily_signin_claims(status);

CREATE INDEX IF NOT EXISTS idx_daily_signin_claims_date
  ON daily_signin_claims(claim_date);
