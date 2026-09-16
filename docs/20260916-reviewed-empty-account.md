# Reviewed empty-account recovery

This release does not migrate ordinary old-member balances. It adds an audited
exception for a staff-reviewed empty account with exactly one pending daily
reward rejected by the mother as `user_not_found` and no other database evidence.

Required external review: verified UID, one canonical CRM profile, live zero
balance, no local point document, no point alias, no legacy binding or orders.
The database validates the unchanged pending intent and absence of claims,
snapshots, checkouts and account locks. An immutable review receipt is required.

Atomic D1 batch: review receipt, zero wallet, old intent terminal transfer marker,
and one child-ledger credit with the original business operation ID. The old
intent is retained, not deleted. Receipt fences old inserts, updates and locks.
The runtime recognizes the verified cross-ledger transfer on retry.

Profile update uses R2 conditional writes; KV is a projection. If projection
fails, rerun only the profile projection with the same enrollment receipt.
Never create a second wallet or credit. The existing wallet already selects
child authority even before profile projection completes.

Rollback: before any receipt exists, prior Worker can be restored. After a
transfer, do not restore a Worker lacking reviewed-transfer lookup. Freeze the
affected child wallet if necessary, retain ledger and receipt, and forward-fix.
Never delete receipts/ledgers or switch the account back to mother authority.

Tests: isolated workerd/D1 review transfer, duplicate retry, old-write fencing,
new signin/spend/refund; existing new-member integration and point/payment/
identity regressions. No real LINE messages or purchases are used for tests.
