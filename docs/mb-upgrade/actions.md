# Extended account actions (mb-actions)

Branch `feat/mb-actions`. Scope: GAP-144 items 10, 13, 21, 28, 29, 30.

## Flag and migrations

- Flag: `EXTENDED_ACTIONS_ENABLED` (default off, documented in `.env.example`). Only the exact string `true` turns it on.
- Flag off: `buildExecutableAction` returns null for every new operation, `executeAction`/`executeRollback`/`prepareActionForExecution` throw for them, `checkGuardrails` rejects them, `finalizeRollbackPayload` and the approval handler skip the new branches, the Jarvis read tool is not registered (decided at module load), and `prepare_change` exposes the same tool object as before. Existing suites pass unchanged.
- Migrations: none. `recommendations.category` already allows `targeting` and `keywords`, and no table constrains `operation` or `ai_actions.action_type`.

## What was built

12 new operations, none proposable by the nightly optimizer (not in `ALLOWED_ACTION_TYPES`) and none run by autopilot (`AUTOPILOT_SAFE_ACTIONS` untouched). Each goes through the existing approval pipeline: validate payload, live preflight, guardrails, `validateOnly`, live mutate, rollback record, measurement.

| Operation | Google Ads change |
|---|---|
| `set_ad_schedule` | `campaign_criterion.ad_schedule` create/remove, modifier update |
| `set_device_bid_modifier` | `campaign_criterion.device` (MOBILE, DESKTOP, TABLET) |
| `exclude_location` | negative `campaign_criterion.location` |
| `set_location_bid_modifier` | modifier on an already targeted location |
| `set_geo_target_type` | `campaign.geo_target_type_setting.positive_geo_target_type` (PRESENCE or PRESENCE_OR_INTEREST) |
| `set_network_settings` | `campaign.network_settings` Search Partners and Display, turn off only |
| `create_shared_negative_list` | `shared_set` + `shared_criterion` + `campaign_shared_set` in ONE atomic `googleAds:mutate` with a temporary resource name |
| `add_shared_negative_keywords` | `shared_criterion` on an existing list |
| `attach_shared_negative_list` | `campaign_shared_set` |
| `apply_google_recommendation` | `recommendations:apply`, SITELINK_ASSET and CALLOUT_ASSET only |
| `dismiss_google_recommendation` | `recommendations:dismiss` |
| `pause_auto_apply` | `recommendation_subscription` status PAUSED |

Design points:

- Payload validation (`lib/ai/extended-actions/validate.ts`) whitelists params per operation and re-checks every resource name against the account customer id, so a stored payload can never carry `resolved`. Bid modifiers are bounded to 0.5 to 1.5 (device: 0 means exclude). Ad schedule: whole-quarter-hour windows, no overlap, max 6 per day.
- Ad schedule semantics: windows are immutable in Google Ads, so a change is remove + create, or only a modifier update. Any schedule switches off unscheduled hours, so the planner (`schedule.ts`) keeps uncovered hours serving at modifier 1 unless `restrict_to_slots` is true.
- Preflight (`preflight.ts`) reads live state, writes `params.resolved`, builds the rollback descriptor (old values) and a campaign-level measurement. Smart Bidding campaigns are refused for schedule, device and location modifiers (Google ignores them; device opt-out 0 is still allowed). Network switches only on Search campaigns.
- Shared lists: skill limits enforced (20 lists per account, 5000 keywords per list, 50 per action, 10 campaigns per action), name collision refused, conflicts checked with the existing `filterNegativeKeywordBatch` (injected to avoid an import cycle) against converting search terms and enabled keywords on every attached campaign. Attaching an existing list refuses when any member would block a converting term.
- Rollback: `ext_restore_campaign_criteria`, `ext_restore_campaign_fields`, `ext_shared_list_rollback`, `ext_restore_subscriptions`. Created resources are mapped by result index in `finalizeExtendedRollback`. `buildRollbackOperations` refuses any resource not in `touched_resources`. `rollbackResourcesScoped` now checks every list of an `ext_` payload and fails closed on malformed ones. Recommendation apply and dismiss are NOT reversible (Google has no un-apply or un-dismiss).
- Readback (`readback.ts`): after the live mutate the approval handler reads the account back and stores `readback: {status: verified | mismatch | unavailable}` in `ai_actions.result`. It never throws and never undoes anything.
- Guardrails (`guardrails.ts`): payload re-validated against the account, 7 day lock per campaign per family (schedule, device, location, geo type, network) when the approval handler runs, fail closed if history is unreadable.
- Impact: schedule, device, location, geo type, network join `MEASURED_ACTION_TYPES` (existing `campaign` level).
- Arabic: `EXTENDED_OPERATION_LABELS_AR` (merged into `OPERATION_LABELS_AR`), approval card rows in `preview.ts`, optimizer page preview and label maps, autopilot history label.

### Recommendation triage

