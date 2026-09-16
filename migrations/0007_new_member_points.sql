-- New verified CRM profiles only. No legacy balances are imported or cleared.
CREATE TABLE child_point_wallets (
  member_id TEXT PRIMARY KEY NOT NULL,
  line_uid TEXT NOT NULL UNIQUE CHECK(member_id=line_uid),
  enrollment_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','frozen')),
  balance INTEGER NOT NULL DEFAULT 0 CHECK(typeof(balance)='integer' AND balance BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER child_wallet_new_guard BEFORE INSERT ON child_point_wallets BEGIN
  SELECT CASE WHEN NEW.balance<>0 OR
    EXISTS(SELECT 1 FROM point_operations WHERE line_user_id=NEW.line_uid OR member_uid=NEW.member_id) OR
    EXISTS(SELECT 1 FROM point_legacy_snapshots WHERE line_user_id=NEW.line_uid OR point_uid=NEW.member_id) OR
    EXISTS(SELECT 1 FROM point_sync_locks WHERE line_user_id=NEW.line_uid) OR
    EXISTS(SELECT 1 FROM daily_signin_claims WHERE line_user_id=NEW.line_uid OR member_uid=NEW.member_id) OR
    EXISTS(SELECT 1 FROM reward_claims WHERE line_user_id=NEW.line_uid OR member_uid=NEW.member_id) OR
    EXISTS(SELECT 1 FROM checkout_requests WHERE line_user_id=NEW.line_uid)
    THEN RAISE(ABORT,'CHILD_EXISTING_ACCOUNT_REVIEW') END;
END;
CREATE TRIGGER child_wallet_identity_guard BEFORE UPDATE ON child_point_wallets
WHEN NEW.member_id<>OLD.member_id OR NEW.line_uid<>OLD.line_uid OR NEW.enrollment_id<>OLD.enrollment_id
BEGIN SELECT RAISE(ABORT,'CHILD_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER child_wallet_no_delete BEFORE DELETE ON child_point_wallets
BEGIN SELECT RAISE(ABORT,'CHILD_WALLET_IMMUTABLE'); END;
CREATE TABLE child_point_ledger (
  operation_id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL REFERENCES child_point_wallets(member_id),
  kind TEXT NOT NULL CHECK(kind IN ('reward','spend','refund','adjustment')),
  source_kind TEXT NOT NULL,
  business_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount<>0 AND amount BETWEEN -9007199254740991 AND 9007199254740991),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  balance_after INTEGER NOT NULL CHECK(typeof(balance_after)='integer' AND balance_after BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(member_id,kind,business_key),
  CHECK((kind='spend' AND amount<0) OR (kind IN ('reward','refund') AND amount>0) OR kind='adjustment')
);
CREATE INDEX child_point_member_history ON child_point_ledger(member_id,created_at);
CREATE TRIGGER child_point_validate BEFORE INSERT ON child_point_ledger BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM child_point_wallets WHERE member_id=NEW.member_id AND status='active')
    THEN RAISE(ABORT,'CHILD_WALLET_UNAVAILABLE') END;
  SELECT CASE WHEN NEW.balance_after<>(SELECT balance+NEW.amount FROM child_point_wallets WHERE member_id=NEW.member_id)
    THEN RAISE(ABORT,'CHILD_BALANCE_CONFLICT') END;
  SELECT CASE WHEN NEW.kind='refund' AND NOT EXISTS(SELECT 1 FROM child_point_ledger
    WHERE member_id=NEW.member_id AND kind='spend' AND business_key=NEW.business_key AND amount=-NEW.amount)
    THEN RAISE(ABORT,'CHILD_REFUND_INVALID') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM point_operations WHERE operation_id=NEW.operation_id)
    THEN RAISE(ABORT,'CHILD_CROSS_LEDGER_CONFLICT') END;
END;
CREATE TRIGGER child_point_apply AFTER INSERT ON child_point_ledger BEGIN
  UPDATE child_point_wallets SET balance=NEW.balance_after WHERE member_id=NEW.member_id;
END;
CREATE TRIGGER child_point_no_update BEFORE UPDATE ON child_point_ledger
BEGIN SELECT RAISE(ABORT,'CHILD_LEDGER_IMMUTABLE'); END;
CREATE TRIGGER child_point_no_delete BEFORE DELETE ON child_point_ledger
BEGIN SELECT RAISE(ABORT,'CHILD_LEDGER_IMMUTABLE'); END;
-- Defense in depth: older journal paths cannot post a child member to the mother.
CREATE TRIGGER mother_operation_child_guard BEFORE INSERT ON point_operations
WHEN EXISTS(SELECT 1 FROM child_point_wallets WHERE line_uid=NEW.line_user_id OR member_id=NEW.member_uid)
BEGIN SELECT RAISE(ABORT,'CHILD_AUTHORITY_REQUIRED'); END;
