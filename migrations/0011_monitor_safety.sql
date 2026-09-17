-- Additive operational records only: no wallets, balances or order changes.
CREATE TABLE monitor_ai_health (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  status TEXT NOT NULL DEFAULT 'not_tested', checked_at INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0, lock_token TEXT, lock_until INTEGER NOT NULL DEFAULT 0,
  analysis_status TEXT NOT NULL DEFAULT 'not_tested', analysis_checked_at INTEGER NOT NULL DEFAULT 0,
  analysis_next_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO monitor_ai_health(singleton) VALUES(1);
CREATE TABLE monitor_feedback (
  event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, message_text TEXT NOT NULL,
  received_at INTEGER NOT NULL, event_at INTEGER NOT NULL,
  category TEXT NOT NULL, severity TEXT NOT NULL,
  analysis_state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, lock_token TEXT, lock_until INTEGER NOT NULL DEFAULT 0,
  analysis_error TEXT NOT NULL DEFAULT '', analyzed_at INTEGER,
  review_state TEXT NOT NULL DEFAULT 'new' CHECK(review_state IN ('new','acknowledged','resolved')),
  reviewed_at INTEGER, trace_id TEXT NOT NULL
);
CREATE INDEX monitor_feedback_due ON monitor_feedback(analysis_state,next_attempt_at,lock_until);
CREATE INDEX monitor_feedback_recent ON monitor_feedback(received_at DESC);
CREATE TABLE crm_request_metadata (
  lease_id TEXT PRIMARY KEY, route TEXT NOT NULL, method TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'unknown', phase TEXT NOT NULL DEFAULT 'admitted',
  response_status INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE crm_request_reviews (
  lease_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('known_unresolved','resolved')),
  evidence TEXT NOT NULL, reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- These exact records were investigated. Missing evidence is NOT success.
INSERT INTO crm_request_reviews(lease_id,status,evidence)
SELECT lease_id,'known_unresolved','legacy_missing_route_and_finish_evidence; no_replay_no_balance_change'
FROM crm_request_leases WHERE state='active' AND lease_id IN (
 '9b977f34-3e69-4174-9631-891cd8538cd3','273ae800-bc13-49e5-98c1-f6690bf288b9',
 'f3b20030-6c8a-421a-ba71-bfcc023812de','b8dde9df-ed43-47ca-9b55-d47de30bf3e1',
 'f37bcf43-dd2c-4204-ac67-23a7d2edd45a','939dd97c-5abf-4f3e-ad0d-e427f73d41c2',
 'abefb01c-3c5c-496d-991b-40b88ad2364b','18d56936-2235-464a-a23e-6a77b3293b2b',
 '68e8b276-c371-443f-bd47-71731b36083d');
