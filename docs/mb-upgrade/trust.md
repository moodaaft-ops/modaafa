# Trust and autonomy (media buyer upgrade, items 5, 41, 42, 45, 47, 48)

Branch `feat/mb-trust`. Everything below ships dark. Every flag defaults to off and is documented in `.env.example`. With a flag off the behaviour is unchanged (each hook is a single flag check).

## What was built

### 1. Landing page check (`LANDING_CHECK_ENABLED`)
- `lib/landing-check/`: `ssrf.ts` (URL and IP rules), `fetch.ts` (guarded fetch: https only, DNS checked per hop, 3 redirects, 5s, 1.5MB, no cookies, custom UA), `transport.ts` (pinned-address https transport, the only code that touches the network), `analyze.ts` (title, H1, viewport, GA4, Google tag AW-, GTM, Clarity, Meta, TikTok, Snap, WhatsApp, tel, smart link `/w/`, message match), `findings.ts` (Arabic findings with the step), `sources.ts` (GAQL for final URLs and top keywords), `run.ts` (orchestration, weekly limit, tracking evidence), `store.ts`.
- Jarvis read tool `get_landing_check` (registered only with the flag). Its result carries `tracking_evidence` (tag present or not, "unknown via GTM" when a tag may live inside GTM).
- At most once per 7 days per account.

