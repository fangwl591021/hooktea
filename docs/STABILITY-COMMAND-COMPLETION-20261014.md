# Activity completion and delayed owner reminders

Release marker: `20261014-command-completion-v1`. Production publication evidence is recorded separately in workspace outputs; this design document alone does not prove deployment.

## Narrow scope

- Prepare and dispatch webhook work per source instead of awaiting every member before any event can run. Silent events do not need foreground enrichment; reward handlers retain identity and transaction guards. Settings failure returns retryable 503 rather than running on unverified defaults.
- Background diagnostics no longer gate business completion. Business tasks still participate in tracked completion; a missing command result remains review, never presumed successful.
- Persist enabled configured rewards and canonical daily sign-in execution identities before business effects. Keep captured expected points, actual receipt evidence, and LINE reply acceptance separate. Check exact existing receipts only; never retry uncertain point transactions or LINE tokens.
- Only exact rejection evidence or verified credit plus explicit LINE reply rejection can queue a named owner notification. Missing evidence remains local review. Already-claimed events do not represent new credits.
- New customer-question reminders become eligible after ten minutes, preserving the original deadline through late classification. Exclude system commands and handled feedback; confirmed staff delivery can suppress a reminder, but a draft cannot. Thread handling applies to existing feedback, not future questions after a prior closure.
- Native LINE Official Account Manager manual replies are not fully observable here. Owner reminders state this limitation and ask the operator to check and mark handled.
- Monitor UI adds a collapsed command evidence section and does not equate a Telegram send record with delivery, reading, or resolution.

No ordinary-chat AI replies, points compensation, historical claim replay, identity migration, changed bindings/secrets/variables, or changed point authority are included. AI classification `invalid_response` and old review records remain separate unresolved work.

## Validation

15 isolated suites passed, including 28 stability and 29 webhook cases. Eight actual workerd/D1 suites passed (80 groups) with synthetic data and mocked external network. The working runtime reused existing Wrangler 4.120.0 dependencies without installing or upgrading the project. Deployment packaging uses the existing Wrangler 4.102.0 and compatibility date 2026-04-06. No live member/order transactions or test LINE/Telegram messages were used.

## Release order

1. Verify live Worker, remote main and actual checkout against the approved base; record existing D1 Time Travel bookmark and exact old R2 monitor HTML.
2. Apply **only** `0012_command_completion.sql` before the new Worker. It adds operational evidence fields/table/indexes, not business ledger changes. Old feedback defaults retain blank notification policy; do not backfill/replay it.
3. Preflight found `0011_monitor_safety.sql` absent from migration history despite its tables already existing. **Do not rerun 0011 or broadly apply every pending migration.** Use a separate migration directory containing exactly 0012 against the same verified D1 identity, then read back schema and migration history. The legacy history discrepancy is not repaired by this release.
4. Publish source through the existing GitHub main workflow, deploy `hooktea` with `--keep-vars`, then verify binding/variable/secret-name fingerprints, health marker and protected endpoint denial.
5. Publish only `static/line-oa-monitor.html` in the existing R2 bucket and verify live content plus R2 readback. The GitHub-served source and R2 fallback must agree; no unrelated static page is uploaded.

## Recovery boundaries

Prefer a forward fix. Prior Worker version is `322870c5-fd99-483a-be35-651b5b8405fc` on source `fdf754790fbb1a871be0ab9f26f2b28a6bcb03bf`; retain additive schema and evidence when rolling code back. Never restore an entire business database, disable child point authority, clear claims, or replay transactions. Restore only the exact monitor HTML if needed. The prior Worker lacks the new delayed reminder policy, so reverting may resume immediate legacy notifications; do not automatically roll back or infer authorization to change notification switches.

Workers/Wrangler skills guided additive schema-first publication, preservation of live settings, independent static-asset verification, and no uncertain-write replay. References: [D1 migrations](https://developers.cloudflare.com/workers/wrangler/commands/d1/), [Worker deployment](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [R2 objects](https://developers.cloudflare.com/workers/wrangler/commands/r2/).
