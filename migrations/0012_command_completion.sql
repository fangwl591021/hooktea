-- Operational evidence only. No wallet/order mutation or historical replay.
ALTER TABLE monitor_feedback ADD COLUMN notification_due_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitor_feedback ADD COLUMN notification_policy TEXT NOT NULL DEFAULT '';
CREATE TABLE monitor_command_executions (
 event_id TEXT PRIMARY KEY, line_uid TEXT NOT NULL, operation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('keyword_reward','daily_signin')),
 expected_points INTEGER NOT NULL CHECK(expected_points>0),
 trace_id TEXT NOT NULL, request_trace TEXT NOT NULL DEFAULT '',
 received_at INTEGER NOT NULL, event_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted','credited','rejected','review')),
 reply_state TEXT NOT NULL DEFAULT 'unknown' CHECK(reply_state IN ('unknown','sent','rejected')),
 result_code TEXT NOT NULL DEFAULT '', review_reason TEXT NOT NULL DEFAULT '',
 updated_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX monitor_command_due ON monitor_command_executions(state,received_at);
CREATE INDEX monitor_command_trace ON monitor_command_executions(trace_id);
