-- Mother-confirmed shared balance is authoritative. Local records preserve intent,
-- idempotency and uncertain outcomes; they are never an extra spendable balance.
CREATE TABLE IF NOT EXISTS point_operations (
  operation_id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  member_uid TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount <> 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','pending_member','pending_config','sending','reconciling','confirmed','rejected')),
  mother_balance_after INTEGER,
  mother_transaction_id TEXT,
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS point_operations_member_status ON point_operations(line_user_id,status,created_at);
CREATE TABLE IF NOT EXISTS point_sync_locks (
  line_user_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS point_legacy_snapshots (
  point_uid TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review' CHECK(status IN ('review','resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_action_locks (
  order_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS checkout_requests (
  request_key TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT,
  http_status INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
