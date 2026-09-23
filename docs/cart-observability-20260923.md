# Cart observations v2

Authorized scope: identify and explain shop operation observations, publish Worker and admin. No point, order, registration authority, LINE replies, Telegram policy or schema changes.

## Behavior

- Retain bounded LINE profile/name and member ID as **client observations**, never authenticated evidence. v2 logging does not enrich a claimed UID with private CRM data or authorize any transaction.
- Tab/session, page, attempt and sequence identify related observations. Account changes detected during LINE initialization rotate the session. Admin can search/open the same session's saved records.
- Preserve cart snapshot, intended amounts, stage, fixed error code, HTTP status when received, elapsed time, and browser offline indication. No shipping/contact form fields, access tokens, OAuth query or hash in cart logs.
- Automatic member read failures are not mislabeled checkout attempts. Recovery is separately recorded. Panel closing, unknown page leave, LINE login redirect, payment redirect, status-confirmed payment/cancel and explicit successful cancel are distinct.
- Diagnostic I/O never blocks order submission. Failure to record is not proof of business failure. Page leave cannot reliably distinguish tab closure, back navigation, suspension, or user intent.
- Historical missing identity/cart data remains unknown, not fabricated or presented as zero-value shopping. Existing bounded KV activity storage is retained; not a durable financial audit or guaranteed complete clickstream. Missing subsequent events do not prove abandonment.

## Verification and release

- 80 Node tests across checkout, cart observability, cart empty states, operations dashboard and order/point regressions.
- Eight additional isolated suites: child points, registration workerd, legacy transfer, alerts, monitoring, monitor authorization, mixed LINE webhook routing, owner feedback/signin.
- Wrangler dry-run passes. No migrations, real customer requests, point adjustments or test Telegram notifications.
- Pre-release Worker: c3a56b12-b198-491b-a3c2-e60e5dcc5f7f; source a9c16305a61aa1215fb555d0dc1d1fa6620273a4.
- Publish admin.html to main and R2 fallback static/admin.html. Retain pre-release admin R2 backup in outputs. Verify served admin SHA-256 and actual storefront marker after publishing.
- Rollback requires previous Worker plus admin source/R2 restoration (new revert commit, no force push). Do not reset any business data or authority flags.

Workers/Wrangler skills guided isolation, preserved bindings and deployment verification.
