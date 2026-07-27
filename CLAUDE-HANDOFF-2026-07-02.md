# Claude Handoff — Moodaaft Ads AI

تاريخ التسليم: 2026-07-02  
المشروع: Moodaaft Ads AI / مُضاعِف  
المستودع المحلي: `/Users/aimanamin/Documents/GitHub/modaafa`  
الإنتاج: `https://ai.modaafa.com`  
حساب المتصفح الصحيح: Chrome profile `مُضاعفة`، Google account `moodaaft@gmail.com`  

> اقرأ هذا الملف أولاً. لا تبدأ من الصفر، ولا تطلب من المستخدم إعادة شرح المشروع. المستخدم غاضب لأن مشكلة ربط Google Ads لم تُحل بعد، ويحتاج تنفيذًا عمليًا كاملًا لا كلامًا عامًا.

## Copy/Paste Prompt For Claude

أنت الآن تستلم تنفيذ منصة SaaS اسمها Moodaaft Ads AI / مُضاعِف لإدارة Google Ads بالذكاء الاصطناعي. افتح المستودع:

`/Users/aimanamin/Documents/GitHub/modaafa`

استخدم دائمًا Chrome profile باسم `مُضاعفة` لأي عمل Browser / Google Cloud / Google Ads OAuth، والحساب الصحيح هو `moodaaft@gmail.com`.

لا تطبع ولا تكشف أي أسرار أو قيم `.env` أو مفاتيح API أو refresh tokens. اقرأ أسماء المتغيرات فقط عند الحاجة. لا تعمل `git reset` ولا ترجع تغييرات موجودة؛ الشجرة فيها تغييرات كثيرة غير ملتزمة ويجب التعامل معها كما هي.

أهم مشكلة الآن: ربط Google Ads لا يزال يفشل أو يعلق عند موافقة Google. المستخدم رأى:

- `/onboarding/connect?error=state_mismatch`
- صفحة Google consent على `accounts.google.com` باهتة/معلقة عند "تم طلب الإذن بالوصول إلى حسابك على Google من modaafa.com"
- تحذير Google: التطبيق غير موثق / لم تثبت Google ملكية التطبيق
- الحسابات ترتبط أحيانًا لكن أسماء حسابات Google Ads لا تظهر كما يجب

مطلوب منك: شخّص المشكلة من النهاية للنهاية، أصلح الكود أو إعدادات الدومين/OAuth المطلوبة، انشر على Vercel، ثم اختبر الربط من Chrome profile `مُضاعفة` حتى يظهر الحساب مرتبطًا داخل الداشبورد. إذا كانت المشكلة خارجية في Google Cloud verification، اثبت ذلك بدليل واضح وجهّز بالضبط ما يحتاجه المستخدم لإكمال التحقق.

## Product Context

المنصة SaaS عربي أولاً تتيح للمستخدم:

1. تسجيل الدخول بحساب Google.
2. ربط Google Ads بموافقة واحدة.
3. سحب كل الحسابات الإعلانية التي يملكها البريد أو يديرها عبر MCC.
4. اختيار الحساب المطلوب من الداشبورد.
5. عرض حملات، تقارير، فحص حساب، توصيات، ومساعد ذكاء اصطناعي.
6. لاحقًا تنفيذ تغييرات على Google Ads عبر مركز موافقات، وليس تعديلات مباشرة عمياء.

المستخدم يريد تجربة شبيهة بـ Codex داخل SaaS: عميل يسأل صوتيًا/كتابيًا والمنصة تفهم حسابه وتدير الحملات باحتراف.

## Current Repo State

- Next.js 14 App Router + TypeScript + Tailwind.
- Supabase auth/database/RLS.
- Google Ads عبر REST wrapper مخصص في `lib/google-ads/client.ts`.
- Anthropic SDK للمساعد والوكلاء.
- Stripe/Moyasar للفوترة.
- Vercel project linked locally: `modaafa`.
- Production alias: `https://ai.modaafa.com`.
- Latest known deploy made by Codex: `dpl_4Gg7z16xSK4ZbGYT3pP94L7cRJ5L`, aliased to `https://ai.modaafa.com`.
- Latest health check returned: `{"ok":true,"service":"modaafa"}`.

There is a dirty working tree with many modified/untracked files. Do not reset it. Treat it as the active project state.

## Safety Rules

