# Ad copy and assets (GAP-144 items 12, 16, 17, 19)

Branch `feat/mb-ads` (on top of `feat/mb-actions`). Everything is behind `ADS_STUDIO_ENABLED` (default off, documented in `.env.example`). The write actions also need `EXTENDED_ACTIONS_ENABLED=true`. With both off, behaviour is unchanged: the new operations are refused like unknown ones, the Jarvis tool is not registered, the optimizer snapshot has no `ad_assets` key and the cron does no extra reads or model calls.

## What was built

1. **Asset performance reader** (`lib/ads/assets-reader.ts`): RSA headlines/descriptions with `performance_label` (from `ad_group_ad_asset_view`), approval/policy per asset, ad strength, 30 day metrics; extension coverage per Search campaign (sitelink 4, callout 4, snippet 1, call 1; account level assets count); Performance Max asset group status/policy/ad strength only. `assetVerdict` decides what may be replaced: enabled ad, 1000+ impressions, LOW or disapproved, never pinned, max 5 headlines and 2 descriptions, never more than half the headlines, the ad keeps 3 headlines and 2 descriptions. Snapshot block (`buildAdAssetsSnapshot`) has counts only, no ad text. Jarvis read tool `get_ad_assets` (`lib/jarvis/tools/get-ad-assets.ts`).
2. **Writer** (`lib/ads/writer.ts`): Sonnet tier via `createMessageForAgent('builder')`, feature `ads_studio_writer`. Language follows the ad/landing page (Saudi colloquial for Arabic). Hard validators live in neutral `lib/ads/validators.ts`: length 30/90 (Arabic counted by characters), no dashes, no Latin comma in Arabic, no phones/URLs/emoji, no exclamation, caps, AI phrase kill list, no invented numbers, no unverifiable claim words, duplicate meaning, pins. Model text that fails is dropped (one retry with failure codes, not texts). Nothing reaches a card without passing, and the same rules re-run at approval and in preflight.
3. **Approval actions** (members of the extended-actions pipeline, `lib/ads/studio/*`): `replace_rsa_assets` (mode `swap`: new RSA with LOW swapped, old ad PAUSED not removed; mode `test_variant`: old stays enabled, max 2 enabled ads), `add_sitelinks` (same host as the campaign's landing pages only), `add_callouts`, `add_structured_snippet`, `add_call_asset` (campaign level; asset create + campaign_asset link with temp resource names). Preflight reads live state and refuses on changes. Rollback: re-enable old ad and pause new one, or unlink campaign_asset. An ad is never removed. Readback, Arabic preview rows, labels, impact measurement (ad group level) included.
4. **Ad test helper** (`lib/ads/ad-test.ts`): two RSAs in an ad group, winner = conversions per impression, 90% confidence, 1000 impressions per ad, 28 days, 30 conversions, blocked by allowable CPA, with an Arabic note that Google does not rotate evenly. Surfaced in `get_ad_assets`.
5. **Optimizer** (`lib/ads/proposals.ts`, `lib/ads/cron.ts`, hook in `app/api/cron/optimize/route.ts`): when the flags are on, at most one "replace LOW assets" and one "add missing assets" (callouts, then snippet) card per account per run, queued as pending recommendations with `source: optimizer_cron`, 14 day cooldown (pending or any card in 14 days blocks, checked before any model call). Not in `AUTOPILOT_SAFE_ACTIONS`, not in the model's `ALLOWED_ACTION_TYPES`; never auto executed. Business answers come from `business_memory` (type, name, regions), top converting terms from the snapshot.

## Flags and migrations

- `ADS_STUDIO_ENABLED` (exact string "true"). Writes: also `EXTENDED_ACTIONS_ENABLED`.
- Migrations: none. No table constrains `operation` or `action_type`.

## Not verified live (needs a real account)

- GAQL field names checked against v22 protos only, never run.
- `asset_group_asset` has no `performance_label` in v22, so Performance Max has no per-asset labels (report shows status/policy/strength).
- One `googleAds:mutate` with `ad_group_ad` pause + create, with validateOnly.
- Temp resource names for assets (`customers/{cid}/assets/-N`) linked in the same request.
- REST accepts `pinned_field` values `HEADLINE_1` etc. on create.
- Call asset `country_code` SA and +966 phone format; structured snippet header list.
- Label quality: labels need roughly 1000+ impressions; thresholds are conservative.

## Not done / deferred

- Sitelink and call asset cards from the optimizer: the platform holds no verified site pages or merchant phone, so no card is invented (the actions exist for Jarvis/manual use).
- Landing title/H1 are not fetched in the cron (writer accepts them; caller passes none yet).
- `prepare_change` Jarvis chat support for these actions (pattern in `lib/jarvis/prepare-change-extended.ts`) and optimizer page label maps.
- Ad test is read-only: it recommends a winner, it does not pause the loser.

## Open decisions for Ayman

- Should the winner of an ad test auto-create a "pause the loser" card?
- Where do sitelink URLs and the merchant phone come from (setup question, crawl of the store)?
- Cooldown 14 days and the 1000 impression floor: keep or tune?

## For lib/launch

Reuse `lib/ads/validators.ts` (`validateAssetText`, `validateCandidateSet`, `validateRsaStructure`, `buildGrounding`) for any RSA text the campaign launcher writes. It has no app imports.

## Files

New: `lib/ads/{flag,validators,rows,assets-reader,writer,ad-test,proposals,cron}.ts`, `lib/ads/studio/{types,validate,preflight,execute,readback,preview}.ts`, `lib/jarvis/tools/get-ad-assets.ts`, `tests/ads-validators.test.ts`, `tests/ads-studio.test.ts`.
Edited: `lib/ai/extended-actions/{types,validate,preflight,execute,preview,readback}.ts`, `lib/ai/{rollback-scope,operation-labels,action-fingerprint,impact,optimizer-agent}.ts`, `lib/jarvis/tools/{index,types}.ts`, `app/api/cron/optimize/route.ts`, `.env.example`.

## Tests

Full run: 2514 tests, 2465 pass, 49 skipped, 0 fail (baseline 2488). tsc and eslint clean.