### 2. Offer and response coaching (`OFFER_COACHING_ENABLED`)
- `lib/coaching/response-coaching.ts`: three rule detectors (good CTR plus many WhatsApp clicks plus low customer rate; traffic quality from "not serious" share; conversion rate drop against the account's own history). Hedged Najdi wording.
- Jarvis read tool `get_response_coaching`.
- `coachingLinesForReport(insights)` is the hook for the monthly report. The monthly report is not in this branch (it lives in the loops worktree), so it is NOT wired. One call after merge.

### 3. Autonomy levels (`AUTONOMY_LEVELS_ENABLED`, plus the existing `AUTOPILOT_EXECUTION_ENABLED`)
- `lib/autopilot/autonomy.ts`: levels `ask_all` (default) and `small_and_notify`; `hardCeilingViolations`, `evaluateBudgetShift`, `evaluateAutonomy`, `applyAutonomyLevel`. All pure.
- Small level executes only: exact negatives (campaign level, 0 conversions, cost at least 2x the owner's allowable CPA) and keyword pauses (the existing proposal gate: 0 conversions, 20+ clicks, cost at least 2x). The yardstick must be the owner's own break-even; the account's own CPA is not accepted for an unapproved change.
- Hard ceilings regardless of level: any type outside those two is queued; target keys, billing and policy keys reject; non-exact negatives reject; a budget shift that raises the total by even one micro is rejected.
- Still required: mode `conservative`, healthy tracking, confidence, daily limit, cooldown, the kill switch, and all existing guardrails (`checkGuardrails`, validateOnly, readback, rollback payload).
- Every auto action emails the owner (`autonomy-notify.ts`) with a pointer to "التغييرات الأخيرة" (the existing undo, 30-day window).
- Level stored in its own table, so the `save_autopilot_settings` RPC is untouched. UI: radio group in the autopilot settings form, shown only with the flag and in conservative mode.
- With the flag on, `ask_all` downgrades every execute verdict to queue. The migration backfills `small_and_notify` for accounts already in conservative mode so they keep what they opted into.

### 4. Agency handoff (`AGENCY_HANDOFF_ENABLED`)
- `lib/handoff/`: rules (spend over threshold, suspended or Google-disabled, repeated policy, merchant asked), prefilled WhatsApp summary (same number as support), store, signals.
- Threshold in `lib/landing/owner-config.ts` (`handoff`): 15000 SAR per 30 days and 3 flagged ads. These are placeholders for Ayman to set (see open decisions).
- Card «خلّ فريق مُضاعفة يمسكه» in the dashboard layout. The tap opens WhatsApp and records the request (`POST /api/handoff/request`).
- Operator tab `/operations/handoff` (open items, the ones who asked first, a "تم التواصل" button).
- Spend and policy are refreshed from the hourly optimizer run (best effort). Suspension and the merchant's request are read live, because the optimizer skips suspended accounts.

### 5. Shadow mode (`SHADOW_MODE_ENABLED`)
- Tables `shadow_accounts`, `shadow_decisions` (`executable` is forced false by a CHECK, and the rows are not in `recommendations`), `shadow_reviews`. No owner policy and no grant to anon or authenticated: service role only.
- Optimizer cron: a shadow account is analysed as usual, the proposals are stored in `shadow_decisions`, and the loop returns before the policy gate, the approval queue and any executor.
- `checkGuardrails` (used by the cron, the autopilot executor and the approval handler) refuses every action on a shadow account. If the shadow state cannot be read it fails closed. A missing table counts as "not shadow".
- `/operations/shadow`: mark or unmark by customer id, decisions with صح / غلط and a note, "فاتك شي" with a category, weekly agreement (agree % of reviewed, coverage, misses and wrongs by category), this week and last.

## Flags
`LANDING_CHECK_ENABLED`, `OFFER_COACHING_ENABLED`, `AUTONOMY_LEVELS_ENABLED`, `AGENCY_HANDOFF_ENABLED`, `SHADOW_MODE_ENABLED` (all `true` to enable, anything else is off).

## Migrations (not run)
- `db/migrations/20261020_trust_landing_checks.sql`
- `db/migrations/20261020_trust_autonomy_levels.sql`
- `db/migrations/20261020_trust_agency_handoff.sql`
- `db/migrations/20261020_trust_shadow_mode.sql`

All idempotent, RLS on, same owner-select pattern as `autopilot_settings` where the owner reads.

## Not verified live
- The pinned https transport and DNS against real sites (tests use mocks). First run on a real account should be watched.
- GAQL for final URLs, keywords and the policy-flagged count against a real account.
- The autonomy path end to end (email delivery, readback of a keyword pause, rollback of a pause).
- That the optimizer's account selection reaches agency shadow accounts (entitlement filtering applies to them like any account; an operator-owned account probably passes).
- The `shadow_reviews` upsert on the unique index and the operator pages against a real database.
- `checkGuardrails` is the single choke point for the three execution paths I found. Other write paths (for example Jarvis write tools) were not audited here and should be checked before an agency account is marked shadow.

## Not built
- Budget moves between campaigns under the small level. The pure rule (`evaluateBudgetShift`, with property tests) exists, but a shift is two mutations and needs an atomic pair with rollback of the first when the second fails. That needs a live test, so the small level queues every `adjust_budget`.
- A third level. The brief listed two named levels plus "nothing beyond", so there are two. Say if a third was meant.
- Monthly report line (the report is in another branch).
- Feeding the landing evidence into the optimizer snapshot's tracking verdict. It is exposed to Jarvis through `tracking_evidence`; changing the verdict itself touches the tracking module another branch owns.

## Open decisions for Ayman
1. Handoff thresholds (15000 SAR per 30 days, 3 flagged ads) are placeholders.
2. When `AUTONOMY_LEVELS_ENABLED` goes on, accounts without a level row ask for everything. The migration keeps current conservative accounts on the small level. Confirm this is the intent.
3. The undo notice is an email pointing to "التغييرات الأخيرة". Say if you want it also as a WhatsApp or an in-app notice.
4. Shadow accounts: confirm they should be linked under an operator user, and that the optimizer should keep running on them hourly.
5. The handoff policy rule counts ads that are disapproved right now, not a history of repeats (no history is stored).

## Files touched
New: `lib/landing-check/*`, `lib/coaching/*`, `lib/handoff/*`, `lib/shadow/*`, `lib/autopilot/autonomy.ts`, `lib/autopilot/autonomy-notify.ts`, `lib/autopilot/autonomy-store.ts`, `lib/jarvis/tools/get-landing-check.ts`, `lib/jarvis/tools/get-response-coaching.ts`, `app/api/handoff/request/route.ts`, `app/api/operations/handoff/route.ts`, `app/api/operations/shadow/route.ts`, `app/(dashboard)/agency-handoff-card.tsx`, `app/(dashboard)/agency-handoff-link.tsx`, `app/(dashboard)/operations/handoff/*`, `app/(dashboard)/operations/shadow/*`, the four migrations, `tests/trust-*.test.ts` (landing-ssrf, landing-analyze, landing-run, response-coaching, autonomy, handoff, shadow), this file.

Edited: `lib/jarvis/tools/index.ts`, `lib/autopilot/executor.ts` (type guard widened for the autonomy verdict only), `lib/ai/optimizer-agent.ts` (shadow check at the top of `checkGuardrails`), `app/api/cron/optimize/route.ts` (autonomy verdict, shadow branch, handoff refresh, notice), `app/api/autopilot/settings/route.ts`, `app/(dashboard)/autopilot/page.tsx`, `app/(dashboard)/autopilot/autopilot-settings-form.tsx`, `app/(dashboard)/layout.tsx`, `app/(dashboard)/operations/ops-ui.tsx` (two tabs, flag-gated), `lib/landing/owner-config.ts` (`handoff` block), `.env.example`.
