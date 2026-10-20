# Weekly and monthly media-buyer loops (GAP-144 items 23, 24, 25, 26, 27, 35, 39, 40, 43, 46)

Branch `feat/mb-loops`. Everything is behind a flag that defaults OFF. With every flag off the optimizer prompt, the optimizer route and Jarvis behave exactly as before (the system prompt is untouched; extra prompt lines ride in the user message and are an empty string when no block exists).

## Flags (all in `.env.example`, all off unless exactly `true`)

| Flag | What it switches on |
|---|---|
| `NGRAM_ENABLED` | N-gram block in the optimizer snapshot, Jarvis tool `get_ngram_analysis` |
| `OUTCOME_MEMORY_ENABLED` | "what worked here" block, suppression of a repeat that measured negative, control-group baseline in impact measurement |
| `SEASONS_ENABLED` | Saudi season context in the optimizer (no budget cut or pause judged inside a season week, prep hint) and in the monthly pack |
| `BUSINESS_MEMORY_ENABLED` | Jarvis tool `save_merchant_context`, merchant facts read by the optimizer and the monthly session |
| `MONTHLY_REVIEW_ENABLED` | Monthly cron, Jarvis tools `get_auction_insights` and `get_quality_score` |

Monthly knobs (only read when `MONTHLY_REVIEW_ENABLED=true`): `MONTHLY_REVIEW_MIN_SPEND` (500), `MONTHLY_REVIEW_MAX_COST_USD` (0.5 per account), `MONTHLY_REVIEW_MAX_ACCOUNTS` (25 per run), `MONTHLY_REVIEW_CATCHUP_DAYS` (3).

Jarvis tool lists are built at module load, so changing `NGRAM_ENABLED` or `MONTHLY_REVIEW_ENABLED` needs a restart/redeploy to show or hide the tools (each tool also re-checks the flag when it runs).

## What was built

