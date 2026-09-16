# Registration-first entry

The previous redirect correction opened the profile correctly, but still rendered the catalog first and awaited catalog/config, diagnostics and the full member projection (including mother points/orders). Registration is now a dedicated presentation mode on the existing LIFF endpoint; no LINE settings/identity authority change.

- Both direct `open=register` and primary `liff.state=?open=register` responses render a registration title and loading shell in HTML before the SDK script, with shop/nav hidden. This does not rewrite any SDK URL parameter.
- Registration startup goes directly to LIFF and server identity verification. It skips catalog/config fetches, full points/orders and payment-return verification; diagnostic promises no longer block identity.
- Authenticated `profileOnly:true` on the existing member POST returns the same allowlisted CRM fields, with the same authorization/provisioning. It deliberately omits balances/orders rather than fabricating zero values.
- Registration only renders the existing profile form/detail. Return to shop navigates to a clean shop URL for full initialization. Cart rendering is skipped while catalog/balance are absent, preserving saved discount/cart. No point/reward mutation or data migration.
- SDK/login failure retains the registration surface with retry and return controls.

Verification: 80 Node tests (including 26 webhook subcases), isolated browser pending registration save, clean return to shop, and dedicated first-paint markup for primary/secondary URLs. Deliberately unresolved diagnostics and forbidden catalog requests do not prevent the form. Profile projection tests throw if points/orders are touched and reject a spoofed UID. workerd projection, registration and request tracking tests run before release.

Base commit 9c5c9ca. Rollback Worker 675182ab-2384-4f60-a0dc-98e48689ee32 retains identity/points but restores the catalog flash/wait. No schema change. Release marker 20260916-registration-first-v3. No numeric mobile speed claim; actual LINE authorization latency still varies.
