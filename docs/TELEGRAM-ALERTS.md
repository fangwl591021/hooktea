# HookTea operational Telegram alerts

This release adds monitoring only. It does not alter membership authority, point amounts, refunds, webhook ownership or customer messages.

## Configuration and delivery

- `HOOKTEA_TELEGRAM_ALERTS=true` enables alert production and retries. Set false to disable only alerts, not the new-member point router.
- Uses existing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, legacy `TG_BOT_TOKEN` / `TG_CHAT_ID`, or corresponding existing `SYSTEM_SETTINGS` fields. Credentials never enter this module's logs or outbox.
- First occurrence starts a background delivery immediately. D1 `operational_alerts` persists intent; atomic lease prevents concurrent senders. Same category/code/route in a five-minute fixed bucket shares one notification and increments occurrences. Subsequent occurrences are counted in D1, not edited into a previously delivered message.
- Cron every minute retries up to ten due alerts, exponential backoff capped at one hour (Telegram retry_after can extend to 24h), five-second HTTP timeout. HTTP success alone is insufficient: response `ok:true` is required.
- Successful records retained seven days; undelivered records retained for diagnosis. No member/point tables are changed by monitoring.
- Telegram has no idempotency key for sendMessage: timeout after acceptance or loss of the post-send D1 update can produce a duplicate on retry. Alert ID identifies the same notification. Do not promise exactly-once delivery.
- D1 outage fallback sends a fixed storage warning using a separate KV five-minute marker. This fallback is best-effort, not concurrency-safe; if KV/settings/Telegram are also down, only structured logs remain. A failed fallback is retried on later incidents/cron buckets, not a durable per-event queue.

## Coverage

Request exceptions/HTTP 5xx, legacy RPC error responses, tracking admission/completion failure, rejected background promises, caught storage read errors, member enrollment/routing failures, point pending/unavailable/failed results, LINE keyword/reply/forward failures, payment error log entries. Point and enrollment operations retain their original results/exceptions.

Not an external uptime monitor: platform termination before application code runs, browser-only JavaScript errors, mother-site internal failures returning success, and network outages preventing all execution cannot be guaranteed to alert. Existing old incidents are not automatically replayed; they alert when relevant flows encounter them again.

## Privacy and correlation

Only fixed error labels, allowlisted route (no query), server-generated UUID trace/alert IDs, timestamp and counts are sent. No customer UID, name, phone, balance, order details, reply token, raw exception, request body or chat transcript. Customer responses include `X-HookTea-Trace-Id`, matching CRM tracking lease ID and alert logs. Existing order Telegram notifications are unchanged by this feature.

## Admin operations

Authenticated admin RPC `ADMIN_GET_ALERT_STATUS` returns enabled/configured flags, counts and latest sent time, never credentials. `ADMIN_TEST_TELEGRAM_ALERT` queues/sends a fixed test; it is deduplicated within its five-minute bucket. Both retain the existing admin authorization gate (not a public test endpoint).

## Validation and rollout

`tools/check-operational-alerts.mjs`: actual isolated workerd+D1/KV with simulated Telegram/LINE; concurrency, privacy, HTTP-200 rejection, cron recovery, 429 backoff, point observation, authorization, real signed webhook and D1-outage fallback. Existing new-member, registration, webhook, reward, checkout and tracking regressions also run.

Apply migration 0008 before deploying tracked-worker.js with the flag and cron. Roll back this feature by disabling only HOOKTEA_TELEGRAM_ALERTS or restoring the immediately preceding child-ledger Worker, never the older mother-only Worker. Keep the additive alert table for evidence.
