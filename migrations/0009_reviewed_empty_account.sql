-- Staff-reviewed empty accounts only: not a general legacy balance migration.
-- Receipt insertion atomically fences the old journal. Historical intents stay
-- intact, with an explicit terminal transfer marker, never deleted or replayed.
CREATE TABLE child_empty_account_reviews (
  line_uid TEXT PRIMARY KEY NOT NULL,
  enrollment_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE REFERENCES point_operations(operation_id),
  amount INTEGER NOT NULL CHECK(amount>0 AND typeof(amount)='integer'),
  kind TEXT NOT NULL CHECK(kind='daily_signin'),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id))>0),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json,'$.openingBalance')='integer'
    AND json_extract(evidence_json,'$.openingBalance')=0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER child_empty_review_validate BEFORE INSERT ON child_empty_account_reviews BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM point_operations WHERE operation_id=NEW.operation_id
    AND line_user_id=NEW.line_uid AND member_uid=NEW.line_uid AND status='pending_member'
    AND error_code='user_not_found' AND mother_balance_after IS NULL AND mother_transaction_id IS NULL
    AND amount=NEW.amount AND kind=NEW.kind AND reason=NEW.reason)
    OR EXISTS(SELECT 1 FROM point_operations WHERE (line_user_id=NEW.line_uid OR member_uid=NEW.line_uid) AND operation_id<>NEW.operation_id)
    OR EXISTS(SELECT 1 FROM point_sync_locks WHERE line_user_id=NEW.line_uid)
    OR EXISTS(SELECT 1 FROM point_legacy_snapshots WHERE line_user_id=NEW.line_uid OR point_uid=NEW.line_uid)
    OR EXISTS(SELECT 1 FROM daily_signin_claims WHERE line_user_id=NEW.line_uid OR member_uid=NEW.line_uid)
    OR EXISTS(SELECT 1 FROM reward_claims WHERE line_user_id=NEW.line_uid OR member_uid=NEW.line_uid)
    OR EXISTS(SELECT 1 FROM checkout_requests WHERE line_user_id=NEW.line_uid)
    OR EXISTS(SELECT 1 FROM child_point_wallets WHERE line_uid=NEW.line_uid)
    THEN RAISE(ABORT,'EMPTY_ACCOUNT_REVIEW_CONFLICT') END);
END;
CREATE TRIGGER child_empty_review_no_update BEFORE UPDATE ON child_empty_account_reviews
BEGIN SELECT RAISE(ABORT,'EMPTY_REVIEW_IMMUTABLE'); END;
CREATE TRIGGER child_empty_review_no_delete BEFORE DELETE ON child_empty_account_reviews
BEGIN SELECT RAISE(ABORT,'EMPTY_REVIEW_IMMUTABLE'); END;
CREATE TRIGGER child_review_mother_insert_fence BEFORE INSERT ON point_operations
WHEN EXISTS(SELECT 1 FROM child_empty_account_reviews WHERE line_uid=NEW.line_user_id OR line_uid=NEW.member_uid)
BEGIN SELECT RAISE(ABORT,'CHILD_AUTHORITY_REQUIRED'); END;
CREATE TRIGGER child_review_mother_lock_fence BEFORE INSERT ON point_sync_locks
WHEN EXISTS(SELECT 1 FROM child_empty_account_reviews WHERE line_uid=NEW.line_user_id)
BEGIN SELECT RAISE(ABORT,'CHILD_AUTHORITY_REQUIRED'); END;
CREATE TRIGGER child_review_mother_update_fence BEFORE UPDATE ON point_operations
WHEN EXISTS(SELECT 1 FROM child_empty_account_reviews WHERE line_uid=OLD.line_user_id OR line_uid=OLD.member_uid)
BEGIN
  SELECT (CASE WHEN NOT (OLD.status='pending_member' AND NEW.status='rejected' AND NEW.error_code='TRANSFERRED_TO_CHILD'
    AND NEW.operation_id=OLD.operation_id AND NEW.line_user_id=OLD.line_user_id AND NEW.member_uid=OLD.member_uid
    AND NEW.amount=OLD.amount AND NEW.kind=OLD.kind AND NEW.reason=OLD.reason AND NEW.metadata_json=OLD.metadata_json
    AND NEW.created_at=OLD.created_at AND NEW.mother_balance_after IS NULL AND NEW.mother_transaction_id IS NULL
    AND EXISTS(SELECT 1 FROM child_empty_account_reviews WHERE operation_id=OLD.operation_id))
    THEN RAISE(ABORT,'CHILD_AUTHORITY_REQUIRED') END);
END;
CREATE TRIGGER child_review_mother_no_delete BEFORE DELETE ON point_operations
WHEN EXISTS(SELECT 1 FROM child_empty_account_reviews WHERE operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'TRANSFER_SOURCE_IMMUTABLE'); END;

DROP TRIGGER child_wallet_new_guard;
CREATE TRIGGER child_wallet_new_guard BEFORE INSERT ON child_point_wallets BEGIN
  SELECT (CASE WHEN NEW.balance<>0 OR
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
DROP TRIGGER child_point_validate;
CREATE TRIGGER child_point_validate BEFORE INSERT ON child_point_ledger BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM child_point_wallets WHERE member_id=NEW.member_id AND status='active')
    THEN RAISE(ABORT,'CHILD_WALLET_UNAVAILABLE') END);
  SELECT (CASE WHEN NEW.balance_after<>(SELECT balance+NEW.amount FROM child_point_wallets WHERE member_id=NEW.member_id)
    THEN RAISE(ABORT,'CHILD_BALANCE_CONFLICT') END);
  SELECT (CASE WHEN NEW.kind='refund' AND NOT EXISTS(SELECT 1 FROM child_point_ledger
    WHERE member_id=NEW.member_id AND kind='spend' AND business_key=NEW.business_key AND amount=-NEW.amount)
    THEN RAISE(ABORT,'CHILD_REFUND_INVALID') END);
  SELECT (CASE WHEN EXISTS(SELECT 1 FROM point_operations WHERE operation_id=NEW.operation_id)
    AND NOT EXISTS(SELECT 1 FROM child_empty_account_reviews r JOIN point_operations p ON p.operation_id=r.operation_id
      JOIN child_point_wallets w ON w.line_uid=r.line_uid AND w.enrollment_id=r.enrollment_id
      WHERE r.operation_id=NEW.operation_id AND r.line_uid=NEW.member_id AND r.amount=NEW.amount
      AND r.kind=NEW.source_kind AND r.reason=NEW.reason AND NEW.kind='reward' AND NEW.business_key=NEW.operation_id
      AND NEW.actor_id='review-transfer:'||r.actor_id AND p.status='rejected' AND p.error_code='TRANSFERRED_TO_CHILD')
    THEN RAISE(ABORT,'CHILD_CROSS_LEDGER_CONFLICT') END);
END;
