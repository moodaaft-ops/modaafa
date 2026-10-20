# Integration of the media-buyer upgrade (feat/mb-integration)

Merge order: feat/mb-guard, feat/mb-actions, feat/mb-measurement, feat/mb-launch, feat/mb-loops, feat/mb-ads, feat/mb-trust. Every feature is additive and behind its own flag; with all flags off behaviour is what main does today.

## Flags (all default off)

| Flag | Feature | Notes |
|---|---|---|
| `GUARD_ENABLED` (+ `GUARD_ALLOWLIST`) | Morning guard | `true` or `operators` |
| `EXTENDED_ACTIONS_ENABLED` | Extended account actions (schedule, bid modifiers, network, shared negatives, Google recommendations) | exactly `true` |
| `LEAD_LOOP_ENABLED` (+ `LEAD_LOOP_ALLOWLIST`) | Measurement layer: WhatsApp link, lead inbox, offline upload, data exclusions, goals review | `true` or `operators` |
| `CAMPAIGN_LAUNCH_ENABLED` | Campaign launcher (paused campaign, then separate enable card) | exactly `true` |
| `NGRAM_ENABLED` | N-gram search term analysis (optimizer block + Jarvis tool) | exactly `true` |
| `OUTCOME_MEMORY_ENABLED` | Measured outcomes memory + diff-in-diff | exactly `true` |
| `SEASONS_ENABLED` | Saudi season calendar | exactly `true` |
| `BUSINESS_MEMORY_ENABLED` | Merchant context (needs the merchant_context migration) | exactly `true` |
| `ADS_STUDIO_ENABLED` | Ad copy and assets (asset performance, Saudi RSA writer, replace LOW assets, sitelinks, callouts, snippets, ad tests, Jarvis get_ad_assets) | exactly `true`; write actions also need `EXTENDED_ACTIONS_ENABLED=true` |
| `LANDING_CHECK_ENABLED` | Landing page check (weekly, SSRF guarded) + Jarvis get_landing_check | exactly `true` |
| `OFFER_COACHING_ENABLED` | Offer and response coaching (Jarvis tool + monthly report lines) | exactly `true` |
| `AUTONOMY_LEVELS_ENABLED` | Autonomy level `small_and_notify` (still needs `AUTOPILOT_EXECUTION_ENABLED`) | exactly `true` |
| `AGENCY_HANDOFF_ENABLED` | Agency handoff card and operator tab | exactly `true` |
| `SHADOW_MODE_ENABLED` | Agency shadow accounts (nothing executes, nothing is mailed) | exactly `true` |
| `MONTHLY_REVIEW_ENABLED` | Monthly Opus session, auction insights and quality score tools, monthly mail | plus `MONTHLY_REVIEW_MIN_SPEND`, `_MAX_COST_USD`, `_MAX_ACCOUNTS`, `_CATCHUP_DAYS` |

## Migrations, apply order (none has been run)

1. `db/migrations/20261020_guard_findings.sql`
2. `db/migrations/20261020_lead_loop.sql`
3. `db/migrations/20261020_merchant_context.sql`
4. `db/migrations/20261020_trust_agency_handoff.sql`
5. `db/migrations/20261020_trust_autonomy_levels.sql`
6. `db/migrations/20261020_trust_landing_checks.sql`
7. `db/migrations/20261020_trust_shadow_mode.sql`

They are independent of each other (they only reference `google_ads_accounts` / `businesses`), so file-name order is fine. Apply `trust_autonomy_levels` before turning `AUTONOMY_LEVELS_ENABLED` on (it backfills `small_and_notify` for accounts already in conservative mode). All idempotent. Ads adds none.

## Crons

| Route | Trigger | Schedule (UTC) | vercel.json maxDuration |
|---|---|---|---|
| `/api/cron/guard` | workflow job `guard` | `30 2 * * *` and safety slot `40 3 * * *` | 300 |
| `/api/cron/measurement` | extra step of the hourly `optimize` job (`47 * * * *`) | hourly | 120 |
| `/api/cron/monthly-review` | workflow job `monthly-review` | `31 5 1-3 * *` | 300 |

`/api/cron/optimize` also carries the loops changes (n-gram, outcome memory, seasons, merchant context) behind their flags. One `vercel.json` entry and one workflow entry per cron path.

## Conflicts resolved