- `lib/recommendations/google-triage.ts`: pure classifier returning accept, reject or needs_review with an Arabic reason. Rules: accept SITELINK_ASSET and CALLOUT_ASSET (only these are appliable); reject keyword removal, duplicate, unused types (the v22 enum has no such named type, so it matches by name pattern: unverified against real data); reject USE_BROAD_MATCH_KEYWORD and KEYWORD_MATCH_TYPE under 30 conversions in 30 days; reject budget raises unless the target is proven met (unknown counts as not met); reject Search Partners, Display expansion, Performance Max and Maximize Clicks opt-ins; Smart Bidding opt-ins rejected under 30 conversions and sent to review above; everything else needs_review.
- Jarvis read tool `get_google_recommendations` (flag on only): lists open recommendations with verdict, reason, impact numbers and the auto-apply state. Resource names are kept in evidence rows (`google_recommendation`, `auto_apply` kinds), never shown to the model. Impact fields are optional: if the API rejects them the tool retries without.
- `prepare_change` (flag on) adds: `set_ad_schedule`, `set_device_bid_modifier`, `exclude_location`, `set_location_bid_modifier`, `set_geo_target_type`, `set_network_settings`, `create_shared_negative_list`, `apply_google_recommendation`, `dismiss_google_recommendation`, `pause_auto_apply`. All come from evidence refs (cmp_, geo_, st_, nw_, gr_, aa_); apply needs verdict accept, dismiss needs verdict reject. `add_shared_negative_keywords` and `attach_shared_negative_list` exist in the approval pipeline but are not offered in chat yet (no read tool lists existing shared lists).

### Auto-apply

The skill says auto-apply stays locked. Google Ads API v22 exposes `RecommendationSubscription` (`customers/{cid}/recommendationSubscriptions/{type}`, status ENABLED or PAUSED), so it CAN be paused by API; implemented as the approved action `pause_auto_apply` with a rollback that re-enables. If the subscription cannot be read or paused (permissions, API difference), the tool returns the instruction «اطفه من الإعدادات» (Google Ads, Recommendations, auto-apply).

## NOT verified live (no network, no live services)

- Field and enum names were checked against the v22 protos inside the `google-ads` 29.0.0 Python wheel, not by a live call.
- `googleAds:mutate` with `validateOnly` and a temporary resource name (`sharedSets/-1`) across three resource types: expected per docs, not tested.
- GAQL on `recommendation_subscription`, and `recommendation.impact.*` metric field names.
- Shape of the `recommendations:apply` payload for sitelink and callout assets (`ad_asset_apply_parameters` with `new_assets` and scope CAMPAIGN). `recommendations:apply` has no validate-only; our validateOnly step for it is a read-only existence check.
- Whether a Smart Bidding strategy list (`SMART_BIDDING_STRATEGIES`) covers every strategy name Google returns.
- Devices CONNECTED_TV and OTHER are intentionally not modifiable.
- The 7 day lock and the Smart Bidding refusal are policy choices from the skill, not API limits.
- Test run with `EXTENDED_ACTIONS_ENABLED=true` for the whole suite was not done: `tests/jarvis-tools.test.ts` has hard-coded tool indexes, so the read tool is registered only when the flag is on.

## Open decisions for Ayman

1. Modifier bounds of 50 percent either way: tighter, or keep?
2. Should `pause_auto_apply` stay an approval action, or only show the manual instruction?
3. Allow creating positive locations (today a location modifier needs a location the campaign already targets)?
4. `restrict_to_slots` default is false (uncovered hours keep serving). Confirm.
5. Budget raise recommendations are rejected unless the target is proven met; the tool passes "unknown" today because the tool context has no CPA or ROAS target. Wire the account economics in?
6. Offer shared list add and attach from chat once a read tool lists existing lists.

## Files touched

New: `lib/ai/extended-actions/{flag,types,validate,schedule,preflight,execute,guardrails,readback,preview}.ts`, `lib/recommendations/google-triage.ts`, `lib/jarvis/tools/get-google-recommendations.ts`, `lib/jarvis/prepare-change-extended.ts`, `tests/extended-actions.test.ts`, `tests/extended-actions-surface.test.ts`, `docs/mb-upgrade/actions.md`.

Edited: `.env.example`, `app/(dashboard)/optimizer/page.tsx`, `app/(dashboard)/autopilot/page.tsx`, `lib/ai/{action-fingerprint,executable-action,execution-preflight,execution-result,impact,operation-labels,optimizer-agent,rollback-scope}.ts`, `lib/google-ads/client.ts` (`mutateOperations`, `recommendations.apply/dismiss`), `lib/jarvis/{brain,prepare-change}.ts`, `lib/jarvis/tools/{index,types}.ts`, `lib/recommendations/action-handler.ts`.

Tests: 48 new (2488 total, 2439 pass, 49 skipped, 0 fail). `npx tsc --noEmit` and `npx eslint . --max-warnings=0` clean.
