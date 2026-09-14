-- Atomic one-time reward claims prevent duplicate awards from concurrent LINE webhook deliveries.
CREATE TABLE IF NOT EXISTS reward_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  reward_type TEXT NOT NULL,
  reward_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reconciling', 'claimed', 'failed')),
  line_event_id TEXT,
  member_uid TEXT,
  point_uid TEXT,
  reward_points INTEGER NOT NULL DEFAULT 0,
  balance_after INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(line_user_id, reward_type, reward_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_claims_line_event_id
  ON reward_claims(line_event_id)
  WHERE line_event_id IS NOT NULL AND line_event_id <> '';

CREATE INDEX IF NOT EXISTS idx_reward_claims_lookup
  ON reward_claims(line_user_id, reward_type, reward_key);

CREATE INDEX IF NOT EXISTS idx_reward_claims_status
  ON reward_claims(status);

CREATE INDEX IF NOT EXISTS idx_reward_claims_updated_at
  ON reward_claims(updated_at);
