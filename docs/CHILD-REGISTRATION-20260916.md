# Child registration release — 2026-09-16

## Contract

- Verified LINE login creates/reuses a child CRM profile. Login alone is not registration.
- New profiles have `registrationStatus: pending`; existing complete name/mobile profiles remain registered without bulk rewrites.
- Exact `會員註冊` is owned by the child before any mother/configurable campaign owner. It replies with the configured shop LIFF `?open=register` entry.
- Complete registration by saving name and a valid Taiwan mobile number through authenticated `PUT /api/huaxu/member`. Other profile fields remain optional.
- The server derives UID/member ID, preserves existing private CRM fields, and never matches by display name or submitted phone.
- Pending registration does not block points, check-in, or order lookup. Only creating a new shop order requires registration, including zero-point orders.
- Registration/login do not grant registration rewards or migrate balances/history. Existing point-authority and pending-point checks still apply.
- No changes to LINE credentials, Provider, mother reward settings, staged migration, course retirement, or payment setup.

## Storage and release boundaries

R2 `live/high-risk/users/{memberUid}.json` remains the authoritative CRM profile. Creation/profile save uses conditional put and retries contention; storage read failures cannot silently become new empty profiles. Concurrent login cannot replace a completed registration.

`live/child-crm/{memberUid}.json` is an additive enumeration marker containing only the member ID. CRM listing overlays fresh R2 records for these IDs so concurrent cached USERS_INDEX rewrites cannot omit a new member. Repeated login repairs partial projection failure. No existing point or history document is rewritten by these registration writes.

The shop no longer starts background binding repair or point merging merely because a member profile was opened. Exact existing LINE bindings are reused; unresolved identity conflicts still need review.

## Verification

- Node tests: authentication, trusted old UID reuse, conflicting IDs, pending/registered state, invalid data, concurrent create/complete, KV-only recovery, stale CRM index, no point awards, checkout/payment/cancellation regressions.
- Mixed webhook tests: registration is handled once locally, other mother events continue; reply error never forwards an already-owned event.
- Actual workerd + local R2/KV/D1: verified login, conditional writes, checkout rejection before order/payment effects, no point awards. All external identity calls are synthetic.
- Browser, isolated localhost: pending form opened from registration deep link; points/check-in controls visible; cart blocked before registration; completed same CRM; preserved cart/recipient; created one local COD test order. No live order or payment used.

Test commands:

```powershell
node --test tools/check-child-registration.mjs tools/check-hooktea-identity.mjs tools/check-hooktea-checkout.mjs tools/check-hooktea-regressions.mjs tools/check-crm-history-export.mjs tools/check-crm-point-read.mjs tools/check-retired-features.mjs tools/check-reward-audit.mjs
node tools/check-hooktea-webhook.mjs
# Set WRANGLER_PACKAGE to an installed wrangler/package.json if dependencies are not local.
node tools/check-registration-workerd.mjs
```

## Rollback

Before-release commit: `b4cae1c39a65c36f045caa0c0e1bc2bbaad79e07`.
Before-release Worker version: `9faf658e-53fe-4507-938d-9091574036e5`.

Rollback the Worker to that version and revert the matching admin static change in GitHub main together. Retain new CRM profiles, registration fields and enumeration markers; do not delete users or financial data. Before rolling back after real new registrations, reconcile marker IDs into USERS_INDEX to preserve old-version CRM discovery. Rollback removes the new checkout registration requirement and returns the keyword owner to the mother, so coordinate that operational change explicitly.

No D1 migration or point maintenance window is required for this release. Full child point migration/cutover is separate and remains unfinished.
