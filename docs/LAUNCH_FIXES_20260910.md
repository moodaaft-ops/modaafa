# Launch fixes — 2026-09-10

This extends PR #39; the production branch remains unchanged until final approval.

## Resulting behavior

- All dashboard and campaign date presets query their actual inclusive dates. A failed Google Ads read displays unavailable metrics and a reconnect/retry message instead of mislabeling a saved snapshot. Paused campaigns with spend remain included in account totals.
- Approval and execution reject incomplete or more-than-seven-day-old recommendations. The review UI distinguishes diagnostic findings from executable changes and validates the selected account. Audit CTAs open the exact recommendation for review instead of silently approving it.
- Guidance prioritizes measurement integrity, then expected financial impact, with severity as a tie-breaker. The daily plan and audit use the same ordering.
- Historical reports display their generation date and identify missing data periods. New audit reports preserve the snapshot timestamp and account-timezone date windows without colliding with the weekly report index.
- Operational counts use the same subscription eligibility predicate as scheduled jobs. The owner sees whether jobs are idle, overdue, or processing accounts. An independent hourly health workflow detects stale/missing jobs and eligible accounts without fresh data for 24 hours.
- Measurement states distinguish waiting, unavailable, insufficient and measured data. Guidance waits seven days; observed comparisons no longer claim causality or guaranteed savings.
- The mobile assistant reserves additional space above navigation. Its actual components were checked locally at 390×844, 360×640 and 320×568; the composer clears navigation by about 45px, including the smallest screen after the final min-height adjustment. Public copy accurately explains optional conservative automation.
- Next.js 15.5.24, sharp 0.35.4 and js-yaml 4.3.2 remove the remaining reported security advisories.

## Validation

Node 22 / pnpm 11.9.0: typecheck, lint, 321 unit/integration assertions and production build passed before the final account-freshness regression was added; that focused suite also passed (8 tests). Full audit reports zero advisories including development dependencies. CI and Vercel passed on cd3d077. The final small-screen adjustment is verified again by CI on its successor commit.

The unfinished customer-experience branch is kept separate. Its two invalid `currency` SQL column references were corrected in the existing local file. An isolated PostgreSQL-compatible execution verified repeated migration, insert/update, wrong-currency rejection, ownership, overlapping-import rollback and service-role restrictions. Only its measurement correctness helpers were incorporated here; new outcome/profile/audit-resume features are not part of this release.

## Release order and remaining evidence

1. Confirm final CI and preview browser results.
2. Complete authenticated journeys in isolated Supabase staging with Stripe test mode. Current preview has test payment variables but no Supabase database configuration; a green preview is only a successful build. Supabase rejected a third free project because `modaafa-prod` and `rooh-prod` occupy both free slots. A separate paid staging organization (base $25/month) requires owner approval; do not pause either production project.
3. Back up the production schema/data and apply `20260907_service_usage_reservation.sql` after final owner approval, then merge PR #39 and verify the production deployment.
4. Verify protected health, actual entitled-account processing, live date ranges, desktop/mobile flows and a monitored test payment before paid public launch.

No real advertising mutation, real payment, deletion of a customer, production migration or production release is implied by local checks.
