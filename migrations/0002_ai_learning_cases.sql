PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ai_learning_cases (
  id TEXT PRIMARY KEY,
  source_thread_id TEXT NOT NULL DEFAULT '',
  source_message_id TEXT NOT NULL DEFAULT '',
  customer_text TEXT NOT NULL DEFAULT '',
  staff_reply TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  lesson TEXT NOT NULL DEFAULT '',
  confidence INTEGER NOT NULL DEFAULT 60
    CHECK (confidence >= 0 AND confidence <= 100),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'rejected')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_learning_cases_thread
  ON ai_learning_cases(source_thread_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_learning_cases_status
  ON ai_learning_cases(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_learning_cases_category
  ON ai_learning_cases(category);
