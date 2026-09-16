# Reviewed legacy CRM identity linking

This release supports an owner-confirmed legacy profile linked to an existing
LINE UID conversation. It does not enroll existing members into child wallets,
credit historical cached balances, or alter order/refund state.

## Guarded behavior

- An explicit `admin_verified_chat` binding may retain `monitorThreadId` only
  when that value is exactly the authenticated LINE UID. Background binding
  repair preserves this field, so subsequent messages use the same thread.
- A recoverably archived duplicate is suppressed from monitor member listings
  only when both profiles share the review receipt and the surviving profile is
  trusted for that duplicate's LINE UID.
- Reviewed monitor detail reads the authoritative balance in read-only mode and
  includes both legacy-member and LINE-UID-owned orders. Explicit foreign LINE
  ownership still takes precedence. Unavailable balances display as unknown.

## Operator procedure

1. Obtain explicit owner confirmation plus historical identity evidence, not a
   nickname-only match. Re-read both profiles, balances, pending operations,
   locks, wallets, relevant orders and original conversation.
2. Back up exact R2/KV before-images and thread linkage privately. Do not commit
   customer data, private backup files or per-customer operator scripts.
3. Deploy this compatible Worker before linking data.
4. Conditional-write the surviving legacy profile, preserve UID-keyed points
   resolution, record the reviewed binding, and update the existing thread's
   legacy ID. Archive the duplicate reversibly; do not delete its data.
5. Compare point-document hashes, original messages and relevant orders before
   and after. Verify CRM and monitor with authenticated read-only requests.

## Validation

`tools/check-reviewed-legacy-binding.mjs` exercises canonical lookup, stable
thread routing, archive guards, background repair, authoritative read-only
balance, order ownership and unavailable-balance handling using synthetic data.
Also run identity, points/payment, webhook, monitor-auth, reviewed-empty-account
and new-member points regression suites, syntax checks and Wrangler dry-run.

## Recovery

The Worker change is backward compatible before a reviewed binding is applied.
After data repair, do not blindly roll back the Worker: the old Worker would
route future messages to a different thread. Prefer a forward fix; any data
rollback must compare current values with the review receipt and restore only
this repair's fields from private before-images without overwriting intervening
customer activity. Point balances, histories and orders are not rollback targets
because this operation does not modify them.
