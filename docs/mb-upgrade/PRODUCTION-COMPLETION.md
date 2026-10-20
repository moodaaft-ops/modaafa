# Production completion, 20 October 2026

This follow-up closes REVIEW-2 L2 through L7 and adds the requested production entry points. Account mutations still require an owned approval card, fresh preflight, validateOnly, mutate, readback and the existing rollback contract. No live advertising changes were made by rollout verification.

## Review findings closed

- L2: both budgets are read immediately before each paired validate/mutate. Sharing, reference count and stale amounts fail closed.
- L3: Data Manager attempts pin leads to that channel before transmission. Accepted isolated rows stay uploaded; unsent rows retry on that same channel, even after a lost grant. No legacy fallback after a Data Manager attempt.
- L4: campaign-opportunity documentation is attached to the right function.
- L5: store connect inserts first. A uniqueness conflict can update only the same owner's connection; another owner is refused.
- L6: Shopify offline tokens are decrypted directly without a refresh lease or invented expiry.
- L7: lead-click and account foreign-key lookup indexes are in the additional migration.

## Added features

| Flag | Behavior |
| --- | --- |
| MERCHANT_PHONE_ENABLED | Settings phone, 05XXXXXXXX validation, E.164 storage, owner-confirmed call-asset source. Business-owner confirmation, not SMS possession verification. |
| SHOPPING_FEED_SNAPSHOTS_ENABLED | Daily summary, previous-day comparison, 90-day retention. First-day level detection remains. |
| DEMAND_GEN_ENABLED / EXPERIMENTS_ENABLED | Mobile RTL proposal forms on optimizer. Names resolve through cached Saudi GeoTargetConstantService suggestions. |
| IMAGE_ASSETS_ENABLED + IMAGE_DEVICE_UPLOAD_ENABLED | Private PNG/JPEG uploads, existing size/ratio validation, immutable hash, approval-only ImageAsset creation. |
| STRUCTURE_PROPOSALS_ENABLED + EXTENDED_ACTIONS_ENABLED | Optimizer and Jarvis proposals for AI Max, shared budgets, portfolios and exclusions. No automatic execution. |
| EXPANSION_IDEAS_ENABLED | Actual 30-day geographic/user-location reads with complete Saudi geo ancestry. |
| CAMPAIGN_LAUNCH_PMAX_ENABLED | Builder also reads offline-upload availability. Brand guidelines use campaign-level business/logo assets and contiguous asset-group assets. |
| CUSTOMER_MATCH_UPLOAD_ENABLED + AUDIENCES_ENABLED + DATA_MANAGER_UPLOAD_ENABLED | Approval-only Data Manager ingestion. Only SHA-256 email/phone identifiers enter cards. Consent and terms are mandatory. |
| ZID_WEBHOOK_AUTO_REGISTER_ENABLED | Register supported order events after OAuth; Settings also provides per-store manual URL and Basic Auth. Master secrets stay server-only. |

Google Ads defaults to v23. v22 sunset on 7 October 2026 and returned UNSUPPORTED_VERSION during validation. Demand Gen Max Clicks cannot carry a CPC ceiling; the plan uses the daily budget cap. Video ads carry the required ad name. Shared budgets refuse incompatible standalone Maximize strategies and mismatched portfolios.

Owner defaults: BUDGET_PAIR_SHIFT_MAX_PCT=10, DEMAND_GEN_MIN_DAILY_SAR=20, MAXIMIZE_CONVERSIONS_MIN_30D=10. Search builder and growth readiness enforce the conversion floor. PMAX_OWN_BRAND_EXCLUSION_ENABLED=false, POLICY_EXEMPTION_REQUESTS_ENABLED=false, AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED=false. Exemption requests have no supported execution path and remain unavailable.

## Production database

Applied the original files in exact order: guard_findings, guard_product_disapprovals, lead_loop, google_scope_grants_and_channels, merchant_context, store_orders, store_token_lease, trust_agency_handoff, trust_autonomy_levels, trust_landing_checks, trust_shadow_mode (all prefixed 20261020_).

Additional applied migrations:

- 20261021_store_lookup_indexes.sql
- 20261021_lead_upload_channel_pin.sql
- 20261021_merchant_call_phones.sql
- 20261021_shopping_feed_snapshots.sql
- 20261021_private_merchant_images.sql

Live SQL verification: all 17 tables exist with RLS enabled. Owner policies are present where intended. anon/authenticated cannot select encrypted store token columns or write either store table; google_scope_grants is closed to browser roles. The merchant-images bucket is private with a restrictive server-only policy. Both indexes exist. The claim function remains service-role-only.

## Live API evidence

scripts/verify-live.ts refuses any Google Ads POST mutation without validateOnly=true. It runs real builders against agency-owned SAR account 3378391742 under manager 7561141000. Report: verify-live-2026-10-20.json.

Coverage: Demand Gen campaign/image/video ads, PMax campaign/asset group, listing-group subdivision, experiment creation, shared budgets, portfolios, exclusions, AI Max, sitelinks, calls, the paired-budget executor, visitor list and image creation. Reads: policy topics, shopping_product fields, asset_automation_settings, expansion geo, structure proposals.

Experiment arms and treatments require an actual live experiment resource. This verification covers experiment creation only; it does not create a serving experiment to manufacture those resources. Image verification supplies controlled PNG bytes to the storage adapter and uses the real Google validateOnly builder; it does not upload merchant files.

## Rollout

Use staged production flags and a new READY deployment after each stage. Stage 3 requires all live checks to pass. Preserve the owner-off settings. Existing scheduled-jobs.yml already schedules guard, optimization/weekly reports, measurement and monthly review. No duplicate pg_cron schedules are needed.

## External completion

The Google OAuth client now contains https://ai.modaafa.com/api/auth/google-extra/callback. Data Manager scope was saved with a usage justification. Google marks it unverified and requires a demo video and review. Keep DATA_MANAGER_UPLOAD_ENABLED and CUSTOMER_MATCH_UPLOAD_ENABLED off for public production until approval. Merchants must authorize the optional scope separately; existing Ads tokens cannot gain it automatically.

Salla and Zid partner portals require login credentials absent from this session. Shopify sign-in needs explicit profile-sharing approval. Provider keys cannot be fabricated; production keys and end-to-end store installation remain pending those access steps. No Sentry integration or credentials were found; Vercel runtime errors are the available rollout monitor.

## Primary API references

- https://ads-developers.googleblog.com/2026/09/google-ads-api-v22-sunset-reminder.html
- https://developers.google.com/google-ads/api/docs/sunset-dates
- https://developers.google.com/google-ads/api/performance-max/getting-started?type=standard
- https://developers.google.com/data-manager/api/reference/rest/v1/audienceMembers/ingest
- https://docs.zid.sa/create-a-webhook?nav=1
- https://docs.zid.sa/create-first-app
- https://docs.salla.dev/421410m0
- https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard
