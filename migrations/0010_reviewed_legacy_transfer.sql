-- Explicitly reviewed legacy accounts only. Creating schema transfers nobody.
CREATE TABLE child_legacy_fences (
  line_uid TEXT PRIMARY KEY NOT NULL,
  crm_id TEXT NOT NULL UNIQUE,
  review_id TEXT NOT NULL UNIQUE,
  identity_review_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'fenced' CHECK(status IN ('fenced','released')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER child_legacy_fence_validate BEFORE INSERT ON child_legacy_fences BEGIN
  SELECT (CASE WHEN length(NEW.line_uid)<>33 OR substr(NEW.line_uid,1,1)<>'U' OR NEW.crm_id=NEW.line_uid
    OR length(trim(NEW.identity_review_id))=0 OR length(trim(NEW.actor_id))=0
    OR EXISTS(SELECT 1 FROM child_point_wallets WHERE line_uid=NEW.line_uid)
    OR EXISTS(SELECT 1 FROM point_operations WHERE (line_user_id=NEW.line_uid OR member_uid IN (NEW.line_uid,NEW.crm_id)) AND status NOT IN ('confirmed','rejected'))
    OR EXISTS(SELECT 1 FROM point_sync_locks WHERE line_user_id=NEW.line_uid)
    THEN RAISE(ABORT,'LEGACY_TRANSFER_REQUIRES_REVIEW') END);
END;
CREATE TABLE child_legacy_fence_events (
 event_id INTEGER PRIMARY KEY AUTOINCREMENT,line_uid TEXT NOT NULL,previous_status TEXT NOT NULL,next_status TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER child_legacy_fence_no_update BEFORE UPDATE ON child_legacy_fences
BEGIN
 SELECT (CASE WHEN NEW.line_uid<>OLD.line_uid OR NEW.crm_id<>OLD.crm_id OR NEW.review_id<>OLD.review_id
   OR NEW.identity_review_id<>OLD.identity_review_id OR NEW.actor_id<>OLD.actor_id OR NEW.created_at<>OLD.created_at
   OR EXISTS(SELECT 1 FROM child_point_wallets WHERE line_uid=OLD.line_uid)
   OR EXISTS(SELECT 1 FROM child_legacy_transfers WHERE line_uid=OLD.line_uid)
   OR (NEW.status='fenced' AND (EXISTS(SELECT 1 FROM point_sync_locks WHERE line_user_id=OLD.line_uid)
     OR EXISTS(SELECT 1 FROM point_operations WHERE (line_user_id=OLD.line_uid OR member_uid IN (OLD.crm_id,OLD.line_uid)) AND status NOT IN ('confirmed','rejected'))))
   THEN RAISE(ABORT,'LEGACY_FENCE_IMMUTABLE') END);
END;
CREATE TRIGGER child_legacy_fence_audit AFTER UPDATE OF status ON child_legacy_fences
BEGIN INSERT INTO child_legacy_fence_events(line_uid,previous_status,next_status) VALUES(NEW.line_uid,OLD.status,NEW.status); END;
CREATE TRIGGER child_legacy_fence_events_no_update BEFORE UPDATE ON child_legacy_fence_events
BEGIN SELECT RAISE(ABORT,'LEGACY_FENCE_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER child_legacy_fence_events_no_delete BEFORE DELETE ON child_legacy_fence_events
BEGIN SELECT RAISE(ABORT,'LEGACY_FENCE_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER child_legacy_fence_no_delete BEFORE DELETE ON child_legacy_fences
BEGIN SELECT RAISE(ABORT,'LEGACY_FENCE_IMMUTABLE'); END;
CREATE TRIGGER legacy_transfer_mother_insert_fence BEFORE INSERT ON point_operations
WHEN EXISTS(SELECT 1 FROM child_legacy_fences WHERE status='fenced' AND (line_uid=NEW.line_user_id OR crm_id=NEW.member_uid OR line_uid=NEW.member_uid))
BEGIN SELECT RAISE(ABORT,'CHILD_AUTHORITY_REQUIRED'); END;
CREATE TRIGGER legacy_transfer_mother_update_fence BEFORE UPDATE ON point_operations
WHEN EXISTS(SELECT 1 FROM child_legacy_fences WHERE status='fenced' AND (line_uid=OLD.line_user_id OR crm_id=OLD.member_uid OR line_uid=OLD.member_uid))
BEGIN SELECT RAISE(ABORT,'CHILD_AUTHORITY_REQUIRED'); END;
CREATE TRIGGER legacy_transfer_mother_lock_fence BEFORE INSERT ON point_sync_locks
WHEN EXISTS(SELECT 1 FROM child_legacy_fences WHERE line_uid=NEW.line_user_id AND status='fenced')
BEGIN SELECT RAISE(ABORT,'CHILD_AUTHORITY_REQUIRED'); END;

CREATE TABLE child_legacy_transfers (
  line_uid TEXT PRIMARY KEY NOT NULL REFERENCES child_legacy_fences(line_uid),
  crm_id TEXT NOT NULL UNIQUE,
  review_id TEXT NOT NULL UNIQUE,
  identity_review_id TEXT NOT NULL,
  opening_balance INTEGER NOT NULL CHECK(typeof(opening_balance)='integer' AND opening_balance BETWEEN 0 AND 9007199254740991),
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
  archive_key TEXT NOT NULL,
  history_json TEXT NOT NULL CHECK(json_valid(history_json) AND json_type(history_json)='array'),
  history_count INTEGER NOT NULL CHECK(history_count=json_array_length(history_json)),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER child_legacy_transfer_validate BEFORE INSERT ON child_legacy_transfers BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM child_legacy_fences f WHERE f.line_uid=NEW.line_uid AND f.crm_id=NEW.crm_id
    AND f.review_id=NEW.review_id AND f.identity_review_id=NEW.identity_review_id AND f.status='fenced')
    OR EXISTS(SELECT 1 FROM point_sync_locks WHERE line_user_id=NEW.line_uid)
    OR EXISTS(SELECT 1 FROM point_operations WHERE (line_user_id=NEW.line_uid OR member_uid IN (NEW.line_uid,NEW.crm_id)) AND status NOT IN ('confirmed','rejected'))
    THEN RAISE(ABORT,'LEGACY_TRANSFER_CONFLICT') END);
END;
CREATE TRIGGER child_legacy_transfer_no_update BEFORE UPDATE ON child_legacy_transfers
BEGIN SELECT RAISE(ABORT,'LEGACY_TRANSFER_IMMUTABLE'); END;
CREATE TRIGGER child_legacy_transfer_no_delete BEFORE DELETE ON child_legacy_transfers
BEGIN SELECT RAISE(ABORT,'LEGACY_TRANSFER_IMMUTABLE'); END;

DROP TRIGGER child_wallet_new_guard;
CREATE TRIGGER child_wallet_new_guard BEFORE INSERT ON child_point_wallets
WHEN NOT EXISTS(SELECT 1 FROM child_legacy_transfers t WHERE t.line_uid=NEW.line_uid AND NEW.member_id=t.line_uid
  AND NEW.enrollment_id='legacy-transfer:'||t.review_id AND NEW.balance=0)
BEGIN
  SELECT (CASE WHEN NEW.balance<>0 OR
    EXISTS(SELECT 1 FROM child_legacy_fences WHERE line_uid=NEW.line_uid) OR
    EXISTS(SELECT 1 FROM point_operations p WHERE (p.line_user_id=NEW.line_uid OR p.member_uid=NEW.member_id)
      AND NOT EXISTS(SELECT 1 FROM child_empty_account_reviews r WHERE r.line_uid=NEW.line_uid
        AND r.enrollment_id=NEW.enrollment_id AND r.operation_id=p.operation_id AND p.status='pending_member'
        AND p.error_code='user_not_found' AND p.amount=r.amount AND p.kind=r.kind AND p.reason=r.reason)) OR
    EXISTS(SELECT 1 FROM point_legacy_snapshots WHERE line_user_id=NEW.line_uid OR point_uid=NEW.member_id) OR
    EXISTS(SELECT 1 FROM point_sync_locks WHERE line_user_id=NEW.line_uid) OR
    EXISTS(SELECT 1 FROM daily_signin_claims WHERE line_user_id=NEW.line_uid OR member_uid=NEW.member_id) OR
    EXISTS(SELECT 1 FROM reward_claims WHERE line_user_id=NEW.line_uid OR member_uid=NEW.member_id) OR
    EXISTS(SELECT 1 FROM checkout_requests WHERE line_user_id=NEW.line_uid)
    THEN RAISE(ABORT,'CHILD_EXISTING_ACCOUNT_REVIEW') END);
END;
CREATE TRIGGER child_legacy_opening_guard BEFORE INSERT ON child_point_ledger
WHEN NEW.source_kind='legacy_opening'
BEGIN
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM child_legacy_transfers t JOIN child_point_wallets w ON w.line_uid=t.line_uid
   WHERE t.line_uid=NEW.member_id AND w.enrollment_id='legacy-transfer:'||t.review_id
   AND NEW.operation_id='legacy-opening:'||t.review_id AND NEW.business_key=NEW.operation_id
   AND NEW.kind='adjustment' AND NEW.amount=t.opening_balance AND NEW.balance_after=t.opening_balance
   AND w.balance=0 AND NEW.actor_id='system:legacy-transfer')
   THEN RAISE(ABORT,'LEGACY_OPENING_INVALID') END);
END;
