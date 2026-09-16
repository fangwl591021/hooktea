# Pre-cutover request tracking release

Scope: first independent preparation release on top of the deployed child-registration version. The existing `worker.js`, point service, CRM HTML and all business routes are unchanged. Wrangler now starts `tracked-worker.js`, which delegates to the original Worker with a tracked `waitUntil` context.

## Deployment and invariant

1. Back up production D1 and record the currently serving Worker version.
2. Check the pending migration list. Apply only `0006_crm_write_tracking.sql`.
3. Verify the new control row is `observe`, no requests or pause events exist, and existing point journal rows are unchanged.
4. Deploy with the existing variables preserved. The health release is `20260916-write-tracking-v1`.
5. Probe non-mutating public routes and anonymous authorization; verify requests finish in D1 and mode remains `observe`.

The migration creates three tracking/audit tables and their guards, not wallets. It cannot represent `child` authority. There is no public pause, activation, migration, lease-clear or point-import endpoint. Deploying this release does not pause requests, change any balance, turn off mother routing, or change registration/checkout requirements.

## What is tracked

Every HTTP request except OPTIONS and GET health gets an atomic D1 admission record. GET payment callbacks are included. Paused mode refuses admission with HTTP 503 before business handlers. Parent and nested registered background promises must settle before the record is finished. A rejected background job or server error is recorded as uncertain. A terminated request or failed final D1 update remains active; successful business responses are not replaced by bookkeeping errors. No customer identity, URL query, message body or authentication token is recorded in leases.

## Limits: not a cutover certificate

- A `done` record means the tracked handler and its registered promises settled, not that all business effects succeeded. Existing handlers may catch failures internally; point journals, order state and mother-side reconciliation are still required.
- Older deployed versions did not use these records. Newly empty tracking tables never prove previous-version work drained. Deployment transition and retries must be assessed separately.
- No mother's internal timers, events, APIs or other clients are fenced by this local control.
- Existing staged `crm-maintenance.js` still uses different tables. It MUST be bridged to this deployed gate before it can be used to claim production child-side maintenance. Do not simply change its staged control row and assume this gate paused.
- Before any real pause, validate webhook and payment retry contracts, prepare authenticated recovery/operator procedures and retain pending/uncertain operations. This release does not authorize enabling pause.
- Uncertain/active leases do not expire or get auto-cleared. Completed records are retained; capacity and an audited archival/retention design are required before prolonged high-volume operation.

## Rollback

Only while mode remains `observe`, no cutover has begun, and no child wallet exists: roll the Worker back to the preceding registration version `687d8667-9be2-4f34-82b4-c002475c9fa1` (source `96e21d2`). Leave the additive D1 tracking schema/data in place. No R2 or CRM changes are needed. Do not restore the entire D1 backup over live transactions. Record the tracking coverage gap introduced by rollback. After pause or cutover, first reconcile instead of blindly rolling back.

## Verification

- 9 actual workerd/local-D1 tracking groups, including nested background jobs, concurrent requests, no bypass on DB failure, paused callback rejection, and preserved success after bookkeeping failure.
- 3 actual workerd/R2/KV/D1 registration groups through the new entrypoint, with synthetic LINE and no production bindings.
- 72 Node top-level regression tests including the 24-case webhook suite pass.
- Dry-run build passes. Latest Workers types used: 5.20260916.1. Existing compatibility date and binding targets are deliberately preserved.

Current platform references: [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
