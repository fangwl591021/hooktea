# Monitor CRM login handoff

Scope: static `admin.html` and `line-oa-monitor.html` only. Worker authorization,
roles, session lifetime, member identities, points and database schemas remain unchanged.

CRM's AI monitor link now awaits the existing `CREATE_ADMIN_SESSION` action.
The server still limits issuance to admin/system roles after verifying credentials.
The opaque, 15-minute token stays in same-tab sessionStorage and is sent only to
same-origin APIs in `x-hooktea-admin-session`; no credential is placed in a URL.
The monitor prefers this session over a pre-existing password login. Missing or
expired authorization hides the workspace and offers a return to CRM. It never
prompts for a password or automatically replays an operation after an auth failure.
Opening a fresh tab without a session requires returning to CRM and using its link.

Checks: `node --test tools/check-monitor-auth.mjs` exercises both frontend handoff
and the existing backend issuer/validator, including ordinary-user denial,
expired/fabricated sessions, concurrent failures, cross-origin denial and no write retry.
Identity, webhook and CRM point-read regression suites are also required.

Release: publish the two HTML files to main (the live first-choice static source)
and update only `static/admin.html` and `static/line-oa-monitor.html` in R2 fallback.
No Worker redeployment or D1 migration is necessary. Verify the production page
marker `20260916-monitor-auth-v1`, anonymous API rejection, and actual authorized
CRM-to-monitor navigation without a password prompt.

Rollback: revert only this static change on main and restore the two backed-up
R2 HTML files. Do not roll back the Worker or reviewed point-account migration.