- Do not print `.env`, `.vercel/.env.production.local`, Supabase keys, Stripe keys, Google OAuth secrets, Google Ads developer token, refresh tokens, or OIDC tokens.
- Do not run destructive Git commands.
- Do not pull metrics from MCC/manager account `7561141000`; use a non-manager child account for performance reports.
- If using browser, use Chrome profile `مُضاعفة` only.
- If changing Google Ads budgets/campaigns later, use validate-only first and require user approval.

## Important Local Runtime Notes

On this machine, `npm` may not be on PATH in shell sessions. Use bundled Node or local binaries:

```bash
/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit
PATH="/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/next/dist/bin/next build
```

Vercel CLI has been found at:

```bash
/Users/aimanamin/Library/pnpm/store/v11/links/@/vercel/54.18.6/fa77fdbcd2c033c6efdd8a9baee09ea297bcbe5d8619731d68d92c8583b4cc58/node_modules/vercel/node_modules/.bin/vercel
```

Deployment command used:

```bash
PATH="/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/aimanamin/Library/pnpm/store/v11/links/@/vercel/54.18.6/fa77fdbcd2c033c6efdd8a9baee09ea297bcbe5d8619731d68d92c8583b4cc58/node_modules/vercel/node_modules/.bin/vercel --prod --yes
```

## OAuth Architecture

There are two separate Google OAuth flows.

### Google Login

Files:

- `app/api/auth/google/login/route.ts`
- `app/api/auth/google/callback/route.ts`
- `lib/auth/google-login.ts`
- `lib/auth/google-login-callback.ts`

Scopes:

- `openid`
- `email`
- `profile`

Expected redirect URI:

`https://ai.modaafa.com/api/auth/google/callback`

### Google Ads Connection

Files:

- `app/api/auth/google-ads/connect/route.ts`
- `app/api/auth/google-ads/callback/route.ts`
- `lib/google-ads/oauth.ts`
- `lib/auth/google-ads-oauth-state.ts`

Scope:

- `https://www.googleapis.com/auth/adwords`

Expected redirect URI:

`https://ai.modaafa.com/api/auth/google-ads/callback`

## What Codex Recently Changed

### 1. Google Ads OAuth State

Added:

- `lib/auth/google-ads-oauth-state.ts`

Changed:

- `app/api/auth/google-ads/connect/route.ts`
- `app/api/auth/google-ads/callback/route.ts`

Intent:

- Before: only one `gads_oauth_state` value was stored. Multiple tabs or repeated OAuth attempts overwrote it and caused `state_mismatch`.
- After: stores up to 8 pending states in a base64url JSON cookie and accepts any valid pending state.

User says the issue is still not solved. Do not assume this fix is sufficient. Reproduce from a clean flow and inspect cookies/network.

### 2. Fallback Business Creation During Ads Callback

Changed:

- `app/api/auth/google-ads/callback/route.ts`

Intent:

- If callback succeeds before the user has a `businesses` row, create a minimal business instead of redirecting to `/onboarding/business?error=no_business` and losing the OAuth result.

Validate this under RLS/service role behavior.

### 3. Assistant Context

Previously changed files:

- `app/api/chat/assistant/route.ts`
- `app/(dashboard)/assistant/assistant-client.tsx`

Intent:

- Send chat history and reuse `sessionId`; avoid repetitive fallback replies.

Still verify that `ANTHROPIC_API_KEY` exists in Vercel production. If missing, assistant falls back to deterministic canned answers.

## Current Failing User Symptoms

Latest user screenshots/messages show:

1. After consent or returning from Google:
   - `https://ai.modaafa.com/onboarding/connect?error=state_mismatch`
   - Arabic message: `انتهت جلسة الربط. أعد المحاولة.`

2. Google consent screen:
   - URL begins with `https://accounts.google.com/signin/oauth/v2/consentsummary...`
   - Shows app domain as `modaafa.com`.
   - Shows warning that app has not been verified.
   - Page appears faded/stuck and button may be disabled.
   - It also mentioned privacy/terms visibility problem around `modaafa.com`.

3. Account names:
   - Accounts may appear as IDs or generic names instead of real customer names.
   - Local Google Ads CLI previously proved some names exist, for example account `4201238455` = `الصفرات`.

## Highest Priority Investigation

### A. Reproduce OAuth Cleanly

Use Chrome profile `مُضاعفة`.

