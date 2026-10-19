# Independent review of wave 2 (feat/mb2-integration, d3bce07..5eb1a6a)

Reviewer: Claude (independent pass), 2026-10-20. Scope: `git diff d3bce07..HEAD` (measure2, pmax, uxgaps, video, the integration commit). Priority order: money safety, flags-off parity, webhooks and OAuth, SSRF and PII, RLS, the client/server split. Nothing was pushed, deployed or called live.

## Verdict: SHIP (after the fixes on this branch)

With every new flag unset I found one parity break (Settings ran two new queries), now fixed. The one High finding (the small autonomy level could move money that its owners never agreed to) is fixed by a separate opt-in switch that defaults off. Three Medium findings are fixed. Nothing open blocks a merge. Before turning `AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED` or `STORE_SYNC_ENABLED` on, read the notes under each.

Counts: Critical 0, High 1, Medium 3, Low 7, Info 4. Fixed: 1 High, 3 Medium, 1 Low.

## 1. Money safety

### H1. The small level auto-executed budget moves its owners never agreed to (High). **Fixed**
`lib/autopilot/autonomy.ts` (`evaluateAutonomy`), `app/api/cron/optimize/route.ts:505`. With `AUTONOMY_LEVELS_ENABLED` on, `proposeBudgetShift` runs for every `small_and_notify` account and `evaluateAutonomy` executes `shift_budget_pair` with no approval. The level was sold to merchants as "يمنع الكلمات… ويوقف الكلمة… أي شي ثاني يستأذنك فيه" (`AUTONOMY_LEVEL_LABELS_AR`). The wave 1 migration also backfills that level for every conservative account (REVIEW.md L1). So turning the flag on would start moving money between campaigns on accounts whose owners agreed only to negatives and pauses. `settings.allowed_actions` is not checked for the shift either. uxgaps.md lists "Should the small level move money?" as an open decision, but the code had already answered yes.
Fix: a separate switch `AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED` (default off, in `.env.example`). With it off, the shift is still proposed, but it waits as an approval card (`manual_action_type`). Before turning it on, update the level copy and get consent. Test: `tests/uxgaps-budget-shift.test.ts` ("without its own switch…").

### Checked and fine
- **shift_budget_pair math.** In every place it runs (queue gate, `hardCeilingViolations`, `checkGuardrails`, live preflight, `executeAction`), it is exact integer micros. The total cannot rise. Each leg is a 5 to 20% step and the move is at most 10% of the pair (and of the account at queue time). The shift is whole cents. The live preflight refuses the card if either budget moved since the proposal. It is one `campaignBudgets.update` with both operations, and the rollback restores both in one request. The executor allow-list adds the type only together with `autonomy_approved`. The 7 day budget locks apply both ways between `adjust_budget` and the shift, and so do the bid cross-locks. Pending dedupe covers both budgets, and the money-move expiry is 7 days.
- **Structure actions.** Shared budgets and portfolio strategies are approval only. They use the extended pipeline (validateOnly, readback, declarative rollback whose touched set is prefix-checked) and the capacity step rule. The structure history lock fails closed.
- **Launch.** PMax and Demand Gen campaigns are built PAUSED (`pmax-operations.ts:72`, `demand-gen/operations.ts:84`). If readback sees anything else, they are paused again. The undo refuses while a campaign is ENABLED. A PMax plan is accepted only behind `CAMPAIGN_LAUNCH_PMAX_ENABLED`, and `buildLaunchOperations` re-checks that flag.
- **Experiments.** Create, end and promote are approval only. Promote re-reads the results and refuses unless the treatment won. End and promote are recorded as not reversible. A half-built experiment is removed before the schedule call. `sync_enabled: false`.
- **Pause losing ad.** Approval only (`ad_test_manual_only`), needs healthy tracking, uses scoped `adGroupAds` resources, and rolls back through the base `pause_ad` path.
- **Registry union.** The rollback prefixes are distinct: `ext_ads_`, `ext_vr_`, `ext_struct_`, `growth_`. Every dispatcher (validate, preflight, execute, readback, preview, build/finalize rollback) has both the value-rule and the structure branch. `GROWTH_RESULT_ROLLBACK` is finalized in `execution-result.ts`. No op is routed to the wrong executor and no rollback mapping is missing.
- **Data Manager upload.** It sends hashed identifiers only, and `transactionId` = lead id (the same key as the legacy `order_id`).