- `lib/ai/optimizer-agent.ts`: union of the `OptimizerAction.type` members (`ExtendedOperation`, `add_data_exclusion`, `create_lead_conversion_action`, `set_conversion_primary`, `launch_campaign`) and of all imports (measurement builders, launch runners, loops prompt/types).
- `lib/ai/executable-action.ts`: order is extended-ops branch, then `launch_campaign` branch, then the allow-list (which gets the three measurement operations only when `isLeadLoopServing()`). The allow-list is typed `string[]`.
- `lib/ai/operation-labels.ts`, `app/(dashboard)/optimizer/page.tsx`: union of labels (`EXTENDED_OPERATION_LABELS_AR` spread plus measurement and launch labels), union of preview branches (extended rows, measurement rows, `LaunchPlanPreview`).
- `lib/ai/execution-result.ts`: `finalizeRollbackPayload` handles the extended rollback first, then `remove_launched_campaign`, then the existing cases.
- `lib/google-ads/client.ts`: two branches each added a GoogleAds:mutate helper (`mutateOperations` in actions, `mutate` in launch). Unified into the single `mutateOperations` (it returns the raw response plus a `results` array, a superset of what launch used). `lib/launch/execute.ts` (`LaunchCustomer` interface and calls) and the mocks in `tests/launch.test.ts` were renamed accordingly. No test removed.
- `lib/jarvis/tools/index.ts`: base list keeps the flag-gated `get_google_recommendations`; loop tools stay flag-gated at start-up; the name lookup map contains the base tools plus the three loop tools.
- `lib/lifecycle/types.ts`: `EmailFacts` has both `guard?` and `monthly?`.
- `vercel.json`, `.github/workflows/scheduled-jobs.yml`, `.env.example`: all entries kept (see crons and flags above).
- Auto-merged without conflict but worth a look in review: `lib/ai/execution-preflight.ts` (measurement and launch both add cases), `app/robots.ts`, `middleware.ts`.

## feat/mb-ads merge

- Only `.env.example` conflicted (both sides kept). Ads adds no migration and no cron; it hooks into `app/api/cron/optimize/route.ts` behind its flag. Its write actions go through the extended-actions executor, which already calls `customer.mutateOperations`, so no client rename was needed.
- Shared validators: `lib/launch/copy.ts` now takes its limits (RSA counts, headline, description, path, sitelink, callout, snippet) from `lib/ads/validators.ts` (identical values) and, for lines with a language, also runs the shared check for hidden characters, dashes, Latin comma in Arabic, ornamental quotes, machine phrases and minimum length (new issue codes `house_style`, `too_short`). The grounding rules (invented numbers, claim words, Latin words not in sources) stay in the Ads Studio writer because launch has no source corpus. Launch rules were not loosened: the result is the stricter of the two. All launch tests pass unchanged.

## feat/mb-trust merge and post-merge wiring

- Conflicts: `.env.example` (both), `lib/jarvis/tools/index.ts` (trust tools added as a third flag-gated group next to the base and loop groups, name map extended), `lib/ai/optimizer-agent.ts` (`checkGuardrails`: the shadow check runs FIRST, before the extended-actions branch, because that branch returns early and would otherwise skip it).
- Compile fix: in `app/api/cron/optimize/route.ts` the shadow branch used `actions` before it existed (loops introduced the filtered `actions` later); it now stores the raw `proposedActions`.
- (1) Offer coaching in the monthly money report: `reviewAccount` calls `deps.loadCoaching` (default: `loadCoachingInput` + `detectCoaching` + `coachingLinesForReport`) only when `OFFER_COACHING_ENABLED`; lines go to the mail only (`MonthlyFacts.coachingLines`, block "ملاحظات على العرض والرد", max 3), not into the stored report. Flag off: no call, no block.
- (2) Landing tag evidence in `get_conversion_health`: `lib/landing-check/evidence.ts` reads the latest stored check (never fetches a page) and adds `landing_page_evidence` with `supporting_only: true`; a note appears only for missing/suspect/broken verdicts when no Google tag is visible. The verdict code is never touched. Flag off: store not read, field absent.
- (3) Shadow exclusion: guard run (`excludeShadowAccounts`, no check and no mail), monthly review (`shadow_account` skip before anything is read or sent), lead-loop upload (`uploadLeadConversions` returns before touching a lead), measurement scan (shadow accounts get no cards), campaign launch (executes only through `checkGuardrails`, which refuses shadow accounts first; tested with `launch_campaign`). All no-ops with `SHADOW_MODE_ENABLED` off; an unreadable shadow table fails closed (nothing mailed or proposed).
- Tests for each wiring: `tests/integration-wiring.test.ts` (8 tests).

## Verification

`npx tsc --noEmit` clean, `npx eslint . --max-warnings=0` clean, `npx tsx --test "tests/**/*.test.ts"`: 2828 tests, 2779 pass, 49 skipped, 0 fail (baseline 2440 plus every branch and the integration wiring tests). Each branch's own report (`guard.md`, `actions.md`, `measurement.md`, `launch.md`, `loops.md`) lists what is not verified live.

## Build fixes found by `next build`

- `lib/lead-loop/ref-code.ts` imported `node:crypto` and is also imported by the client component `leads-client.tsx`; switched to Web Crypto (`globalThis.crypto.getRandomValues`), same behaviour and same tests.
- `app/api/leads/settings/route.ts` exported a helper (`appBaseUrl`), which Next rejects in a route file; made it module-private.

`NODE_OPTIONS=--max-old-space-size=5000 npx next build` finishes with exit 0.
