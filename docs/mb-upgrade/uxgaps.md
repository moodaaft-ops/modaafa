# UX gaps (branch feat/mb2-uxgaps)

Seven items closed on top of feat/mb-integration. Every new behaviour is behind a flag that defaults OFF. With the flag off the old code path is unchanged. No migrations were needed. Nothing here ran against a live service; every test mocks Google Ads, Supabase and the model.

## Flags

| Flag | Gates |
| --- | --- |
| CAMPAIGN_LAUNCH_ENABLED | item 1 (launch button) |
| ADS_STUDIO_ENABLED | items 2, 3, 4, 5 (cards and Jarvis ops) |
| EXTENDED_ACTIONS_ENABLED | execution of the sitelink / callout / call / RSA asset ops |
| LANDING_CHECK_ENABLED | item 4 (stored landing report supplies the site pages) |
| AUTONOMY_LEVELS_ENABLED + AUTOPILOT_EXECUTION_ENABLED | item 6 (small-level budget pair) |
| EXPANSION_IDEAS_ENABLED (new, in .env.example) | item 7 |

## What was built

1. **Launch button.** `ابنِ الحملة موقوفة` under the latest campaign draft in the assistant. Calls POST /api/launch/propose and shows the pending card. Mobile first, RTL. Files: lib/launch/client.ts, app/(dashboard)/assistant/launch-draft-action.tsx, assistant-client.tsx, page.tsx.
2. **Jarvis prepare_change** for replace_rsa_assets, add_sitelinks, add_callouts, add_structured_snippet, add_call_asset. The model never sees or types a URL or phone: sitelinks come from `site_page` evidence rows (refs `sp_`), the phone from a `verified_phone` row (`ph_`), RSA replacement from the numbered `replaceable_texts` list. Texts pass `validateAdsStudioPayload`. A matching nightly card is returned instead of a duplicate. Files: lib/jarvis/prepare-change-ads.ts, prepare-change.ts, brain.ts, tools/types.ts, tools/get-ad-assets.ts, tools/get-landing-check.ts.
3. **Ad test winner leads to "وقّف النسخة الخسرانة"** approval card (pause_ad, rollback through the existing machinery). Needs healthy tracking, a winner verdict and scoped resources. Autopilot code `ad_test_manual_only`, so never automatic. File: lib/ads/ad-test-cards.ts, wired in lib/ads/cron.ts.
4. **Sitelink and call-asset cards.** Sitelink URLs: same domain as the landing page, 200 OK only, from the landing-check crawl (lib/landing-check/site-pages.ts, lib/ads/site-sources.ts). Phone: only from onboarding answers, a call asset already in the account, or `business_memory.business_phone`. Nothing invented. Files: lib/ads/proposals.ts, cron.ts, site-sources.ts.
5. **Disapproved ads (item 33).** Policy topics read, a compliant rewrite proposed through the existing RSA writer and validators as an approval card (kind `replace_disapproved`, ranked first), plus an appeal text shown read only in the optimizer page for the merchant to submit. Never submitted by us. Files: lib/ads/disapproved.ts, proposals.ts, writer.ts, app/(dashboard)/optimizer/page.tsx.
6. **Small-level budget pair.** Operation `shift_budget_pair`: decrease A, increase B by the same amount in ONE campaignBudgets mutate, total unchanged, at most 10 percent of the total, whole cents, 5 to 20 percent step per budget, 7 day locks on both, shared budgets refused, rollback restores both in one request. Cut gate on the giver and scale gate on the receiver. Rules only, no model. All hard ceilings kept. Seeded property tests (4000 and 6000 cases) prove the total never rises. Files: lib/autopilot/budget-math.ts, budget-shift.ts, autonomy.ts, executor.ts, autonomy-notify.ts, recommendation-dedupe.ts, lib/ai/optimizer-agent.ts, execution-preflight.ts, executable-action.ts, operation-labels.ts, optimizer-gates.ts, lib/recommendations/staleness.ts, app/api/cron/optimize/route.ts.
7. **Horizontal expansion ideas.** lib/ai/expansion.ts finds a Search campaign that is saturated (impression share 45 percent or more, lost to rank 15 percent or less, lost to budget 10 percent or less, at least 15 conversions in 30 days, healthy tracking, inside the owner's CPA or ROAS break-even). Ideas: a new ad group from converting search-term clusters; a new campaign type (PMax or Shopping) only when applyBuilderGates keeps it (Merchant Center linked, 30 or more conversions) and the goal is sales; a new geo (logic and tests done, input not wired, see below). Output is a recommendation row (`expansion_idea`) with a brief that opens the assistant and the launch flow. 14 day cooldown, one idea per run, fingerprint per idea. Nothing executable. Files: lib/ai/expansion.ts, route.ts, optimizer/page.tsx, staleness.ts.

## Migrations

None.

## NOT verified live

- A two-operation `campaignBudgets.update` is atomic (documented behaviour of mutate, never run by us).
- The sitelink, callout, structured snippet and call asset mutates, and the RSA policy topic read (`policy_summary`) on a real disapproved ad.
- The crawl on a real merchant site, and the same-host filter on real redirects.
- The ad test loser pause on a real account.
- Expansion card quality on real data; thresholds are conservative guesses.

## Open decisions for Ayman

- **Phone writer.** `business_phone` in business_memory has no writer. Until the merchant can save it (settings or onboarding), the only phone sources are the account's existing call asset and onboarding answers.
- **Should the small level move money?** shift_budget_pair only runs for accounts on small_and_notify with both flags on. Say if you would rather keep the small level to non-money actions.
- **Policy exemption requests** (`policy_validation_parameter.exempt_policy_violation_keys`) exist in the API. Documented in lib/ads/disapproved.ts and deliberately not used. The appeal text is manual.
- **10 percent pair ceiling** and the 15 percent lost-rank threshold for expansion.
- **Geo expansion** needs the geo report (geographic_view) plus the targeted locations and parent chains read in the nightly snapshot. Detector is ready (`suggestNewGeos`), the cron passes `geo: null` until that read is verified.
- Ad test cards are skipped when tracking is not healthy.

## Tests

tests/uxgaps-launch-sites.test.ts (12), uxgaps-ads-cards.test.ts (7), uxgaps-budget-shift.test.ts (15), uxgaps-jarvis-ads.test.ts (8), uxgaps-expansion.test.ts (7).
