# Passive monitoring release — 2026-09-17

## Scope

- LINE customer traffic stays keyword-only. AI classifies feedback internally; it cannot send LINE replies. Unknown messages are not forwarded to the mother-site free-text AI path.
- Signed text events are persisted before business effects. Rule-based complaints create a durable, PII-free Telegram outbox entry. AI classification is asynchronous, bounded and retried; original evidence remains admin-only even if AI fails.
- A protected self-test uses the existing production AI credential, fixed non-customer input, bounded output, an 8-second timeout and a 10-minute manual cooldown. Daily healthy testing is due at 08:00 Asia/Taipei; failed checks retry after 15 minutes. Only state changes notify.
- Admin monitor shows complaints, original evidence, review status, analysis failures, system alerts and request-tracking status. Coverage starts at deployment; no historical completeness is claimed.
- Request metadata records sanitized operation, phase and trace. The nine investigated legacy leases remain unresolved; missing finish evidence is not proof of a failed customer transaction. They are acknowledged as known, not erased, replayed or marked successful.
- Explicit product point cap zero survives normalization/import/order snapshots. Existing checkout validation still rejects an over-cap request; no stored prices or balances are rewritten.

## Isolated verification

Passed: monitor safety (12 groups), new-member points (16 groups), webhook routing (26), checkout (31), general regressions (24), write tracking (9), monitor authorization, operational alerts (8), child registration (9), registration workerd (4), legacy transfer (11), reward audit and CRM registration sorting. All network/business writes in these suites are mocked or local. Final Wrangler dry-run and git diff check passed.

## Release gates

Apply only additive migration `0011_monitor_safety.sql`, then deploy the Worker with existing secrets/variables retained. Publish the matching monitor HTML to GitHub main and the existing R2 static fallback. Verify protected endpoints reject anonymous access, live AI self-test result, authenticated UI, nine known leases, and point-ledger aggregate before/after. No real customer messages, point adjustments, purchases or refunds are test fixtures.

## Rollback

Pre-release Worker version: `39d0f221-b51b-411a-9658-b471c100f2ad`; source: `4c575b6f5a005beb2dba7812698c433e5d092cd2`.

Prefer a forward fix. If required, roll back the Worker to that version and restore the old monitor HTML in both serving locations. Keep the new D1 tables and evidence; do not restore the entire database or delete queues, reviews or customer data. Do not disable new-member child-wallet authority as a rollback. Old code does not provide this release's independent keyword-only guard, so revalidate routing before rollback. A monitor-only rollback should retain the keyword guard and use an explicit incident plan.

## Limits

AI classification is not proof that a customer's allegation is a confirmed ledger defect. Rule detection is fast; AI-only detection can be delayed by queue depth, provider failure and bounded throughput. Retry exhaustion is shown for manual review. Basic text redaction is data minimization, not complete anonymization. LINE Official Account Manager's native auto-replies are outside this Worker and are not changed by this release. Existing per-account legacy point authority remains; this is not a full ledger migration.

Workers/Wrangler safety guidance informed durable storage, isolated tests, additive schema rollout and rollback gates. Official OpenAI Responses guidance informed bounded non-persistent test/classification requests.