### L1. A rollback payload's shift `changes` and growth resource keys were not scope-checked (Low, defence in depth). **Fixed**
`lib/ai/rollback-scope.ts`. `executeRollback` for `shift_budget_pair` mutates `changes[].budget_resource`, but the scope check only looked at `resource_names`. The growth undo paths act on `experiment_resource`, `user_list_resource` and `criterion_resource`, and none of those were checked either. Writes to `ai_actions` are service role only, so a crafted payload is needed to exploit this. All of these keys are now checked, and an empty `changes` list fails closed. Test added.

### L2. The live preflight of a shift does not re-check that both budgets are still unshared (Low, open)
`lib/ai/execution-preflight.ts`. The shared-budget refusal happens at queue time, from the snapshot. A budget that became shared after that would move several campaigns at once. The total is still unchanged. Suggest also reading `campaign_budget.reference_count` at preflight.

### L3. Data Manager row isolation can fall through to legacy after some rows were sent (Low, open)
`lib/lead-loop/upload-service.ts` (`sendViaDataManager`). If an access error hits partway through the one-by-one isolation, the error propagates, and the channel loop then sends the whole batch again via legacy. Dedupe on `order_id`/`transactionId` (same lead id) should absorb this, but that has not been verified across the two APIs. Suggest marking the remaining rows `retry` instead of rethrowing once a row has been uploaded.

## 2. Flags off: no behaviour change

- **M1 (Medium). Settings ran new queries with every flag off (Fixed).** `app/(dashboard)/settings/connections-section.tsx` read `google_scope_grants` (admin) and `store_connections` on every Settings load before checking any flag. Those tables may not exist yet. The errors were swallowed, but these are new queries on a hot page. It now returns before any read when every related flag is off, and it reads each table only when its flag is on (`connectionsReads`). Test added.
- **Checked:** every new route answers 404 with its flag off before auth or I/O (webhooks, store and google-extra OAuth, growth propose). The optimize cron's new steps are gated (`isShoppingHealthEnabled`, `expansionIdeasEnabled`, the shift needs `autonomyByAccount`). `prepareOptimizerLoops` stays `EMPTY_LOOPS_CONTEXT` with no I/O. The measurement cron selects the old column list. The guard adds `null` for shopping. The monthly store line returns `null` before any read. GBP evidence returns `null` first. The Jarvis tool lists only grow with their flag. `buildExecutableAction` returns `null` for shift and growth ops while their flags are off. The builder-gates PMax path is unchanged without `offline_upload_in_place`.
- **I-1 (Info).** Wave 2 changes what some **wave 1** flags do. `ADS_STUDIO_ENABLED` now adds loser-pause cards, sitelink and call-asset cards, and a once-only landing re-crawl. `EXTENDED_ACTIONS_ENABLED` adds value-rule and structure ops plus `get_value_rules`. `AUTONOMY_LEVELS_ENABLED` adds the shift proposer. `CAMPAIGN_LAUNCH_ENABLED` adds the launch button. If any of these is already on in production, deploying wave 2 changes behaviour there.
- **L4 (Low, open).** `app/api/cron/optimize/route.ts:1603`: `maybeQueueExpansionIdea` was inserted between `maybeQueueCampaignOpportunity` and that function's doc comment, so the comment now sits on the wrong function.

## 3. Webhooks and OAuth

- **M2 (Medium). Zid: one store could post orders for any other store (Fixed).** `app/api/webhooks/zid/route.ts` took the store from `?store=` and authenticated with one global URL secret plus one global Basic Auth pair. Any merchant who can see their own webhook URL and credentials could inject fake orders, and so fake revenue, into another merchant's account. That revenue feeds the optimizer prompt ("Google over-reports, do not scale") and the monthly report. The URL secret is now per store: `zidStoreUrlSecret(ZID_WEBHOOK_URL_SECRET, storeId)` = HMAC-SHA256 of `zid:<store id>`, compared in constant time, and the store id must be present and well formed. measure2.md and `.env.example` are updated for the new setup step. Test added. Zid still has no body integrity (I-2, a documented platform limit).
- **Checked:** Salla HMAC is computed over the raw body with a constant-time compare. Strategy `none` is refused. The merchant id comes from the signed body. Shopify is base64 HMAC over the raw body, and the install redirect HMAC is verified before `shop` is trusted. The shop domain pattern is validated before any URL is built from it. OAuth state is 192 bits, stored hashed, single use (the UPDATE … `used_at IS NULL`), checked against purpose and user, and consumed before the code exchange. There is no cookie fallback. Redirects only go to fixed relative `/settings?…` paths or to provider URLs built from env or a validated shop, so there is no open redirect. A store already held by another user is refused. Tokens are encrypted. Logs carry only `error.message` (no tokens or bodies). The token lease is one atomic UPDATE, the winner re-reads, the new refresh token is saved with the access token, and a rejected refresh sets `error`. The Google extra scopes require exactly the feature scope (`include_granted_scopes: false`).
- **L5 (Low, open).** Store connect is check-then-upsert on `(platform, external_store_id)`. If two different users finish OAuth for the same store at the same moment, the later upsert takes over `user_id`. Both users would need store admin access, so the risk is low. A conditional insert (or `WHERE user_id = …` on conflict) would close it.
- **L6 (Low, open).** `lib/stores/tokens.ts` `getStoreAccessToken` has no production caller yet. Note that it returns `null` for Shopify, which has an offline token with no expiry, because `needsRefresh` treats a null expiry as expired. Handle that before wiring it.
- **I-3 (Info).** Shopify's `X-Shopify-Shop-Domain` header is outside the body HMAC. Only Shopify can sign with the app secret, so this is acceptable.

