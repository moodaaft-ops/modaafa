# Modaafa Readiness Review - 2026-09-07

## الخلاصة

أُصلحت 13 مجموعة ملاحظات، أهمها صلاحيات الاشتراك، حفظ التجربة المجانية، أمان حذف الحساب، وحدود الطيار الآلي وموافقاته.
نجحت 311 حالة اختبار برمجي و24 حالة اختبار متصفح، مع نجاح فحص GitHub وبناء نسخة المعاينة.
الإصلاحات موجودة في طلب الدمج 39 ولم تُنشر إلى الإنتاج.
المتبقي قبل النشر: تطبيق الهجرة والتحقق منها، اختبار دورة Stripe على بيئة معزولة، والتحقق من المسارات المصادقة على النسخة الجديدة.
فحص الإنتاج عاد سليماً بعد تأخر إحدى المهام المجدولة، لكن ذلك لا يثبت انتظامها ولا جاهزية المنتج بلا شروط.

## Decision

The candidate is ready for controlled pre-release verification, not an unconditional public-launch sign-off. Local checks and the preview build pass. The production migration and isolated billing lifecycle verification remain release gates. No real payment, ad mutation, account deletion, production migration, or global autopilot enablement was performed in this review.

Base: `43b7ccf`. Candidate branch: `codex/readiness-hardening-20260907`.
PR: https://github.com/moodaaft-ops/modaafa/pull/39 (draft).
Code candidate: `154f772`.

## Findings Fixed

| ID | Finding | Change and verification |
| --- | --- | --- |
| R1 | Stripe `unpaid` and initial `incomplete` were stored as `past_due`, giving paid access until a future period end | Shared status normalization stores these as `paused`; expired initial checkout is terminal. Webhook and checkout completion use the same mapping. Tests preserve genuine past-due grace and reject unpaid access |
| R2 | Durable trial-ledger failures were swallowed; a webhook retry could skip the lost grant after the subscription had already been applied | Persist the authoritative email-hash ledger first and propagate failures to the retry path. Stale subscription-event retries also repair the grant. Tests cover storage failure, identity failure and retry |
| R3 | Account deletion ignored business/account read failures and could miss tokens beyond the API page limit | Read and validate the complete paginated subscription/account inventory before cancellation or revocation. Inventory failure aborts before side effects and shows an explanatory message. Tests include 1,101 ad accounts |
| R4 | Scheduled jobs started even when their overlap guard or durable reservation could not be stored | Fail closed with HTTP 503; unique-reservation conflicts remain HTTP 409. Six tests cover guard, insert and missing-id failures |
| R5 | Autopilot used an early settings snapshot and best-effort decision logs as the authority for limits | Re-read current consent/version/account eligibility before reservation and again after Google validation, just before mutation. Count durable mutation reservations; freeze any account with an unresolved execution, even an old one. Add a visible review banner |
| R6 | A zero-conversion search-term row could hide conversions for the same term in another ad group | Refresh live search evidence across all matching campaign/term rows without zero-conversion filtering or LIMIT. Validate every metric and aggregate conversions, clicks and cost. Empty, mismatched or malformed evidence blocks execution |
| R7 | The usage RPC rejected service-role calls with no end-user JWT, so background execution could not reserve metered usage | Add a repeatable service-role-aware migration without weakening own-user isolation or service-only refunds. Actual isolated PostgreSQL tests apply it twice and exercise anon/authenticated/service roles and shared limits |
| R8 | Cron read client-editable `public.users.email` to decide whether to grant operator privileges | Remove that lookup from cron quota reservation. Background work requires a real subscription, never an editable email impersonating an operator |
| R9 | Fractional integer settings and non-finite confidence/evidence values were not consistently rejected | Reject fractional daily/cooldown limits and invalid numerical evidence/confidence. Regression tests cover settings validation |
| R10 | Subscription read errors looked like no subscription; invalid date strings could become indefinite entitlement | Throw on a failed subscription lookup instead of showing an upsell. Invalid/epoch dates no longer grant access. Tests exercise both cases |
| R11 | Autopilot and operations pages were absent from middleware session refresh; Supabase emitted an Edge-runtime incompatibility warning | Include both paths in the early authentication gate. Use supported Node middleware in Next 15.5. Extended anonymous-route tests pass; final build no longer emits the Edge warning |
| R12 | Sync and optimize were independent scheduled events, so one could go missing while the other kept passing | Run optimize after successful sync in one hourly workflow, share its concurrency group, and expose bounded job-age diagnostics in the read-only production check. This reduces independent scheduling gaps; it does not guarantee GitHub cron delivery |
| R13 | Two published `qs` advisories remained reachable through Stripe's dependency graph | Pin the transitive dependency to `qs@6.16.0`; the dependency audit reports no known vulnerabilities |

