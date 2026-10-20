# Integration, wave 2 (feat/mb2-integration)

Base: feat/mb-integration + feat/mb2-measure2 (f6308dd). Merge order: feat/mb2-pmax, feat/mb2-uxgaps, feat/mb2-video. Everything is behind flags that default off.

## Conflicts and resolutions

### feat/mb2-pmax (measure2 value rules vs pmax structure actions)
Pure union in every file; both sides added a sibling branch to the same registry, nothing overlapped.
- `lib/ai/action-fingerprint.ts`: category map keeps `create_value_rule_set`/`update_value_rule` (bidding) and the eight structure ops (targeting, budget, bidding).
- `lib/ai/extended-actions/{types,validate,preflight,preview,readback,execute}.ts`: imports of both value-rules and structure modules, `EXTENDED_OPERATIONS` spreads both lists, and each dispatcher has both `isValueRuleOperation` and `isStructureOperation` branches (execute, finalize rollback and build rollback too). The validateOnly/readback/rollback path is the shared one; no check removed.
- `lib/ai/operation-labels.ts`: both label sets.
- `lib/ai/rollback-scope.ts`: `EXTENDED_NAME_LISTS` has both `pause_rules` and `struct_names`.
- `lib/jarvis/tools/index.ts`: imports of `getValueRulesTool` and `getShoppingHealthTool`; each stays behind its own flag (`EXTENDED_ACTIONS_ENABLED`, `SHOPPING_HEALTH_ENABLED`).

### feat/mb2-uxgaps
- `lib/jarvis/tools/types.ts`: `EvidenceKind` union has `value_rule_set`, `shopping_issue`, `site_page`, `verified_phone` (plus the earlier members).

### feat/mb2-video
- `.env.example`: both flag blocks kept.

### Build fix found by `next build`
`app/(dashboard)/autopilot/autopilot-settings-form.tsx` (client) imported constants from `lib/autopilot/autonomy.ts`. After the merge that file reaches `execution-preflight` -> `growth/registry` -> `experiments/plan` -> `growth/readiness` -> (dynamic import) `get-conversion-health` -> `lib/supabase/server`, which cannot go in a client bundle. Moved `AUTONOMY_LEVELS`, `AutonomyLevel`, `DEFAULT_AUTONOMY_LEVEL`, `AUTONOMY_LEVEL_LABELS_AR` to the leaf module `lib/autopilot/autonomy-levels.ts`; `autonomy.ts` re-exports them (no API change) and the form imports the leaf. Values unchanged.

## Verification
- `npx tsc --noEmit`: clean
- `npx eslint . --max-warnings=0`: clean
- `npx tsx --test "tests/**/*.test.ts"`: 3053 tests, 3004 pass, 49 skipped, 0 fail (flag-off parity tests: growth-flags-parity and the existing parity suites pass)
- `npx next build`: succeeds

## Flags added in wave 2 (all default false, exactly `true` enables)
Measure2: `DATA_MANAGER_UPLOAD_ENABLED` (+ `DATA_MANAGER_CONSENT`), `GA4_READ_ENABLED`, `GBP_READ_ENABLED`, `STORE_SYNC_ENABLED`; value rules ride `EXTENDED_ACTIONS_ENABLED`.
Pmax: `CAMPAIGN_LAUNCH_PMAX_ENABLED` (also needs `CAMPAIGN_LAUNCH_ENABLED`), `SHOPPING_HEALTH_ENABLED`; structure actions ride `EXTENDED_ACTIONS_ENABLED`.
Uxgaps: `EXPANSION_IDEAS_ENABLED`; other items reuse `CAMPAIGN_LAUNCH_ENABLED`, `ADS_STUDIO_ENABLED`, `EXTENDED_ACTIONS_ENABLED`, `LANDING_CHECK_ENABLED`, `AUTONOMY_LEVELS_ENABLED` + `AUTOPILOT_EXECUTION_ENABLED`.
Video: `DEMAND_GEN_ENABLED`, `AUDIENCES_ENABLED`, `EXPERIMENTS_ENABLED`, `IMAGE_ASSETS_ENABLED`.

## Migrations (none run, all idempotent, independent)
- `db/migrations/20261020_store_orders.sql` (measure2)
- `db/migrations/20261020_store_token_lease.sql` (measure2)
- `db/migrations/20261020_guard_product_disapprovals.sql` (pmax; needed before `SHOPPING_HEALTH_ENABLED` guard detector)
Uxgaps and video add none.

## Review notes
Each branch's own report (measure2.md, pmax.md, uxgaps.md, video.md) lists what is not verified live.