## 4. SSRF and PII

- **Checked:** the image fetch (`lib/image-assets/fetch.ts`) and the site-page crawl (`lib/landing-check/site-pages.ts`) both go through `parseCheckableUrl`, `resolvePublicAddresses` and the pinned transport on every hop, with 3 redirects, a 6 s timeout and a 5 MB streaming cap. The crawl only follows links to the same host and only sends GET. The growth `pageUrl` is resolved against the business website. At execution the image is downloaded again and refused if its hash or size changed.
- **Customer Match:** normalisation (NFKC, invisible characters, Gmail dots and plus) and SHA-256 run in memory. Only hashes leave the function, nothing is stored or logged, and there is no transport (`NO_TRANSPORT` refuses). Consent and terms are required.

## 5. RLS and service role

- **M3 (Medium). Store tables: the owner could read the encrypted tokens, and writes relied on RLS alone (Fixed).** `20261020_store_orders.sql` gave the owner `SELECT` on every column of `store_connections`, including `access_token_encrypted` and `refresh_token_encrypted`. The callback comment promises that tokens never reach the browser. It now revokes table SELECT and grants SELECT only on the non-secret columns. It also revokes INSERT/UPDATE/DELETE from anon and authenticated on both tables (the repo's hardening convention), and the policies are `TO authenticated` with `(SELECT auth.uid())`. `google_scope_grants` gets `REVOKE ALL` from anon and authenticated. The Settings page selects only granted columns. Test added (reads the SQL).
- **Checked:** `claim_store_token_refresh` is SECURITY DEFINER with a pinned `search_path`, and EXECUTE is granted to service_role only. The guard migration only swaps a CHECK. Service-role use is behind ownership: growth and launch propose go through `getLinkedGoogleAdsAccount`, the store callbacks use the session user, and the webhooks resolve the connection from a verified store id.
- **L7 (Low, open).** `store_orders` has no index on `lead_click_id`, and `store_connections` has none on `account_id`. That is fine at today's volume.

## 6. Client/server split

`lib/autopilot/autonomy-levels.ts` has no imports. The values are byte-identical to before. `autonomy.ts` re-exports them, so its API is unchanged. The client form imports only the leaf, and no other `'use client'` file imports `autonomy.ts`. `next build` passes.

## Decisions for Ayman
1. Turning on `AUTONOMY_BUDGET_SHIFT_AUTO_ENABLED` needs new level copy and consent from the merchants already on the small level (and REVIEW.md L1 still applies).
2. Zid: create each webhook with the per-store `s=` value, and accept that Zid deliveries have no body integrity.

## Files changed in this review
`lib/autopilot/autonomy.ts`, `lib/stores/signature.ts`, `app/api/webhooks/zid/route.ts`, `app/(dashboard)/settings/connections-section.tsx`, `lib/settings/connections.ts`, `lib/ai/rollback-scope.ts`, `db/migrations/20261020_store_orders.sql`, `db/migrations/20261020_store_token_lease.sql` (comment), `db/migrations/20261020_google_scope_grants_and_channels.sql`, `.env.example`, `docs/mb-upgrade/measure2.md`, `tests/uxgaps-budget-shift.test.ts`, `tests/measure2-stores-google.test.ts`, `tests/measure2-stores-wired.test.ts`.

## Verification
`npx tsc --noEmit` clean. `npx eslint . --max-warnings=0` clean. `npx tsx --test "tests/**/*.test.ts"`: 3058 tests, 3009 pass, 49 skipped, 0 fail (5 new review tests, 1 existing Zid test updated to the per-store secret; baseline 3053/3004/49/0). `npx next build` succeeds.
