# الحارس الصباحي (morning guard) and automatic incident diagnosis

Scope: GAP-144 items 20, 22, 31, 32, 33, 34. Branch `feat/mb-guard`. Ships OFF.

## What was built

A rules-only daily check (no model call anywhere) of every connected Google Ads account of a billable owner.

| Piece | Where |
|---|---|
| Flag | `lib/guard/flag.ts` (`GUARD_ENABLED=true|operators`, `GUARD_ALLOWLIST`) |
| Detectors (pure, fixture tested) | `lib/guard/detectors.ts` |
| Root-cause tree (pure) | `lib/guard/diagnose.ts`, `lib/guard/analyze.ts` |
| Arabic sentences (one place) | `lib/guard/copy.ts` |
| Google reads (small GAQL, fail-soft per source) | `lib/guard/signals.ts` |
| Dedupe and persistence | `lib/guard/persist.ts` |
| Run orchestration | `lib/guard/run.ts` |
| Mail facts, home/Jarvis read side | `lib/guard/notify.ts`, `lib/guard/read.ts` |
| Cron route | `app/api/cron/guard/route.ts` (bearer CRON_SECRET like the others, job_runs row `guard`) |
| Scheduler | `.github/workflows/scheduled-jobs.yml`, job `guard`, `30 2 * * *` (05:30 Riyadh) plus a safety slot `40 3 * * *` |
| Table | `db/migrations/20261020_guard_findings.sql` (not run) |
| Email template | `guard_alert` in `lib/lifecycle/copy.ts` (`approved: false`, category `lifecycle`) |

### Detectors (item 20)
- Spend zero: account, or a campaign that normally spends (>= 8 of the last 14 days with spend, median > 0), spent 0 yesterday. Account level wins; campaign level (max 3) only when the account did not already say it. Account = critical, campaign = high.
- Spend spike: yesterday >= 2x the 14 day median AND at least 20 (account currency) above it. Campaign spike is high only when over twice its own daily budget (Google may spend up to 2x budget on a day), otherwise medium.
- Tracking suspicion: a campaign with conversions on >= 10 of 14 days, spend and >= 3 clicks yesterday, 0 conversions. One account finding; text says check tracking first. High when those campaigns were >= 50% of the 14 day conversions, else medium.
- CPA spike (account): yesterday CPA >= 2x the 14 day CPA, >= 10 baseline conversions, >= 1 conversion yesterday. Medium.
- Ads: `ad_group_ad.policy_summary.approval_status` DISAPPROVED (high) or APPROVED_LIMITED (medium), grouped per campaign. Key contains a hash of the ad ids, so one more disapproved ad is news and the same ads are not. Escalation human.
- Account status: `customer.status` SUSPENDED / CANCELED / CLOSED, and the stored `google_status` for links the sync parked as `paused` (CUSTOMER_NOT_ENABLED), without asking Google. Critical, human.
- Billing: `billing_setup.status` all CANCELLED (none APPROVED/PENDING/APPROVED_HELD) = high; `account_budget` APPROVED with spent >= 100% of the limit = high, >= 85% = medium, ends within 3 days = medium. Fields checked against the `google-ads-api` v17 enums shipped in node_modules (CustomerStatus, BillingSetupStatus, AccountBudgetStatus, PolicyApprovalStatus) because developers.google.com pages could not be fetched.
- Changes from outside: `change_event` of the last 24h, minus ours. A change is ours only if client type is GOOGLE_ADS_API and it sits within 20 min of a timestamp in `ai_actions` (created_at, rollback_started_at, reverted_at; `approval_queued` rows ignored) or names a resource in one of our `rollback_payload`s within 6h. Grouped by actor (Google automatic, a person in the UI, an external tool). Info unless a campaign or budget changed or something was removed. If the execution log cannot be read, outside changes are "unknown", never blamed on the merchant.
- Dedupe: stable keys for conditions (`spend_zero:campaign:<id>`, `account_status:SUSPENDED`), batch hash for outside changes. A row is open while seen, resolved when a run that could READ its source no longer sees it (a failed read never closes anything), reopened and told again if it returns. Sent once (`notified_at`); only a critical one is repeated after 7 days. Info is shown on /home but never mailed.

### Diagnosis (item 2, section 11.2)
Run only on spend zero, spend spike, CPA spike and conversions zero. Order: tracking, recent changes (72h, ours labelled as ours), budget and bid limits (plus campaign state), disapprovals, auction (rank lost impression share or share drop). Output: top cause with evidence, `also_possible` list, a step in Arabic. One documented deviation: for ZERO spend, a suspended account, no live billing setup or an exhausted account budget is checked first (11.3 starts there for "الصرف وقف"). The lost impression share read is a second, conditional GAQL call, made only when an anomaly fired.