1. Close old Google OAuth tabs or start from a new tab.
2. Open `https://ai.modaafa.com/onboarding/connect`.
3. Click `بدء الربط التلقائي`.
4. Confirm:
   - `Set-Cookie: gads_oauth_state=...`
   - Google URL contains `client_id=471126127155-dbcpdn7ncb6td7a4efkovopn05mdbi59.apps.googleusercontent.com`
   - `redirect_uri=https%3A%2F%2Fai.modaafa.com%2Fapi%2Fauth%2Fgoogle-ads%2Fcallback`
   - `scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadwords`
5. After Google returns, inspect:
   - callback URL `state=...`
   - request Cookie header includes `gads_oauth_state`
   - callback route does not redirect `state_mismatch`

If cookie not present, inspect domain/path/SameSite behavior.

### B. If State Still Fails, Prefer Server-Side State Storage

The current cookie multi-state fix may not be enough. Stronger fix:

- Store OAuth state server-side in Supabase table, e.g. `oauth_states`.
- Fields: `state_hash`, `user_id`, `purpose`, `created_at`, `expires_at`, `used_at`, `return_to`.
- Cookie only stores an opaque session id or not needed if callback state includes a signed nonce.
- On callback, validate by state against DB and user session or signed payload.
- Mark state used.

This removes brittle multi-tab cookie behavior.

### C. Google Consent Hang / Verification

Do not treat this as solved by code until verified.

Check Google Cloud Console from Chrome profile `مُضاعفة`:

- Project currently seen as `Claude`, project id from previous URL: `gen-lang-client-0852490291`.
- Branding page was previously observed with:
  - App name: `Moodaaft Ads AI`
  - Support email: `moodaaft@gmail.com`
  - Home page: `https://ai.modaafa.com`
  - Privacy: `https://ai.modaafa.com/privacy`
  - Terms: `https://ai.modaafa.com/terms`
  - Authorized domain includes `modaafa.com`
  - Verification status under review.

But Google consent screen still displays `modaafa.com` and can warn about privacy/terms. Earlier checks showed:

- `https://ai.modaafa.com/privacy` works.
- `https://ai.modaafa.com/terms` works.
- `https://modaafa.com/privacy` may 404.
- `https://modaafa.com/terms` may 404.

Action:

- Verify root domain pages now. If root pages 404, create Hostinger/WordPress redirects or static pages:
  - `https://modaafa.com/privacy` -> `https://ai.modaafa.com/privacy`
  - `https://modaafa.com/terms` -> `https://ai.modaafa.com/terms`
  - possibly `https://modaafa.com` -> landing/home or `https://ai.modaafa.com`
- Update Google OAuth branding if it requires root-domain privacy/terms URLs.
- Ensure OAuth consent app is in production or add all test users while testing.
- If Google verification is required for external users, prepare exact verification package: homepage, privacy, terms, screencast showing sign-in and Google Ads use, justification for adwords scope.

### D. Account Names Not Showing

Key files:

- `lib/google-ads/client.ts`
- `lib/accounts/display.ts`
- `lib/accounts/metadata-repair.ts`
- `app/api/accounts/repair-names/route.ts`
- `app/(dashboard)/account-switcher.tsx`

Things to verify:

1. `discoverAccessibleCustomers(refreshToken)` gets child rows with `customer_client.descriptive_name`.
2. For direct account metadata, `getCustomerMetadataWithFallback` queries:
   - without login customer id
   - with manager ids from discovered accounts
   - with configured manager ids
3. The REST response uses camelCase or snake_case; code supports both via `pickString`.
4. Database `google_ads_accounts.customer_name` is being updated after repair.
5. UI is not showing fallback because `isGeneratedFallbackName` thinks real names are generated.

Use local Google Ads CLI to validate real names:

```bash
google-ads clients
```

Important: do not query metrics from manager account `7561141000`.

## Files Map

Core OAuth:

- `app/api/auth/google-ads/connect/route.ts`
- `app/api/auth/google-ads/callback/route.ts`
- `lib/auth/google-ads-oauth-state.ts`
- `lib/google-ads/oauth.ts`
- `lib/auth/google-login.ts`
- `lib/auth/google-login-callback.ts`

Google Ads API:

- `lib/google-ads/client.ts`
- `lib/google-ads/sync.ts`
- `lib/google-ads/audit-queries.ts`

Accounts:

- `lib/accounts/selection.ts`
- `lib/accounts/display.ts`
- `lib/accounts/metadata-repair.ts`
- `app/(dashboard)/account-switcher.tsx`
- `app/api/accounts/sync/route.ts`
- `app/api/accounts/repair-names/route.ts`
- `app/api/accounts/select/route.ts`
- `app/api/accounts/rename/route.ts`

