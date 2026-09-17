# Checkout discount guard release

Scope: prevent the storefront maximum-discount action from overwriting an existing selection while identity/points are unavailable. Record bounded, privacy-minimized client-side preflight observations. No ledger, payment, identity mapping, migration, backend authorization or LINE response changes.

## Checks

- 37 rendered-storefront tests passed, including six added regression cases.
- 24 order/points regression tests passed.
- 12 monitor safety groups and 16 child-member/points workerd groups passed with isolated storage and mocked network.
- Syntax and git diff whitespace checks passed.
- Wrangler deployment dry run passed using the existing production bindings and preserved variables.

## Behavior

The maximum-discount button starts disabled. It is enabled only after points are confirmed; attempts while unavailable preserve the existing discount. An unavailable balance never authorizes an order using points.

Client observations distinguish identity syncing/unverified, unavailable points, and member-load timeout/failure. The same reason is suppressed for 30 seconds per page. These records omit member identifiers, personal contact information, cart contents, raw errors and URL query parameters. They are diagnostic observations, not authoritative transaction failures. They use the existing bounded cart-activity store; they are not a durable financial audit or new Telegram alert pipeline.

## Release / rollback

Pre-release production version: cb141f80-447d-471a-ae24-27b531094646; source 7190e79e1561d3ce4943eac86f7fb61a71c8935d. No schema or data migration. Roll back only the Worker version if needed; do not reset storage or point-authority flags.

Post-release acceptance: check deployed storefront contains the default-disabled button and guard, execute its real rendered script under mocked I/O, and confirm public health and keyword-only/passive monitoring flags. Do not create a real order or adjust a real balance for this acceptance.

Still separate: old cancelled-order refund reconciliation, remaining legacy balance dependencies and decoupling the seven-second member request from noncritical reads.

Wrangler skill was used for release verification and rollback preparation. [Official Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).