1. N-grams (`lib/loops/ngram.ts`, `ngram-source.ts`). 1/2/3-grams of `search_term_view` rows, Arabic folding (ة/ه, ى/ي, أ إ آ/ا, leading ال/و), cost/clicks/conversions/value per gram. Flagged: zero conversions (fractional conversions are NOT flagged), cost >= 2 x allowable CPA (`allowableCpaCut` from lib/economics, account 30d CPA as fallback), >= 2 distinct terms, >= 5 clicks, not a business word. A longer gram that adds nothing over a flagged shorter one is dropped. Snapshot block `ngram_analysis` plus Jarvis `get_ngram_analysis`.
2. Auction insights (`lib/loops/auction-insights.ts`). Reads `keyword_view` with `segments.auction_insight_domain` and `metrics.auction_insight_search_*`. Finds new (overlap >= 15% from < 3%), growing (+50% and +7 points) and above-us-more competitors month on month. If Google rejects the query or returns no rows it falls back to the account's own impression-share trend (share lost to rank vs budget) and says which path it used (`source`, `fallback_reason`).
3. Quality Score (`lib/loops/quality-score.ts`). Top 10 keywords by spend, QS < 7 (<= 4 high priority). Suggestions only: split ad group (>= 2 weak-relevance keywords in one group), rewrite ad, fix landing page, improve CTR. Nothing executes.
4. Outcome memory (`lib/loops/outcome-memory.ts`, `filter.ts`). Reads `ai_actions.observed_impact` of the last 90 days, rule-based verdicts positive/negative/neutral/unknown (thin data is unknown, never negative; when a control comparison exists a drop the control shared is neutral). A proposal that repeats the same action type, on the same entity, in the same direction as a negative one is dropped by the route before the autopilot loop and recorded as a blocked autopilot decision with an Arabic reason. Compact `outcome_memory` block in the prompt.
5. Impact measurement (`lib/ai/impact.ts`). `computeObservedImpact(before, after, baseline?)`: output is byte-identical when `baseline` is `undefined`. With a baseline it adds `baseline` and `diff_in_diff` (treated change %, control change %, difference in points for cost, conversions, cost per conversion, `confidence` low/medium/high and an Arabic reason). Control group = campaigns not touched by any measured action since the before-window start, same two windows. Volumes: not low needs >= 15 treated and >= 30 control conversions (both windows), high needs 60 and 100. No control (or a failed/over-25 touched-campaign lookup) = "low". `measureObservedImpacts(... withBaseline)` is true only when `OUTCOME_MEMORY_ENABLED`.
6. Seasons (`lib/loops/seasons.ts`). Ramadan, Eid al-Fitr, Eid al-Adha 2026 to 2028 from a maintained Umm al-Qura table (cross-checked against Node ICU in a test; other years fall back to ICU), National Day (16 to 24 Sep), Founding Day (15 to 23 Feb), White Friday (Friday after the 4th Thursday of November, -7 to +3 days), back to school (rough window). `seasonContext(today)` gives active / recently ended (7 days afterglow) / upcoming with prep windows and `judgement_unreliable`. `seasonRejection` holds budget cuts and campaign pauses in a season week; raises, negatives and ad work are untouched.
7. Business memory (`lib/loops/merchant-context.ts`, migration below). Jarvis tool `save_merchant_context` (kinds upcoming_offer, stock_out, price_change, busy_hours, other), same safety as `save_business_fact` (quote must be in the user's message, not after tool data in the turn, no permission instructions or digit runs). `resolved=true` closes active facts of a kind. The optimizer holds budget raises while a stock-out is active and cuts/pauses while an offer runs or starts within 7 days.
8. Monthly deep session (`lib/loops/monthly.ts`, `monthly-run.ts`, `monthly-accounts.ts`, `app/api/cron/monthly-review/route.ts`). First 3 days of the month 05:31 UTC, one report per account per month (`reports` row, `period_type='monthly'`, unique index). Skips accounts under the minimum spend. One `jarvis_deep` (Opus) call per account, only if the worst-case cost (whole prompt at input rate + full max_tokens at output rate) is under the cap; otherwise the money report is still stored and `plan_status='skipped_cost_cap'`. The merchant money report (spent, returned, wasted, protected) is computed server side with fixed wording, never by the model. The model plan (targets vs economics, structure, competition, quality, season plan, experiments) is parsed from JSON, cleaned to house style (no dashes, Arabic comma) and any line carrying a number that is not in the pack is dropped. Mail through `sendTemplate` with new copy `monthly_report` (`approved: false`, so it is held until Ayman approves; the report is stored and visible regardless).

## Migration (NOT run)

`db/migrations/20261020_merchant_context.sql`: table `public.merchant_context_facts` (idempotent, RLS owner read, service_role grants). Apply before turning on `BUSINESS_MEMORY_ENABLED`. Reads fail soft if it is missing.

## Not verified live

- Auction insight GAQL on `keyword_view` (field names are from the v22 field reference; never run against a real account). The fallback exists for exactly this.
- Quality Score GAQL fields on `keyword_view` (`quality_info.*`). A refused read returns "no data" and the tool says so.
- The control-group lookup of touched campaigns for budget/ad group/keyword/ad level measurements (GAQL) and the diff-in-diff thresholds are judgement calls, not calibrated on real accounts.
- The cost worst-case bound uses 2.2 characters per token; the real Opus call was never made. Real cost per account is logged by `llm_usage` (`feature: monthly_review`).
- GitHub schedule `31 5 1-3 * *` was added to `.github/workflows/scheduled-jobs.yml` (the live workflow file). Pushing workflow changes may need a token with workflow scope.
- No email was sent; `monthly_report` copy needs Ayman's approval.

## Open decisions for Ayman

1. Read and approve the `monthly_report` mail text (lib/lifecycle/copy.ts). It sits under the `weekly_report` preference category: should a merchant who turned off the weekly report also miss the monthly one, or does it need its own switch?
2. Monthly thresholds: min spend 500 SAR, cost cap 0.5 USD per account. Fine for launch?
3. Whether the "protected" figure (cost taken out by measured changes that kept conversions, estimated from the week before and after) is the right definition to show a merchant, or should be left out until more measurements exist.
4. Season handling is conservative (holds cuts and pauses only). Should seasons also be allowed to unlock raises earlier?
5. Back-to-school window and Founding/National Day windows are rough; adjust if you prefer different ranges.

## Files touched

Shared files (small, additive): `app/api/cron/optimize/route.ts`, `lib/ai/optimizer-agent.ts`, `lib/ai/impact.ts`, `lib/jarvis/brain.ts`, `lib/jarvis/db-tools.ts` (exports only), `lib/jarvis/tools/index.ts`, `lib/jarvis/tools/types.ts`, `lib/jarvis/tools/negative-words.ts` (one export), `lib/lifecycle/copy.ts`, `lib/lifecycle/types.ts`, `lib/lifecycle/email-report.ts`, `.env.example`, `.github/workflows/scheduled-jobs.yml`, `vercel.json`.

New: `lib/loops/{flags,seasons,ngram,ngram-source,outcome-memory,merchant-context,auction-insights,quality-score,prompt,filter,snapshot,monthly,monthly-run,monthly-accounts}.ts`, `lib/jarvis/tools/{get-ngram-analysis,get-auction-insights,get-quality-score}.ts`, `app/api/cron/monthly-review/route.ts`, `db/migrations/20261020_merchant_context.sql`, `tests/loops-{seasons-flags,ngram,outcomes-impact,merchant-competition-quality,monthly}.test.ts`.
