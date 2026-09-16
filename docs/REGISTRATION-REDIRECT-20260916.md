# Registration LIFF redirect correction

## Reproduced failure

The actual card URL `https://liff.line.me/2007674851-ijenzSk8?open=register` landed on `/?open=register`, without opening the registration panel. Browser SDK warning confirmed the location was outside the configured `/huaxu-shop.html` endpoint.

`restoreEntryContext()` ran before `liff.init()`, resolved query-only `liff.state` against `location.origin`, then used `history.replaceState()` to discard the endpoint pathname and SDK redirect parameters. Prior browser acceptance used the direct shop URL rather than this actual LIFF entry, so it missed the failure. A second regression ignored the saved registration intent on OAuth callback because it only checked the current outer `open` parameter.

## Fix and scope

- Preserve the primary URL/path/state for the LIFF SDK; no manual rewrite or extra decode.
- Refresh entry context after SDK initialization and restore an explicit registration/member action on a verified OAuth return.
- Only open member/registration UI after server identity verification succeeds.
- Plain shop visits do not replay a stale saved registration action.
- No change to point authority, rewards, CRM identities, payment rules, or LINE console configuration.

## Verification

Both new root-cause regression tests failed before the change and passed afterward. Added pending-registration, stale-entry and failed-identity cases. All 77 Node test-runner tests pass, including 26 webhook cases within its script; 3 workerd registration groups and 9 write-tracking groups pass. Dry-run succeeds. Post-deployment actual LIFF browser verification is recorded in the workspace deployment report.

Source: https://developers.line.biz/en/reference/liff/#initializing-liff-app-notes-3 requires preserving SDK URL parameters until initialization resolves. https://developers.line.biz/en/docs/liff/opening-liff-app/ describes the primary and secondary redirects.

Base commit: e4c340fd0e31bf976e5a82057972fbfb04507684. Rollback Worker: b317742e-5595-4878-ae21-3ccb9766281b (restores the known registration-entry defect; no data/schema rollback needed). Release marker: 20260916-registration-redirect-v2.
