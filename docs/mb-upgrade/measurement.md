# Measurement layer and lead-quality loop (GAP-144 items 1, 2, 3, 6, 7)

Branch `feat/mb-measurement`. Everything is behind `LEAD_LOOP_ENABLED` (default off). With the flag off: `/w/*`, `/leads` and `/api/leads/*` answer 404, the cron answers `{skipped:'disabled'}`, the nav has no new entry, the three new operations are not in the executable allow-list (payloads stay manual review) and the conversion-health tool returns exactly what it did.

## Flag
- `LEAD_LOOP_ENABLED`: `true` (everyone), `operators` (Modaafa operators plus `LEAD_LOOP_ALLOWLIST` emails), anything else off. Documented in `.env.example`.
- Public side (redirect, cron, allow-list) uses `isLeadLoopServing` (true for `true` or `operators`; in operators mode a link row only exists for an allowed merchant).

## Migration (not run)
`db/migrations/20261020_lead_loop.sql`: `lead_loop_settings` (slug, number, text, stored conversion action resource), `lead_clicks` (ref code, click ids, utm, status, value, upload state), `lead_conversion_uploads` (per-attempt log), `measurement_scan_state`; owner-select RLS like the autopilot tables; SECURITY DEFINER `claim_lead_uploads` (FOR UPDATE SKIP LOCKED) so two cron runs never send the same lead.

## What was built
1. Smart WhatsApp link `/w/<slug>`: captures gclid/gbraid/wbraid/utm (query first, Referer fallback), stores a click with an `M-XXXX` ref code (unambiguous alphabet, widens to 5-6 chars on collision), 302 to `wa.me/<number>?text=<text> + ref`. No IP or user agent stored. Per-visitor (20/min) and per-link (600/h) rate limits. The visitor always reaches WhatsApp: bots, HEAD, rate limit and storage failures redirect without recording. Number validation (Saudi mobile, Arabic digits). A small page snippet (copy button in settings) saves the click ids on the merchant page and appends them to the link, because browsers rarely send a full Referer.
2. Lead inbox `/leads` ("ليدز هالأسبوع"), RTL, mobile first: summary, settings (number, text, link and snippet with copy buttons), list with the three marks (صار زبون with optional SAR value, ما رد, مو جاد), search by pasted ref code or a whole WhatsApp message. Uploaded leads are locked.
3. Offline upload service (`lib/lead-loop/upload-service.ts`, `lib/google-ads/click-conversions.ts`): `uploadClickConversions` with `partialFailure`, per-row outcome (uploaded, duplicate counted as done, retry, failed), `order_id` = lead id, conversion time in the account time zone and never before the click, clicks older than 89 days not sent, request failure puts leads back without burning attempts, max 8 attempts. Finds the action "مُضاعِف | زبون فعلي" by GAQL; creation goes through an approval card. Runs from `/api/cron/measurement` (a step added to the hourly optimize job in `scheduled-jobs.yml`; the route also has a recent-run guard and a time budget).
4. Data exclusions (`lib/measurement/data-exclusion.ts`, `tracking-gaps.ts`, `proposals.ts`): a resolved window of zero conversions with real traffic (at least 3 days, at least 8 conversions expected from the baseline, at most 14 days) produces a pending approval card `add_data_exclusion`. Ongoing breaks are not proposed. Executes through the existing pipeline (guardrail 8, preflight, validateOnly, rollback payload `remove_created_data_exclusion`).
5. Goals and enhanced conversions (`lib/measurement/goals.ts`, `review-inputs.ts`): the conversion-health tool gets a flag-gated `measurement` block: multiple primaries counting the same thing, WhatsApp click as primary, call click as primary, primary in a non-biddable goal, enhanced conversions for leads off or unreadable, customer data terms, lead action missing or ready to be primary (15+ in 30 days). Changes only through approval cards: `create_lead_conversion_action` (UPLOAD_CLICKS, rollback removes it) and `set_conversion_primary` (rollback restores the previous values).

## Not verified live (no network allowed)
- REST field names and enum spellings for `uploadClickConversions`, `biddingDataExclusions:mutate` and `conversionActions:mutate` (create and update masks). Built from docs and guides; the first run per account is validateOnly via the approval flow, which will surface any mismatch.
- GAQL fields `bidding_data_exclusion` and `customer.conversion_tracking_setting.*`.
- API version: default `GOOGLE_ADS_API_VERSION` (v22). Google is moving offline imports to the Data Manager API (`events:ingest`, scope `auth/datamanager`) and locks the legacy path after 15 June 2026 for accounts without recent use. The transport is injectable, so swapping it is a small change, but it is not built.
- Enhanced conversions for web cannot be read through the API; the verdict says so and gives manual steps.
- A new conversion action needs 4 to 6 hours before it accepts uploads: the retry codes cover it.
- The migration has not been applied; RLS and the claim function are untested against Postgres.

## Open decisions for Ayman
1. Data Manager API versus the legacy upload path for new accounts (needs one real account test).
2. Should "صار زبون" with no SAR value upload with a default value, or without value? Now: without value.
3. Auto-propose in the autopilot policy? Now: approval only.
4. Where the page snippet gets installed (the merchant's developer, or a Salla/Zid app integration).
5. Whether the 7 day window in the inbox should be configurable.

## Tests
`tests/lead-loop-core.test.ts` (flag, ref codes, click parsing, number validation, redirect plan, marking, redirect handler with mocked deps) and `tests/lead-loop-upload.test.ts` (payload builder, partial failures, upload service incl. idempotency, data-exclusion builder, tracking gaps, goals review, copy rules, executable-action gating). 20 new tests.

## Files touched
New: `app/w/[slug]/route.ts`, `app/api/leads/{settings,mark}/route.ts`, `app/api/cron/measurement/route.ts`, `app/(dashboard)/leads/{page,leads-client}.tsx`, `lib/lead-loop/*` (flag, ref-code, click-ids, whatsapp, redirect, redirect-handler, marking, store, upload-service, api), `lib/measurement/*` (time, data-exclusion, tracking-gaps, goals, conversion-actions, review-inputs, proposals, scan), `lib/google-ads/click-conversions.ts`, `db/migrations/20261020_lead_loop.sql`, the two test files, this report.
Edited: `lib/google-ads/client.ts`, `lib/ai/{optimizer-agent,executable-action,execution-preflight,execution-result,operation-labels}.ts`, `lib/jarvis/tools/get-conversion-health.ts`, `app/(dashboard)/{optimizer/page,layout,dashboard-chrome,simple-chrome}.tsx`, `middleware.ts`, `app/robots.ts`, `.env.example`, `vercel.json`, `.github/workflows/scheduled-jobs.yml`.
