# Measure2: upload channels, value rules, store orders, GA4/GBP

Branch feat/mb2-measure2 (from feat/mb-integration). Everything is behind flags; flags off means behaviour is unchanged.

## Item 1 (critical): legacy offline import
Confirmed from the Google Ads API deprecations page: from 15 Jun 2026 developer tokens with no offline upload between 17 Dec 2025 and 15 Jun 2026 are restricted, and UploadClickConversions returns CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE. The restriction is per developer token, so it hits the whole platform. UploadCallConversions is not mentioned. Replacement: Data Manager API.

Built: lib/google-ads/data-manager.ts (events:ingest, max 200 per batch here, validateOnly support, consent from DATA_MANAGER_CONSENT, hashed identifiers only if present), lib/lead-loop/transports.ts (planChannels, isLegacyBlockedError), upload-service channels param, cron wiring. Order is Data Manager then legacy; a legacy block is recorded on lead_loop_settings.legacy_blocked_at and legacy is skipped afterwards. If neither works the status is needs_data_manager_grant.

Scope: the adwords scope alone is NOT sufficient. Data Manager needs https://www.googleapis.com/auth/datamanager. It is requested as a separate consent (lib/google-auth, /api/auth/google-extra/start and /callback), stored encrypted in google_scope_grants. The main sign-in and stored Ads refresh token are unchanged. Consent screen change: add the datamanager scope (and, for the other features, analytics.readonly and business.manage) to the OAuth consent screen and add GOOGLE_EXTRA_OAUTH_REDIRECT_URI to the authorized redirect URIs. The merchant sees a separate Google prompt naming only that one permission.

## Item 8: conversion value rules
lib/value-rules: reader (get_value_rules Jarvis tool), create_value_rule_set and update_value_rule actions through the extended pipeline (EXTENDED_ACTIONS_ENABLED), MULTIPLY only (0.5 to 2, never 1), geo/device/audience conditions, max 5 rules per set. Rollback pauses rules (rules cannot be removed from a set).

## Item 4: store orders (STORE_SYNC_ENABLED)
lib/stores: signature verification, order normalisation, click matching (exact gclid, then M- ref code in the order note; otherwise the order stays in the aggregate), compareRevenue (store revenue vs Google-reported value, verdict needs 10 orders), OAuth config from env, recordOrder. Routes: /api/webhooks/salla and /api/webhooks/zid. Migration 20261020_store_orders.sql.
Wired (second pass):
- Optimizer: with STORE_SYNC_ENABLED the snapshot gets a compact `store_revenue` block (30 days: store revenue and orders, attributed part, Google value, ratio, verdict) and one prompt line in loops/prompt.ts. Block appears only with at least 10 live orders. Flag off: no query, snapshot and prompt unchanged.
- Monthly money report: one extra Arabic line (storeRevenueLine) after the four fixed lines, same gate. Flag off: identical lines.
- Salla/Zid token refresh: lib/stores/tokens.ts with the DB lease `claim_store_token_refresh` (migration 20261020_store_token_lease.sql, one atomic UPDATE, 30 s). The winner re-reads, refreshes, saves access and new refresh token together; losers wait and re-read. A rejected refresh sets status error (merchant reconnects); a failed save of the new refresh token also sets error.
- OAuth routes: /api/auth/stores/{salla,zid}/start|callback and /api/auth/stores/shopify/start|callback. State is `<platform>~192 bits`, stored server side in oauth_states, single use, bound to the user, consumed before the code is exchanged; no cookie fallback; rate limited; 404 with the flag off. A store already connected by another user is refused. The store id is read from the platform profile endpoint right after the exchange (Salla `oauth2/user/info`, Zid `managers/account/profile`; paths overridable by env, NOT verified live).
- Shopify (feasible, done): webhook /api/webhooks/shopify verifies X-Shopify-Hmac-Sha256 (base64 HMAC-SHA256 of the raw body with the app client secret, documented by Shopify). Install flow validates the shop domain pattern, verifies Shopify's hex HMAC over the redirect query before trusting `shop`, exchanges the code for an offline token (does not expire, so no refresh), and registers orders/create, orders/updated, orders/cancelled best effort. gclid and utm come from the order's landing_site query. Needs SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI and read_orders. Not verified live.
- Zid webhooks are not auto-registered: create them in Zid with target_url `<app>/api/webhooks/zid?s=<zidStoreUrlSecret(ZID_WEBHOOK_URL_SECRET, store id)>&store=<store id>` (per-store secret since REVIEW-2) plus the Basic Auth user and password.

## Item 44: GA4 and GBP (GA4_READ_ENABLED, GBP_READ_ENABLED)
Separate consents done. lib/google-read/ga4.ts (runReport, landing page engagement, weak pages) and gbp.ts (rating, review count, hours, state; gbpHoursEvidence returns Arabic evidence text and never changes a decision). The evidence line is attached to the call-hours decision (ScenarioDecision.evidence, rendered under the reason in the plan card) when GBP_READ_ENABLED, the merchant has a GBP grant, and the Google user has exactly one location (several places: no evidence, never a guess). It never changes the decision, the amount or the steps. Flag off: no I/O. GBP: Google must approve the GBP API project before any call works.

## Not verified live
Data Manager userIdentifiers member names, eventSource values, per-event error shape; Salla payload fields, token-strategy header and order read scope name; Zid OAuth paths and payload shape; value rule-set mutate method name and limits; GA4/GBP responses.
Zid documents no HMAC signature. We require Basic Auth plus a secret in the URL, which gives no body integrity.

## Decisions for Ayman
DATA_MANAGER_CONSENT policy; eventSource choice; where grants show in Settings (Settings now has a section: store status, the three Google grants, and the `?extra=` / `?store=` outcome); hashed email/phone is not available from the WhatsApp flow today; GBP project approval; accept the Zid auth limitation.

## Migrations and env
20261020_google_scope_grants_and_channels.sql, 20261020_store_orders.sql; env additions in .env.example.

## Settings
Settings gets a "الربط الإضافي" section (app/(dashboard)/settings/connections-section.tsx, view model in lib/settings/connections.ts). It renders nothing while every related flag is off. Stacked cards on mobile, row layout from sm, RTL, Arabic copy; outcome notice for `?extra=` and `?store=` only for a known feature or platform. Shopify shows a shop-domain field.
