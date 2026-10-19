# Integration of the media-buyer upgrade (feat/mb-integration)

Merge order: feat/mb-guard, feat/mb-actions, feat/mb-measurement, feat/mb-launch, feat/mb-loops. Every feature is additive and behind its own flag; with all flags off behaviour is what main does today.

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
| `MONTHLY_REVIEW_ENABLED` | Monthly Opus session, auction insights and quality score tools, monthly mail | plus `MONTHLY_REVIEW_MIN_SPEND`, `_MAX_COST_USD`, `_MAX_ACCOUNTS`, `_CATCHUP_DAYS` |

## Migrations, apply order (none has been run)

1. `db/migrations/20261020_guard_findings.sql`
2. `db/migrations/20261020_lead_loop.sql`
3. `db/migrations/20261020_merchant_context.sql`

They are independent of each other (each only references `google_ads_accounts` / `businesses`), so the order is by file name. All idempotent.

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

## Verification

`npx tsc --noEmit` clean, `npx eslint . --max-warnings=0` clean, `npx tsx --test "tests/**/*.test.ts"`: 2687 tests, 2638 pass, 49 skipped, 0 fail (baseline 2440 plus guard 71, actions 48, measurement 20, launch 43, loops 65). Each branch's own report (`guard.md`, `actions.md`, `measurement.md`, `launch.md`, `loops.md`) lists what is not verified live.

## Build fixes found by `next build`

- `lib/lead-loop/ref-code.ts` imported `node:crypto` and is also imported by the client component `leads-client.tsx`; switched to Web Crypto (`globalThis.crypto.getRandomValues`), same behaviour and same tests.
- `app/api/leads/settings/route.ts` exported a helper (`appBaseUrl`), which Next rejects in a route file; made it module-private.

`NODE_OPTIONS=--max-old-space-size=5000 npx next build` finishes with exit 0.