## Files and Ownership

- `lib/billing/subscription-status.ts`, `entitlements.ts`, `checkout-policy.ts`, `stripe-webhook-handler.ts`, `app/api/billing/checkout/complete/route.ts`: entitlement and trial consistency
- `lib/accounts/deletion-resources.ts`, `app/api/account/delete/route.ts`, `app/(dashboard)/settings/page.tsx`: complete deletion inventory and explicit failure feedback
- `lib/platform/jobs.ts`, both `app/api/cron/*/route.ts`: fail-closed reservation and authentic background metering
- `lib/autopilot/execution-state.ts`, `live-evidence.ts`, `executor.ts`, `policy.ts`, `settings.ts`: fresh consent/evidence, durable limits and validation
- `app/(dashboard)/autopilot/page.tsx`: visible unresolved-execution warning
- `db/migrations/20260907_service_usage_reservation.sql`, `db/schema.sql`: consistent service-role reservation permissions
- `middleware.ts`, `app/api/health/route.ts`, `.github/workflows/production-verification.yml`, `.github/workflows/scheduled-jobs.yml`: runtime compatibility, health coverage and scheduling
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`: isolated PostgreSQL test dependency and patched `qs`
- New regression suites: `account-deletion-resources`, `autopilot-execution-state`, `job-reservation`, `service-usage-migration`, `subscription-status`, `trial-grant`
- Extended suites: `autopilot-settings`, `stripe-webhook-route`, `e2e/public.spec.ts`

The existing untracked marketing plan and week-one scripts were not edited or committed. No `.env` or secret file was copied into the verification workspace or committed.

## Actual Verification

| Check | Result |
| --- | --- |
| Node | 22.23.2 |
| Package manager | pnpm 11.9.0, frozen lockfile |
| `tsc --noEmit` | Exit 0 |
| `eslint . --max-warnings=0` | Exit 0 |
| `pnpm test` | 311 tests, 311 pass, 0 fail |
| `next build` | Exit 0, final Node-middleware candidate compiles without the Supabase Edge warning |
| `pnpm audit --audit-level=low` | Exit 0, no known vulnerabilities |
| Playwright | 24/24 pass on desktop Chromium and Pixel 7 |
| Anonymous route coverage | Dashboard, assistant, audit, optimizer, autopilot, operations, campaigns, reports, billing, settings and onboarding redirect to login |
| Public browser coverage | Home/login/privacy/terms/data deletion load, no unexpected browser errors in those tests; strict nonce CSP, metadata and assets pass |
| Visual inspection | Login screenshots inspected on mobile and desktop in light/dark themes; no horizontal overflow or broken image assets |
| Migration rehearsal | Applied twice to isolated PGlite PostgreSQL, real role switching and shared quota tests pass |
| Git diff | `git diff --check` passes; clean tracked worktree after commits |

The original local dependency directory stalled in filesystem reads, including reads outside the project code. Verification therefore used an identical source copy in `/tmp/modaafa-verify-20260907`, a fresh isolated package store, and no environment secrets. A checksum-based comparison found no source-file differences. The original dependency directory was retained; an attempted move was cancelled before it occurred. This was not a production environment repair.

Local logs: `/tmp/modaafa-clean-check-20260907.log`, `/tmp/modaafa-e2e-20260907.log`.
Screenshots: `/tmp/modaafa-verify-20260907/test-results/`.

## Live Evidence

The in-app browser was used, with the signed-in operator account verified in the app. No unrelated Chrome profile was used.

| URL / action | Observed |
| --- | --- |
| `https://ai.modaafa.com/dashboard` | Signed-in operator, 39 accounts, selected client account name and identifier match; explicit stale-data alert and stored campaign metrics render |
| `https://ai.modaafa.com/autopilot` | Selected account is OFF; limits 3 daily, 95% confidence and 48-hour cooldown are shown; no decision history. No mode was saved or enabled |
| `https://ai.modaafa.com/billing` | Internal Pro access without payment; monthly SAR 500 / 1,200 / 2,500; no invoices |
| `https://ai.modaafa.com/billing?period=yearly` | Annual SAR 5,000 / 12,000 / 25,000 and matching savings; no checkout or payment was initiated |
| `https://ai.modaafa.com/assistant` | Operator can access the composer. One read-only question about data freshness received a specific answer: last sync 2026-08-21, around 17.4 days old, limited confidence; clearly states the metric windows are not current. No execute/approve control was used |

