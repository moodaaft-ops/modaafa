# Performance Max, Shopping health and account structure

Scope: GAP-144 items 13 (remainder), 14, 15, 29, 30. Branch `feat/mb2-pmax`. Everything ships OFF.

## Flags (all in .env.example, all default false)

| Flag | Guards |
|---|---|
| `CAMPAIGN_LAUNCH_PMAX_ENABLED` | Performance Max launch (also needs `CAMPAIGN_LAUNCH_ENABLED`). Off: a PMax draft stays the `pmax_assets_required` blocker, exactly as before. |
| `SHOPPING_HEALTH_ENABLED` | shopping_product reader, optimizer snapshot block `shopping_health`, Jarvis `get_shopping_health`, guard detector. |
| `EXTENDED_ACTIONS_ENABLED` (existing) | Structure actions below. |

## Migration (not run)

- `db/migrations/20261020_guard_product_disapprovals.sql`: idempotent, replaces the `guard_findings` code check so the new code `product_disapprovals` is allowed.

## What was built

### Structure actions (`lib/structure/*`, wired into `lib/ai/extended-actions/*`)
Approval, validateOnly, readback and rollback through the existing extended-action pipeline (declarative rollback, payload `ext_struct_rollback`).
- AI Max toggle (`campaign.ai_max_setting.enable_ai_max`, field verified in the v22 protos). Search only, Smart Bidding required, at least 30 conversions in 30 days.
- Campaign placement and content exclusions (placements, YouTube channels, content labels). Display, Video, Demand Gen only. Deduped against existing.
- Shared budgets (create, attach, detach) and portfolio bid strategies (create, attach, detach). Existing 5 to 20 percent budget rules apply to the combined daily capacity; a change under 1 percent counts as a neutral restructure; 7 day budget lock and 14 day bidding lock are counted across structure actions. Portfolio needs 30 pooled conversions and a target within 20 percent of the pooled actual; previous bidding is restored on rollback.
- Listing group tree builders for Standard Shopping and PMax (single node tree can be subdivided).
- Tests: `tests/structure-actions.test.ts`.

### Shopping health (`lib/shopping/*`)
- Reader of `shopping_product` status and issues, summary, snapshot block, Jarvis tool, guard detector `detectProductDisapprovals`.
- The "spike" is a level rule (at least 20 products, at least 10 not eligible, share 20 percent or more; 50 percent or more is critical) because there is no feed history to take a day-over-day delta from.
- Tests: `tests/shopping-health.test.ts`.

### Performance Max launch (`lib/launch/pmax*.ts`)
- Asset group with headlines (3 to 15), long headlines, descriptions, business name, images, logos, landscape logos, YouTube videos, validated through `lib/launch/copy.ts` on `lib/ads/validators.ts` and image ratio and size rules.
- Images and videos are existing account assets (read by `pmax-inventory.ts`, re-checked by `pmax-preflight.ts` right before the build). No upload. Assets cannot be removed via the API, so rollback removes the campaign (and with it the asset group and links) and leaves the library alone.
- Audience signals: search themes, customer lists, custom audiences (ASSET_GROUP scoped Audience).
- Retail: listing group root filter, Merchant Center id and feed label read before the build.
- Final URL expansion off by default (`asset_automation_settings` opted out); URL exclusions only when merchant turns expansion on. Brand exclusions via a BRANDS shared set, falling back to phrase negatives.
- Builder gates kept: store PMax needs a feed and 30 conversions in 30 days. Leads PMax is kept only if `offline_upload_in_place` is true and conversions are at least 30; otherwise it falls back to Search as before.
- Plan validation (`validateStoredPlan`) accepts PMax only behind the flag. Preview shows the asset group, signals and expansion state. Readback checks one asset group.
- Route `app/api/launch/propose` reads inventory and the offline upload signal only when the flag is on.
- Tests: `tests/launch-pmax.test.ts`.

## NOT verified live (validateOnly will refuse if wrong)
1. Final URL expansion through `asset_automation_settings` FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION=OPTED_OUT in v22.
2. Campaign level negative keywords on PMax campaigns.
3. Creating an asset-group scoped Audience inside the same batch.
4. Brand list shared set and `campaign_criterion.brand_list`.
5. AI Max behaviour after the toggle, and placement criterion shapes.
6. The `merchant_center_id` and `feed_label` fields on `shopping_product` for the preflight read.
7. Custom label index enum for listing dimensions.

## Open decisions for Ayman
- Guard on a real day-over-day delta needs a stored feed snapshot (new table). Today it is a level rule.
- Exclude the merchant's own brand from PMax brand exclusions by default? Currently only what the draft lists.
- Image upload into the asset library (needs a safe fetch and size check) is not built; the merchant must pick existing images.
- Optimizer proposer and Jarvis prepare-change for the structure actions are not built; they are reachable through the approval pipeline only.
- `offline_upload_in_place` is read at propose time; it is not yet fed into `loadBuilderSignals` for the earlier builder gate step.

## Files touched
New: `lib/structure/{types,validate,plan,preflight,readback,preview,execute}.ts`, `lib/shopping/{flag,reader,snapshot,guard}.ts`, `lib/jarvis/tools/get-shopping-health.ts`, `lib/launch/{pmax,pmax-operations,pmax-inventory,pmax-preflight}.ts`, `db/migrations/20261020_guard_product_disapprovals.sql`, `tests/{structure-actions,shopping-health,launch-pmax}.test.ts`, this file.
Edited (additive): `lib/ai/extended-actions/{types,validate,preflight,execute,readback,preview,guardrails}.ts`, `lib/ai/{operation-labels,action-fingerprint,impact,rollback-scope,builder-gates,optimizer-agent}.ts`, `lib/ads/validators.ts`, `lib/guard/{types,persist,analyze,signals,run}.ts`, `lib/jarvis/tools/index.ts` and evidence kinds, `app/api/cron/optimize/route.ts`, `app/api/launch/propose/route.ts`, `lib/launch/{flag,copy,types,plan,validate,operations,execute,preview}.ts`, `.env.example`, `tests/support/guard.ts`.
