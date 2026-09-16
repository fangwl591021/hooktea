# New-member child points release

Scope: profiles first created by this release after verified LINE login/webhook.
Existing profiles, bindings, local point records, prior claims and pending operations
are not silently promoted. No legacy balances or histories are copied by migration 0007.

## Authority and transaction boundary

- Conditional R2 profile creation creates a server-only enrollment receipt.
- D1 creates one zero wallet for the same verified UID; legacy-journal/claim guards
  reject uncertain existing accounts. No mother query is used to establish newness.
- Interrupted enrollment repairs the same receipt; errors never fall back to mother.
- Wallet balance and immutable entry update together through a SQL trigger.
- Deterministic operation/business keys prevent duplicate credits, spends and refunds.
- Full refunds require the matching original child spend. No free-standing refund.
- New-account follow/message events are not forwarded to mother. Legacy check-in
  aliases on a child account use the child's normal daily claim. Ordinary text is silent.
- CRM reads/adjustments, member views, shop deductions/refunds, monitor signals and
  paginated history exports use child D1 for child accounts.
- Registration is required for checkout, not for point earning/use outside checkout.

## Deployment

1. Verify main/deployed source and record an existing D1 Time Travel bookmark.
   Full customer-data export requires separate approval and is not part of this release.
   Retain the prior Git commit for the served admin asset.
2. Apply only 0007; it adds tables/triggers and imports no member/point rows.
3. Deploy with `--keep-vars`, preserving live LINE/payment settings. Keep
   `HOOKTEA_NEW_MEMBER_CHILD_POINTS=true`.
4. Publish matching admin.html to GitHub source and R2 fallback; verify live markers.
5. Check health, unauthorized paths, schema and unchanged legacy pending counts.
6. A real newly joining LINE account still requires post-release observation; synthetic
   workerd/browser tests must not be reported as a real customer's acceptance.

## Recovery / rollback constraints

Before any child wallet exists, the old Worker can be restored; leave additive schema.
After a child wallet exists, NEVER blindly roll back to an old mother-only Worker or
disable HOOKTEA_NEW_MEMBER_CHILD_POINTS: it cannot serve child balances correctly.
Keep the authority router and D1 ledger. Roll forward a fix; temporarily set
HOOKTEA_NEW_MEMBER_ENROLLMENT_PAUSED=true to stop only new openings if needed.
Existing child wallet reads/transactions remain routed to D1 with enrollment paused.
For a transaction incident, use the existing audited request fence and inspect in-flight
leases before maintenance; do not restore an old DB backup over later ledger entries.
Do not delete wallets, alter immutable entries or blindly retry mother pending rewards.

## Verification

`tools/check-new-member-points.mjs`: actual local workerd, R2, KV, D1; synthetic
identity and intercepted network. Covers login, webhook follow/mixed events, rewards,
concurrency, double claims, overspend, refunds, registration, actual checkout/cancel,
CRM admin permissions/idempotency, full-history pages, legacy pending isolation,
interrupted opening recovery, malformed profile rejection, cross-ledger write guard.

Browser: `tools/check-registration-workerd.mjs --browser --child` (loopback only).
No mock identity route or LINE SDK is included in the production bundle.