### Delivery (item 3)
- One mail per owner per Riyadh day (`guard_alert_<date>` claim in `message_log`), via `sendTemplate`, `enforceGap:false`.
- Escalation: suspension, billing, policy findings carry `escalation: 'human'`; the text says to message the agency on WhatsApp (0554235720, the existing support number from `lib/lifecycle/copy.ts`). Nothing is proposed or executed automatically. No Google Ads write exists anywhere in `lib/guard`.
- Home: a small "الحارس الصباحي" list (max 3 open findings) at the top of `/home` for owners the flag allows. Jarvis: open findings added to the account card (`input.guard`, loaded in `turn.ts`), empty array when off.

## Flags and migration
- `GUARD_ENABLED` (off). `true` all billable accounts, `operators` operators plus `GUARD_ALLOWLIST` emails. Documented in `.env.example`.
- Migration `20261020_guard_findings.sql`: table `guard_findings` (RLS, owner select only, service role writes) and column `google_ads_accounts.guard_checked_at` (used so the second scheduler slot skips accounts done in the last 18h).
- With the flag off: the route answers 200 `{"skipped":"disabled"}` before any read; `/home` and Jarvis read nothing; the account card is unchanged.

## NOT verified live
- No GAQL here ran against Google. Field names come from the v17 proto enums in node_modules and the existing `get-change-history.ts` query. To confirm on first run: filtering `ad_group_ad.policy_summary.approval_status IN (...)`, `change_event.campaign` and `change_event.change_resource_name` selection, `campaign.primary_status_reasons` as array, the billing_setup / account_budget reads on a non-admin login (each is wrapped, a permission error just makes billing "unknown").
- Google Ads API has no field for a failed card charge. "Payments failing" is therefore covered by: billing_setup cancelled, account budget exhausted, customer SUSPENDED, and spend-zero diagnosis ("billing" cause). A declined card on automatic payments with no suspension yet is NOT detectable.
- PMax asset-group policy status (`asset_group.primary_status`) is not read; only ad_group_ad (Search, Display ads).
- `SupabaseGuardStore` is exercised only through an in-memory store and a chain fake; the real PostgREST upsert on `account_id,dedupe_key` is unverified.
- Conversion lag: yesterday's conversions can still grow; the tracking and CPA texts say so but a false alarm is possible, mostly for call and offline conversions.
- Not in the tree because not readable from the account: landing page health (11.2 step 2), demand and season, Google's own platform changes.
- The mail text is unapproved: until Ayman flips `approved` on `guard_alert`, the cron records findings and shows them on /home but sends nothing (the real `sendTemplate` gate is covered by a test).

## Open decisions for Ayman
1. Approve the `guard_alert` wording (subject "تنبيه عاجل على حسابك الإعلاني" / "وش صار في حسابك الإعلاني أمس").
2. Category: it is `lifecycle`, so an owner who switched lifecycle mail off gets no alert and the 24h gap is bypassed on purpose. Suspension and billing alerts arguably belong to `transactional` (cannot be switched off, no approval gate); left as lifecycle on purpose until you decide.
3. Thresholds (2x, 20 currency units, 14 days, 10 of 14 converting days) are constants at the top of `lib/guard/detectors.ts`.
4. Should a merchant be able to dismiss a finding from /home? The table supports `dismissed`; no UI was added.
5. WhatsApp escalation to the AGENCY (not only the merchant) is not automated; the mail tells the merchant to write to 0554235720. An internal ops alert for criticals (`sendOpsAlert`) is a one-line follow-up if wanted.
6. `scheduled-jobs.yml` at the repo root is an old divergent copy; only `.github/workflows/scheduled-jobs.yml` was edited.

## Files touched
New: `lib/guard/{flag,time,types,copy,detectors,diagnose,analyze,signals,persist,notify,read,run}.ts`, `app/api/cron/guard/route.ts`, `db/migrations/20261020_guard_findings.sql`, `tests/guard-{detectors,diagnose,persist,signals,run,copy}.test.ts`, `tests/support/guard.ts`, `tests/support/guard-db.ts`, this file.
Edited: `.env.example`, `.github/workflows/scheduled-jobs.yml`, `vercel.json` (maxDuration), `lib/lifecycle/{types,copy,email-report}.ts` (copy key `guard_alert`, optional `facts.guard`), `lib/jarvis/{brain,turn}.ts` (account card lines), `app/(dashboard)/home/page.tsx` (small list).