Dashboard:

- `app/(dashboard)/layout.tsx`
- `app/(dashboard)/dashboard/page.tsx`
- `app/(dashboard)/assistant/page.tsx`
- `app/(dashboard)/assistant/assistant-client.tsx`
- `app/(dashboard)/campaigns/page.tsx`
- `app/(dashboard)/audit/page.tsx`
- `app/(dashboard)/settings/page.tsx`

AI:

- `lib/ai/client.ts`
- `lib/ai/audit-agent.ts`
- `lib/ai/builder-agent.ts`
- `lib/ai/optimizer-agent.ts`
- `app/api/chat/assistant/route.ts`

Billing:

- `lib/billing/stripe.ts`
- `lib/billing/moyasar.ts`
- `app/api/billing/checkout/route.ts`
- `app/api/billing/portal/route.ts`
- `app/api/webhooks/stripe/route.ts`

Security/delete account:

- `app/api/account/delete/route.ts`
- `db/schema.sql`

Readiness:

- `lib/platform/env.ts`
- `lib/platform/readiness.ts`
- `app/api/health/route.ts`

## Required Environment Variables

Do not print values. Verify existence only:

- `NEXT_PUBLIC_APP_URL` should be `https://ai.modaafa.com`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI` should be `https://ai.modaafa.com/api/auth/google-ads/callback`
- Optional but recommended: `GOOGLE_LOGIN_REDIRECT_URI=https://ai.modaafa.com/api/auth/google/callback`
- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
- `GOOGLE_ADS_MCC_CUSTOMER_ID`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENCRYPTION_KEY`
- `ANTHROPIC_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CRON_SECRET`
- `GOOGLE_OAUTH_APP_VERIFIED` only becomes true after Google verification.

## Google Cloud OAuth Checklist

Authorized redirect URIs must include:

```text
https://ai.modaafa.com/api/auth/google/callback
https://ai.modaafa.com/api/auth/google-ads/callback
```

Authorized JavaScript origins should include:

```text
https://ai.modaafa.com
https://modaafa.com
```

Authorized domains should include:

```text
modaafa.com
```

Branding URLs should be reachable publicly:

```text
https://ai.modaafa.com
https://ai.modaafa.com/privacy
https://ai.modaafa.com/terms
```

If Google insists on root app domain, also make these work:

```text
https://modaafa.com
https://modaafa.com/privacy
https://modaafa.com/terms
```

## Verification Commands

Local:

```bash
/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit

PATH="/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/next/dist/bin/next build
```

Production health:

```bash
curl -fsS https://ai.modaafa.com/api/health
```

Deploy:

```bash
PATH="/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  /Users/aimanamin/Library/pnpm/store/v11/links/@/vercel/54.18.6/fa77fdbcd2c033c6efdd8a9baee09ea297bcbe5d8619731d68d92c8583b4cc58/node_modules/vercel/node_modules/.bin/vercel --prod --yes
```

Google Ads local:

```bash
google-ads clients
```

## Suggested First 90 Minutes

1. Open repo and read this file plus `CODEX-HANDOFF.md`.
2. Run `git status --short`; do not reset.
3. Run typecheck/build.
4. Verify `https://ai.modaafa.com/api/health`.
5. Use Chrome profile `مُضاعفة` to reproduce OAuth from a clean tab.
6. Inspect network/cookies for `gads_oauth_state`.
7. If `state_mismatch` persists, implement server-side OAuth state table and deploy.
8. If Google consent page remains disabled/stuck, inspect Google Cloud branding/verification and root `modaafa.com` privacy/terms pages.
9. Verify account name repair with live API and DB update.
10. Report to user in Arabic with exact facts, not guesses.

## What To Tell The User After First Pass

Be direct:

- If fixed: show exact flow tested, account linked, number of accounts, whether names appear.
- If Google verification blocks: say it is external, show exact Google Cloud status and exact missing item.
- If state/cookie code blocks: fix and deploy; do not ask the user to repeat old attempts until the new deploy is live.

## Known User Preference

The user does not want repeated "try again" loops. They expects the engineer to:

- take ownership,
- use the right Chrome profile,
- not ask for secrets already present,
- not expose secrets,
- deploy and verify,
- speak Arabic clearly and concretely.

