# Child member area entry — 2026-09-16

Scope: exact LINE text `會員專區` is child-owned before configurable rewards/templates and mother forwarding. Reply is a Flex card containing `會員註冊` (`open=register`) and `開啟會員專區` (`open=member`) on the configured child shop LIFF. It does not pass a UID or perform identity matching, account creation, or point writes when replying. Login and profile saving reuse the deployed verified child CRM flow.

The child member panel has a registration button for pending members and `查看註冊資料` for registered members. Existing data opens without starting registration again. Online checkout still requires registration; point eligibility is unchanged.

Other mother aliases (including `會員中心`) and routes remain unchanged. Point balances/history have NOT been migrated or activated locally. No database migration, point mutation, CRM batch update, mother setting change, or LINE channel removal is included.

## Verification

- 72 Node test-runner tests passed, including 26 webhook routing cases inside its webhook script.
- 9 isolated workerd/D1 write-tracking groups and 3 isolated workerd registration groups passed.
- Chrome isolated test: `open=member` showed pending registration button; clicking opened existing child registration form; submitting synthetic name/phone changed the same member to registered; reload retained profile; `查看註冊資料` displayed the saved values.
- Mixed batches keep follow/mother events, and member-area events are not forwarded even if a child reply fails. Overlapping configured rewards/templates cannot intercept the entry.
- Wrangler deployment dry run passed. Production smoke verification recorded separately after deployment.
- No live LINE message was sent to a real member during testing; device-level card delivery still requires a real keyword message.

## Release / rollback

Base commit: `a1df058fb564410f0fc05f0bb94477273376ecb4`.
Health release: `20260916-child-member-area-v1`; existing write-tracker release remains separately exposed.
Previous production version: `a31c90e2-aeb2-42a0-983d-ef3baa721958`.
Rollback can restore that Worker version without changing storage/schema; this release introduces no new persisted data shape. Preserve current variables with `wrangler deploy --keep-vars`.
