# Email lifecycle: build contract (14 Oct 2026)

Branch `feat/email-lifecycle-20261014`, on top of current main with #81 (welcome email) and #84 (stages + follow-ups + funnel report) already merged in commit `3f24f3c`. Read #81's `lib/messaging/*` and #84's `lib/stages/*` before you start: they are the base, not something to replace. Keep their guarantees: `claim_message` (never twice), HMAC-signed opt-out with POST confirmation, one non-transactional mail per 24 h, superseded steps, dry run.

Shared types live in `lib/lifecycle/types.ts`. The texts live in `lib/lifecycle/copy.ts`, owned by the coordinator (do not edit it; a stub with every key exists so you can compile and test).

Nothing may send unless ALL of: `EMAIL_LIFECYCLE_ENABLED=true`, `EMAIL_LIFECYCLE_ACTIVATED_AT` (config, ISO) is set, and the copy is `approved: true`. Today every copy is `approved: false` and the activation time is `null`, so the merged code sends nothing new.

## 0. Decisions already taken (do not reopen)
1. `registration_completed` is written only by `finalize_registration` (#83, already on production). The auth.users trigger from #81 is dropped: remove section 5 of `db/migrations/20261012_welcome_email.sql` (never applied anywhere) and add `drop trigger if exists on_auth_user_registered on auth.users; drop function if exists public.record_registration_completed();` to the new migration. The welcome email is sent right after a successful `finalizeRegistration` (fire-and-forget, `after()`), and the existing `/api/cron/welcome-email` sweep stays as the safety net. Remove the immediate send in `app/auth/callback/route.ts` (a Google user is not registered yet at that point).
2. The funnel stage (`users.stage`, 4 values) is unchanged. Lifecycle journeys are derived at planning time from stage + latest subscription + events. No new stage values, no new event names in `user_events`.
3. Email engagement lives in `message_log`, not in `user_events`.
4. Category opt-out: `users.email_prefs` jsonb, a missing key means "on". `messages_opt_out = true` (#81) means "every optional category off". `transactional` cannot be switched off. Hard bounce or complaint sets `users.email_suppressed_at` and then nothing at all is sent to that address, transactional included (Resend would drop it anyway and it hurts the domain).
5. Latin digits in every number (brand rule). Money via `formatMoney()` in `lib/lifecycle/format.ts`.
6. Holdout: a stable 10% of users (config `HOLDOUT_PERCENT`, hash of user id) receive no journey mail except welcome, transactional, past_due and weekly_report. The report compares them with everyone else. This is how we know the emails work.

## 1. Database: one new migration `db/migrations/20261014_email_lifecycle.sql` (agent A)
Idempotent (`if not exists`), safe to run twice, runs after `20261012_welcome_email.sql` and `20261013_user_stages.sql`.
- `users.email_prefs jsonb not null default '{}'::jsonb`
- `users.email_suppressed_at timestamptz`, `users.email_suppressed_reason text`
- `message_log`: `category text`, `copy_key text`, `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`, `complained_at` (all `timestamptz`), `click_count int not null default 0`
- index `message_log (provider_id)` and `message_log (template, sent_at)`
- drop the #81 trigger and function (see 0.1)
- Same RLS posture as #81: service role only. Update `tests/test-env-guard.test.ts` only if it counts migrations that schedule cron (this one must not).

## 2. Files and owners

### Agent A: engine (journeys, planner, runner, broadcasts, cron)
- `config/email-journeys.ts`: replaces `config/stage-followups.ts` (delete it and move its constants). Exports `JOURNEY_STEPS: Record<JourneyId, Step[]>` where `Step = { copyKey: CopyKey; afterMinutes: number; expiresAfterMinutes?: number }` (default expiry 48 h), plus `EMAIL_LIFECYCLE_ACTIVATED_AT: string | null = null`, `HOLDOUT_PERCENT = 10`, `SEND_WINDOW = { tz: 'Asia/Riyadh', startHour: 9, endHour: 22 }` (send only when local hour is in [9, 22)), `MIN_GAP_MS = 24h`, `MAX_PER_7_DAYS = 3`, `MAX_SENDS_PER_RUN = 100`, `BROADCAST_BATCH_PER_RUN = 40`, `WEEKLY_REPORT = { weekday: 0 /* Sunday */, hour: 9, windowHours: 60 }`.
  Steps (afterMinutes from journey entry):
  - registered: registered_1d 1440, registered_3d 4320, registered_7d 10080
  - connected: connected_3h 180, connected_1d 1440
  - plan_ready: plan_ready_1d 1440, plan_ready_3d 4320, plan_ready_7d 10080
  - trial: trial_d1 1440, trial_d4 5760, trial_d9 12960
  - trial_lapsed: trial_lapsed_2d 2880, trial_lapsed_14d 20160 (expiry 7 days)
  - canceled: canceled_1d 1440, canceled_30d 43200 (expiry 7 days)
  - past_due: past_due_3d 11520 (7 day grace + 1 day, so it goes out after access really stopped)
- `lib/lifecycle/journey.ts` (pure): `currentJourney(ctx) => { journey: JourneyId; enteredAt: string } | null`. Rules in priority order:
  1. latest subscription `past_due` -> past_due, entered at `current_period_start` (the unpaid period; every Stripe retry bumps `last_event_at`, so that would drift), else `last_event_at`, else `created_at`
  2. `trialing` -> trial, entered at subscription `created_at`
  3. `active` -> null (weekly report handles them)
  4. `paused` -> null
  5. `canceled`: entered when the subscription ACTUALLY became canceled (`last_event_at`, else `max(canceled_at, trial_ends_at)`; `canceled_at` is only when the cancel was requested, which for an in-app cancel is days or months earlier). If the user ever had `subscription_paid` -> canceled, else -> trial_lapsed, except a trial cut short (canceled more than 1 h before `trial_ends_at`: card or account reuse blocked by the trial guards, or support) which is null, because that person never had a trial that lapsed
  6. no subscription: stage registered -> registered (registration_completed time), connected -> connected (ads_account_connected time), analysis_viewed -> plan_ready (first_analysis_viewed time)
- `lib/lifecycle/plan.ts` (pure, the heart, generalises `lib/stages/plan.ts`): input = now, users with context, logs, config; output = sends, skips with reasons, ignored counts. Rules:
  - activation: a step whose dueAt < activatedAt is never sent (activatedAt null -> nothing)
  - expiry: a step more than its expiry past due is skipped with reason `expired`
  - superseded: as #84
  - only the current journey's steps; a user who moved on stops getting the old ones
  - send window, min gap, max per 7 days: count only `sent` rows whose category is not `transactional`; the welcome counts
  - category: the copy's category must be on in prefs; suppressed users get nothing
  - holdout users skip journey steps (reason `holdout`) except past_due; record nothing for them
  - weekly report: for users whose latest subscription is `trialing` or `active`, template key `weekly_report_<ISO year>-W<ww>` (week of the Sunday in Asia/Riyadh), due at Sunday 09:00 Riyadh, sendable for `windowHours`; one per week; obeys gap/window/prefs; not held out; offered only once this Saudi week's report exists for the person's selected account (`PlanContext.hasWeeklyReport`, read in a batch by `loadContexts` while the slot is open; otherwise the track returns `no_weekly_report`), so a missing report never stands in front of a journey step or uses up the per-run cap
  - copy unapproved -> ignored (`not_approved`), never logged
- `lib/lifecycle/context.ts`: loads users, latest subscription per user, the funnel events, message_log rows (with category), prefs, suppression. Batch queries, no N+1.
- `lib/lifecycle/run.ts`: executes the plan: for each send, `loadEmailFacts` (agent C) with the copy's `requires`; missing required fact -> mark skipped `missing_facts` via a skip write (`claim` then status skipped) so it is not retried; EXCEPT a missing `weekly` fact while the weekly slot is open (the safety net for a report that disappears between planning and sending), which writes nothing (result `skipped:weekly_pending`) so a later run retries; else `sendTemplate` (agent B). Dry run returns the plan and writes nothing.
- `lib/lifecycle/broadcast.ts` + `config/email-broadcasts.ts`: `Broadcast = { id: string; copyKey: CopyKey; segment: SegmentId; notBefore: string | null; approved: boolean }`. Segments: `all`, `registered_not_connected`, `connected_no_trial`, `trial_lapsed`, `canceled`, `subscribers`. Broadcasts ignore the per-person activation rule and holdout but never open before `EMAIL_LIFECYCLE_ACTIVATED_AT` itself (gate `not_activated`), and obey prefs (category of the copy), suppression, window, gap, max per 7 days, and `BROADCAST_BATCH_PER_RUN` per run so a list goes out gradually. Template key `broadcast_<id>`. One broadcast defined: `chat_relaunch` -> copy `broadcast_chat_relaunch`, segment `registered_not_connected`, approved false, notBefore null.
- `app/api/cron/email-lifecycle/route.ts`: replaces `app/api/cron/stage-followups/route.ts` (delete it). Same auth as the other crons (`CRON_SECRET` bearer), `?dry=1` returns the plan JSON (counts, per-template sends, ignored reasons) without writing. Runs journeys, weekly report and broadcasts in one call. 503 when `EMAIL_LIFECYCLE_ENABLED` is not `true` unless dry. Add the route to whatever the repo uses for scheduling the other crons only as a proposal file `db/proposals/20261014_email_lifecycle_cron.sql` (every 10 minutes), like #84 did.
- Remove/replace #84's now-dead code (`lib/stages/plan.ts`, `lib/stages/run-followups.ts`, `lib/stages/messages.ts`, their tests) once the new engine covers them. Keep `lib/stages/events.ts`, `types.ts`, `funnel.ts`, `load-funnel.ts` (agent C extends the report).
- Wire the welcome send after `finalizeRegistration` succeeds (see 0.1) using `sendTemplate` with copy `welcome_ads_connect`, `enforceGap: false`.
- Tests: journey selection table, planner (activation, expiry, superseded, gap, 7-day cap, window across midnight Riyadh, prefs, suppression, holdout, unapproved, weekly key and window, broadcasts batching), a 30-day simulated journey like #84's (`tests/email-lifecycle-journey.test.ts`) asserting no two non-transactional mails within 24 h and never more than 3 in 7 days.

### Agent B: delivery (render, send, links, preferences, webhook, transactional)
- `lib/lifecycle/format.ts`: `formatMoney(amount, currency)` (Latin digits, "1,250 ر.س" for SAR, otherwise the ISO code after the number), `formatNumber`, `formatDateAr(iso)` (Gregorian, Arabic month names, Latin digits, Asia/Riyadh).
- `lib/messaging/render.ts`: `renderTemplate(input: RenderInput): RenderedMessage | null`. Calls `copy.build(facts)`; null -> null. Brand shell: RTL, max width 600, paper background `#F4F2EC` outside, white card, navy `#0E1426` text and button, grey `#586174` secondary, signal yellow `#FBBC04` only as a thin 4 px bar or a single highlight (under 10% of the area), 2 px corners, no gradients, no shadows, font stack `'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif` (never Inter, never Reem Kufi). Text wordmark "مُضاعِف" at the top (no remote images in v1). Hidden preheader. Greeting "هلا {firstName}،" or "هلا،". Blocks: `p`, `stat` (big Latin number, label under it), `list`, `note` (grey small). CTA button = navy block with white text. Signature: `team` -> "فريق مُضاعِف"; `ayman` -> "أيمن أمين\nمؤسس مُضاعِف". Footer: why you got this, link to preferences, and for optional categories the one-click stop. Also produce the plain-text version (same content, links in full). Escape every text value. Tags: `template`, `category`.
- `lib/messaging/links.ts`: `trackedUrl(userId, templateKey, path)` -> `${appBaseUrl()}/m/c?u=..&k=..&p=..&s=<hmac>`. Only internal paths starting with `/` (no `//`), and add `utm_source=email&utm_medium=lifecycle&utm_campaign=<templateKey>`. `app/m/c/route.ts`: verify HMAC, set `clicked_at` (first time) and increment `click_count` on the message_log row (user_id, channel email, template), then 302 to the path. Bad signature -> 302 to `/`. Never an open redirect.
- Preferences: `lib/messaging/prefs.ts` (`isCategoryOn(prefs, optOutFlag, category)`, `updatePrefs`), page `app/email-preferences/page.tsx` + POST route: signed link (reuse #81's HMAC with a different prefix), shows the three optional categories as checkboxes in Arabic with one line each, "أوقف الكل" button, saves on POST only. #81's `/api/messages/opt-out` keeps working (one-click POST = all optional off). `List-Unsubscribe` header points at the one-click endpoint, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- `lib/messaging/send.ts`: add `sendTemplate({ user, templateKey, copy, facts, enforceGap })` that does what `send()` does today plus: suppression check, category check (prefs + `messages_opt_out`), writes `category` and `copy_key` on the log row, sends `text` alongside `html`, Resend `tags`, idempotency key `${templateKey}-${userId}`. The legacy `send()` and `lib/messaging/templates.ts` are removed (they bypassed the switches); the welcome cron sweep uses `sendTemplate` too. `lib/notifications/email.ts`: accept optional `text` and `tags`; when the caller passes a full rendered html (new shell), do not wrap it in the old `emailShell` (add a flag).
- `app/api/webhooks/resend/route.ts`: verify the Svix signature with `RESEND_WEBHOOK_SECRET` (503 when missing, 401 when invalid, tolerate 5 min clock skew). Map by `data.email_id` to `message_log.provider_id`: `email.delivered` -> delivered_at, `email.opened` -> opened_at (first), `email.clicked` -> clicked_at (first), `email.bounced` (hard bounce only, check `data.bounce.type` when present) -> bounced_at + suppress user, `email.complained` -> complained_at + suppress user + all optional categories off. Idempotent. Never 500 on an unknown email id (200 + ignored).
- Transactional: render the three Stripe emails through the new shell with copies `tx_subscription_welcome`, `tx_trial_ending` (needs `billing.trialEndsAt`), `tx_payment_failed`. Keep the exported function names in `lib/notifications/email.ts` used by `lib/billing/stripe-webhook-handler.ts` so its tests keep passing; they may now return `{ subject, html, text }`. Transactional copies ignore `approved` (they are already live; the PR review is the approval) but must still respect suppression.
- Tests: renderer (escaping, RTL, Latin digits, no em dash in fixed strings, preheader, text version), tracked link signing and redirect safety, prefs, webhook signature and mapping, sendTemplate (suppressed, category off, opt-out, gap, idempotency).

### Agent C: facts and the report
- `lib/lifecycle/facts.ts`: `loadEmailFacts(admin, user: { id, name }, needs: FactNeed[]): Promise<EmailFacts>`. Read only what `needs` asks for, all in parallel, any failure -> that fact null (never throw, never invent).
  - firstName from the user's name; businessName from `businesses` (onboarding answer) else the selected Google Ads account name.
  - plan: from `loadPlanLock` / `buildPlan` in `lib/plan` for the user's selected account (decisions total, locked count, first decision title, waste estimate and currency exactly as the plan screen computes them).
  - trial: latest `trialing` subscription (created_at, trial_ends_at, daysLeft = whole days remaining rounded UP and never negative, Asia/Riyadh), approvedCount = recommendations approved since trial start, pendingCount = recommendations still waiting for the user: `pending` and `approved` (not executed yet), the statuses /home lists (`OPEN_DECISION_STATUSES` in `lib/plan/load.ts`).
  - weekly: latest `reports` row generated in the CURRENT Saudi week (Saturday 00:00 UTC onward, the week the optimize cron dedupes on) by the optimize cron for the user's selected account: period (the 7 days the data covers: ending the day before generation in Riyadh, not the stored `period_end`), spend, conversions, cost per conversion, previous week, up to 3 highlight lines from its narrative, plus pendingCount.
  - billing: plan name and trial end of the latest subscription.
- Record `first_analysis_viewed` where the plan is seen now: the "خطتك جاهزة" screen at the end of `/onboarding` and the locked plan in `/home` (`app/(dashboard)/home/locked-home.tsx` or its server page), with `after()` like #84 did in `/audit`. Server side only.
- Funnel report `/operations/funnel`: add an "الإيميل" section: per template key (weekly keys grouped as weekly_report): sent, delivered, opened, clicked, opt-outs after it, bounced, and "reached next stage within 7 days" for recipients vs holdout users in the same journey (holdout membership from the same hash function agent A exports as `isHoldout(userId)` in `lib/lifecycle/holdout.ts`; if A has not written it, write it there with that exact name: sha256(userId) first 4 bytes as uint32 % 100 < HOLDOUT_PERCENT). CSV export gets the same section.
- Tests for each fact loader with a fake admin (`tests/support/fake-admin.ts` exists), null on failure, and the report math on hand-counted fixtures.

## 3. Rules for every agent
- TypeScript strict, no `any` in new code unless the surrounding #81/#84 code already uses it for the admin client.
- Arabic UI strings: Saudi dialect, short, no em dash or en dash, Arabic comma, Latin digits.
- Do not touch files owned by another agent. If you need a change there, write it in your final message.
- Do not push, do not open a PR, do not touch Supabase/Vercel/Resend. Commit on your worktree branch.
- Before you finish: `pnpm typecheck`, `pnpm lint`, `pnpm test` green. Report: files, decisions, anything you could not verify.
