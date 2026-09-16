-- Tracking-only release. No point/account tables or balance changes.
-- No automatic timeout: a lost request remains unresolved until inspected.
CREATE TABLE crm_request_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  mode TEXT NOT NULL CHECK(mode IN ('observe','paused')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO crm_request_control(singleton,mode,actor_id,reason)
VALUES(1,'observe','deployment','tracking_only_no_cutover');
CREATE TABLE crm_request_control_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  previous_mode TEXT NOT NULL,
  next_mode TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER crm_request_control_change BEFORE UPDATE ON crm_request_control BEGIN
  SELECT (CASE WHEN NEW.singleton<>OLD.singleton OR length(trim(NEW.actor_id))=0
    OR length(trim(NEW.reason))=0 THEN RAISE(ABORT,'CRM_PAUSE_AUDIT_REQUIRED') END);
END;
CREATE TRIGGER crm_request_control_audit AFTER UPDATE OF mode ON crm_request_control
WHEN NEW.mode<>OLD.mode BEGIN
  INSERT INTO crm_request_control_events(previous_mode,next_mode,actor_id,reason)
    VALUES(OLD.mode,NEW.mode,NEW.actor_id,NEW.reason);
END;
CREATE TRIGGER crm_request_control_no_delete BEFORE DELETE ON crm_request_control
BEGIN SELECT RAISE(ABORT,'CRM_REQUEST_CONTROL_IMMUTABLE'); END;
CREATE TABLE crm_request_leases (
  lease_id TEXT PRIMARY KEY NOT NULL,
  release TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','done','uncertain')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX crm_request_leases_state ON crm_request_leases(state);
CREATE TRIGGER crm_request_admit BEFORE INSERT ON crm_request_leases BEGIN
  SELECT (CASE WHEN NEW.state<>'active' OR NEW.finished_at IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM crm_request_control WHERE singleton=1 AND mode='observe')
    THEN RAISE(ABORT,'CRM_REQUESTS_PAUSED') END);
END;
CREATE TRIGGER crm_request_finish BEFORE UPDATE ON crm_request_leases BEGIN
  SELECT (CASE WHEN OLD.state<>'active' OR NEW.state NOT IN ('done','uncertain')
    OR NEW.lease_id<>OLD.lease_id OR NEW.release<>OLD.release
    OR NEW.started_at<>OLD.started_at OR NEW.finished_at IS NULL
    THEN RAISE(ABORT,'CRM_REQUEST_TRANSITION_INVALID') END);
END;
CREATE TRIGGER crm_request_no_delete BEFORE DELETE ON crm_request_leases
BEGIN SELECT RAISE(ABORT,'CRM_REQUEST_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER crm_request_events_no_update BEFORE UPDATE ON crm_request_control_events
BEGIN SELECT RAISE(ABORT,'CRM_REQUEST_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER crm_request_events_no_delete BEFORE DELETE ON crm_request_control_events
BEGIN SELECT RAISE(ABORT,'CRM_REQUEST_AUDIT_IMMUTABLE'); END;
