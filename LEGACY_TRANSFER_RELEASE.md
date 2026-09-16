# Reviewed legacy account cutover

This release adds an explicit **single-account** operator workflow, not a bulk
transfer or a mother-system shutdown. Schema installation transfers nobody.

## Preconditions and release

1. Run `node tools/check-legacy-transfer.mjs` with the installed Wrangler package
   exposed as `WRANGLER_PACKAGE`; run identity, points, checkout, webhook,
   registration, CRM history, reviewed-account, monitor and alert regressions.
2. Verify the production Worker, database and main revision. Record a D1 Time
   Travel bookmark; list pending migrations and apply only migration 0010.
3. Deploy with `--keep-vars`. Keep both child-point feature flags enabled.
4. Sign in at `/admin.html?pointTransfer=1`. Supply an explicitly reviewed CRM ID.
   Prepare rechecks the trusted identity, authoritative source balance, all
   source history pages/counts, pending rewards, orders and point-operation locks.
5. Preparation fences only that account's child-origin mother transactions and
   webhook forwarding. It does not disable independently operated WordPress
   writers. Confirm the operational cutover boundary; do not claim a global
   mother write fence from this local receipt or request-tracker state.
6. Activate within five minutes. Every source page is read again. An immutable
   receipt, zero wallet and one opening adjustment commit in one D1 batch.
   History is archival and is never credited a second time. Historical child
   caches are preserved with the full private R2 source snapshot, not summed.
7. Verify the production CRM's current balance/history and D1 receipt/wallet.
   Actual checkout/refund tests use synthetic isolated accounts; never place an
   unsolicited order or adjust a real customer's points just for acceptance.

## Failure and recovery

- Before activation, use Cancel to release the account fence. Unknown balances,
  incomplete history, unresolved old orders and pending claims must be reviewed;
  there is no force/zero-balance override.
- A failed D1 batch rolls back receipt, wallet and opening credit together.
- If profile projection fails after the batch committed, retry activation with
  the same receipt or prepare again. The committed D1 wallet remains authoritative
  and the profile projection is repaired without repeating the opening credit.
- After activation, **do not roll back to a pre-transfer Worker, disable the
  feature flags, delete the receipt, restore the whole database, or resume mother
  point writes**. Freeze the affected wallet if necessary and deploy a compatible
  forward fix. Returning to mother requires a separate audited migration of all
  subsequent child transactions, not a Worker version rollback.
- No other old member is moved automatically. The existing new-member enrollment
  guards and reviewed-empty-account workflow remain intact.

## Evidence boundaries

The new workerd test covers admin authorization, source ambiguity, pending claims,
unresolved orders, database fencing, source change, atomic failure, replay,
CRM/member reads, full-history pagination, old refund deduplication, daily reward,
manual adjustments, checkout/cancel, and zero mother calls after cutover.
Historical request-tracker entries are not silently cleared or treated as proof
of mother transaction completion.