These pages are the existing production build, not proof that the new candidate's authenticated workflow has been deployed or exercised. Production console/network were not exhaustively instrumented. No fresh-user OAuth, voice recording, full paid-customer journey, account deletion, or live ad mutation was tested in this round.

### Production Health Timeline

- 2026-09-07 12:50 UTC: run [34124071109](https://github.com/moodaaft-ops/modaafa/actions/runs/34124071109) returned `launch_ready: false`; all reported component checks except operational jobs passed
- Logs showed sync success at 10:14 UTC and optimize success at 06:38 UTC, both `processed: 0`, `no_billable_businesses`. The optimize freshness exceeded the four-hour health threshold
- 2026-09-07 13:16 UTC: read-only run [34126433629](https://github.com/moodaaft-ops/modaafa/actions/runs/34126433629) returned `launch_ready: true`; latest sync age 3h, optimize age 0.2h, both success, processed 0, errors 0
- The recovery happened on the old production build after a scheduled cycle, NOT because this candidate had been deployed. Neither run is a load test or proof of paid-account processing

Preview deployment for `154f772` is Ready: https://modaafa-d4tj09fwu-moodaaft-ops-projects.vercel.app
Vercel evidence: https://vercel.com/moodaaft-ops-projects/modaafa/AmXiru9QuKD334uywEbKEVbj7x8h
CI: https://github.com/moodaaft-ops/modaafa/actions/runs/34126391678
Both CI jobs passed: verify in 1m27s and e2e in 2m16s. The Vercel preview check also passed.

## Required Release Gates

1. Apply only the reviewed `20260907_service_usage_reservation.sql` to the intended production project, repeat it, and verify role/limit behavior. This review did NOT apply it. Do not substitute enabling unlimited operator privileges in cron
2. Keep global autopilot execution disabled. Test executor boundaries with Google test resources before considering a narrow, explicitly approved pilot; no real campaign is an acceptable disposable fixture
3. Complete Stripe checkout, invoice webhook/replay, Portal plan change/cancellation, failed payment and repeat-trial/account-deletion tests in an isolated Stripe TEST + Supabase staging environment. No test keys should be mixed into production, and no real operator account should be deleted
4. Finish authenticated candidate verification, including refreshed-session behavior with Node middleware and the unresolved-execution banner. Re-run the new-user OAuth journey with a designated test identity
5. Confirm CI and preview checks on the final candidate; then migrate, merge and deploy in that order. Re-check health and authenticated smoke tests after deployment
6. Observe several complete scheduled sync/optimize cycles and define an independent stale-job alert/reliable scheduler before marketing an hourly always-on service. Do not raise the health threshold merely to turn it green

## Product Follow-ups

- Clarify operator testing versus actual scheduled processing: current cron selection requires real billable subscriptions, while the operator's interactive Pro access does not create one. Do not promise background monitoring for a non-billable account based only on the UI mode
- Continue a read-only, representative quality evaluation of audit/assistant results across account sizes and conversion-tracking states, with benchmark answers and explicit data-quality limits
- Prioritize durable job execution and independent monitoring before expanding autonomous action types; budget/bidding/campaign-status automation stays out of this release
- AR/EN localization, root-domain redirects, support-mailbox changes and encryption-key rotation remain separate decisions, not implied by this audit

## Primary References

- [Stripe subscription states](https://docs.stripe.com/billing/subscriptions/overview)
- [Google Ads search-term fields](https://developers.google.com/google-ads/api/fields/v22/search_term_view)
- [GitHub schedule delay/drop behavior](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows)
- [Stable Node middleware in Next.js 15.5](https://nextjs.org/blog/next-15-5)
- [qs advisory GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)
- [qs advisory GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)
