# Campaign launcher (GAP-144 items 9, 11, 12-creation, 14, 15-partial)

Branch `feat/mb-launch`. Flag `CAMPAIGN_LAUNCH_ENABLED` (default off, documented in `.env.example`).
With the flag off nothing changes: the new operation is not executable, the route answers 404, and no
existing branch is reordered.

## What it does

Builder draft -> `buildLaunchPlan` (pure) -> pending card "ابنِ الحملة موقوفة" -> merchant approves ->
one `GoogleAdsService:mutate` batch (validateOnly, then live, then readback) -> rollback descriptor stored
in `ai_actions.rollback_payload` -> a second pending card "شغّلها" (existing `enable_campaign`) is created.
Approving the build never spends: the campaign is created PAUSED and nothing in the batch can enable it.

## Files

New module `lib/launch/`:

| File | Role |
| --- | --- |
| `flag.ts` | `campaignLaunchEnabled`, operation name |
| `arabic.ts` | spelling variants (ة/ه، ى/ي، أ/ا/إ، ال) and dedupe, originals first, cap |
| `negatives.ts` | starter shared list (Arabic and English), collision removal (a negative never blocks a planned keyword) |
| `copy.ts` | RSA 15/4, 30/90 limits, caps, punctuation, phone numbers (incl. Arabic-Indic digits), guarantee wording, script mix |
| `assets.ts` | sitelinks, callouts, structured snippet, call asset (Saudi numbers only), location sync request |
| `plan.ts` | `buildLaunchPlan`, business kind, Search / Standard Shopping / PMax (PMax is a blocker for now), bidding ladder, blockers |
| `validate.ts` | `validateStoredPlan`: a plan read back from the DB is re-checked before any call |
| `operations.ts` | the single mutate batch with temp negative ids |
| `execute.ts` | `executeLaunch`, `validateLaunchOnly`, `executeLaunchRollback` |
| `action.ts` | entry used by the shared executor (flag and plan re-check on every call) |
| `executable.ts` | `launch_campaign` branch for `buildExecutableAction` |
| `recommendation.ts` | the two cards and `createEnableCard` |
| `propose.ts`, `geo.ts` | draft -> plan -> card; region names -> geo target constants |
| `preview.ts`, `launch-plan-preview.tsx` | Arabic preview model and the mobile-first card |
| `app/api/launch/propose/route.ts` | POST `{sessionId, customerId}`, 404 when the flag is off |

Edits to shared files (all additive):

- `lib/ai/executable-action.ts`: one import and one early `if` for `launch_campaign`.
- `lib/ai/optimizer-agent.ts`: type union member, `executeAction` case, `executeRollback` case `remove_launched_campaign`.
- `lib/ai/execution-preflight.ts`: one `else if` (rollback placeholder, no measurement).
- `lib/ai/execution-result.ts`: `finalizeRollbackPayload` returns the launch rollback.
- `lib/recommendations/action-handler.ts`: one line after "applied" to create the "شغّلها" card (never throws).
- `lib/google-ads/client.ts`: `getCustomer(...).mutate(operations, {validateOnly})` for `googleAds:mutate`.
- `app/(dashboard)/optimizer/page.tsx`, `lib/ai/operation-labels.ts`: labels and the preview.

No migration: the existing `recommendations` and `ai_actions` tables carry everything.

## Plan rules (from the skill references)

- Search first. Standard Shopping only when Merchant Center is linked and under 30 conversions a month (Max Clicks with a CPC ceiling, campaign priority 0, no Max Conversions at campaign level). PMax is a blocker (needs images and a logo).
- Bidding: Max Clicks with a ceiling of at most budget / 10, then Max Conversions; target strategies never on a first campaign.
- Keywords EXACT or PHRASE only (BROAD is turned into PHRASE), one text once per campaign.
- Search Partners and Display off, geo `PRESENCE`, campaign `PAUSED`, ad language from the draft.
- Budget blockers: not SAR, missing, above 5000 a day, or far above the monthly budget. A region that cannot be resolved is a blocker (never silently the whole country).
- Location asset only when a LOCATION_SYNC set exists (checked at execution); call asset only for a Saudi number.

## API version and field names

The REST client pins `v22` (`GOOGLE_ADS_API_VERSION`). Field names were checked against the v17 protos in
`node_modules/google-ads-node` (AdTextAsset, ResponsiveSearchAdInfo, CampaignBudget, Campaign.network_settings,
geo_target_type_setting, AssetFieldType for sitelink/callout/structured snippet/call) and the v22 docs for
fields added later (`contains_eu_political_advertising`, required on new campaigns before v26;
`shopping_setting.merchant_id` and `campaign_priority`).

## Safety

- validateOnly runs in the handler and again inside the executor before the live batch; the live call is never retried.
- An ambiguous timeout keeps the card locked (existing behaviour); the executor reconciles by campaign name and still returns a rollback descriptor.
- After the campaign exists nothing throws: a readback failure is reported, a non-PAUSED campaign is force-paused.
- Rollback removes campaign, shared-set link, budget (and the shared list only when this launch created it) in one atomic batch, refuses while the campaign is ENABLED, checks every resource against the account prefix. Assets cannot be removed through the API and stay unlinked.
- The "شغّلها" card is only created after a clean readback.

## Not verified live (needs a real account before turning the flag on)

1. `geoTargetConstants:suggest` response shape and city ranking (parser is tested on a sample only).
2. A full `validateOnly` of the whole batch, especially shopping (`merchant_id` read from existing campaigns, so a store with no existing campaign has no merchant id and is blocked), asset field types, and the EU political advertising field on v22.
3. Reusing existing assets by content key (queries are guarded and degrade to creating new ones).
4. Location asset linking when the account has LOCATION_SYNC at customer level (treated as inherited).
5. The preview card on a real phone.

## Left for later

PMax build (asset groups, brand exclusions list is already in the plan), a button in the builder UI that calls `/api/launch/propose` (the route exists; no UI entry point was added to the assistant to keep the diff small), conversion tracking checks before enabling.

## Tests

`tests/launch.test.ts` (43 tests) with `tests/launch-fixtures.ts`: flag off, plan per business type, spelling variants, RSA and copy validators, negatives, operation batch with temp ids, PAUSED, executor order and readback, ambiguous reconcile, rollback descriptor and refusal while ENABLED, cards, preview, Arabic punctuation rules.
