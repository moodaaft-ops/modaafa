# تقرير تسليم هندسي — منصة مُضاعِف (Moodaaft Ads AI)
**Handoff report for Codex / next engineer**

- التاريخ: 2026-07-01
- المستودع: `/Users/aimanamin/Documents/GitHub/modaafa`
- الفرع: `main`
- الإنتاج: https://ai.modaafa.com — منشور على Vercel (مشروع `modaafa`)
- الحالة: `tsc --noEmit` ✅ نظيف. يوجد refactor كبير غير مُلتزم في working tree (لا تعمل `git reset`).

> ملاحظة أمان: لا تطبع أي `.env` أو أسرار. أسماء المتغيّرات فقط مذكورة هنا (وهي أصلاً معرّفة في `app/api/health/route.ts`).

---

## 1) نظرة عامة على النظام (Stack)
- **Next.js 14.2.15** (App Router) + **TypeScript** + **TailwindCSS** (عربي أولاً، `dir="rtl"`, خط IBM Plex Sans Arabic).
- **Supabase** (`@supabase/ssr`) للمصادقة والبيانات + RLS.
- **Anthropic SDK** لوكلاء الذكاء (audit / builder / optimizer / assistant).
- **Google Ads** عبر **REST wrapper مخصّص** (وليس gRPC — انظر ملاحظة حرجة أدناه).
- **Stripe** + **Moyasar** للفوترة.
- إدارة الحزم: **pnpm** (يوجد `pnpm-lock.yaml`). Node ≥ 20.

### ملاحظة معمارية حرجة
`lib/google-ads/client.ts` **يستبدل عميل `google-ads-api` gRPC بـ REST** لأن gRPC يفشل على Vercel بـ `UNIMPLEMENTED: GRPC target method can't be resolved`. الدالة `getCustomer()` تُرجع كائناً يحاكي شكل `Customer` لكنه ينفّذ عبر `googleads.googleapis.com/v24/...:search` و`:mutate`. أي كود جديد يتعامل مع Google Ads يجب أن يمر عبر هذا الـ wrapper، لا عبر gRPC.

---

## 2) تصميم OAuth المزدوج (مهم جداً — لا تخلط بينهما)

### تدفق A — تسجيل الدخول (Google Sign-In)
- بدء: `GET /api/auth/google/login` → `lib/auth/google-login.ts::getGoogleLoginClient`
- Scopes: `openid email profile`
- State cookie: `modaafa_google_login_state`
- Callback: `GET /api/auth/google/callback` → `lib/auth/google-login-callback.ts::handleGoogleLoginCallback`
- Redirect URI الإنتاجي: `https://ai.modaafa.com/api/auth/google/callback`

### تدفق B — ربط Google Ads
- بدء: `GET /api/auth/google-ads/connect` → `lib/google-ads/oauth.ts::buildAuthUrl`
- Scope: `https://www.googleapis.com/auth/adwords` (وحيد ومبرّر)
- State cookie: `gads_oauth_state`
- Callback: `GET /api/auth/google-ads/callback`
- Redirect URI الإنتاجي: `https://ai.modaafa.com/api/auth/google-ads/callback`

**نقطة مهمة:** الـ ads callback يحتوي fallback دفاعي: إذا تطابق الـ state مع cookie الدخول (`isGoogleLoginCallback`) فإنه يفوّض لـ `handleGoogleLoginCallback`. هذا مقصود ولا يجب حذفه.

---

## 3) خريطة الملفات حسب المحور

| المحور | الملفات الأساسية |
|---|---|
| OAuth دخول | `app/api/auth/google/{login,callback}/route.ts`, `lib/auth/google-login.ts`, `lib/auth/google-login-callback.ts` |
| OAuth ربط Ads | `app/api/auth/google-ads/{connect,callback,select-account}/route.ts`, `lib/google-ads/oauth.ts`, `lib/auth/google-ads-pending-cookie.ts` |
| Google Ads client | `lib/google-ads/client.ts` (`discoverAccessibleCustomers`, `getCustomerMetadataWithFallback`, `googleAdsSearch`, `getCustomer`) |
| المزامنة | `lib/google-ads/sync.ts` (`syncCampaignCache`) |
| الحسابات | `lib/accounts/{selection,display,metadata-repair}.ts` |
| APIs الحسابات | `app/api/accounts/{select,sync,rename,repair-names}/route.ts` |
| المساعد | `app/api/chat/assistant/route.ts`, `app/(dashboard)/assistant/{page,assistant-client}.tsx` |
| عميل AI | `lib/ai/client.ts` |
| حذف الحساب | `app/api/account/delete/route.ts` |
| UX تحميل | `lib/ui/{route-progress,pending-submit-button}.tsx`, `app/(dashboard)/account-switcher.tsx`, ملفات `loading.tsx` |
| جاهزية/صحة | `lib/platform/{readiness,env}.ts`, `app/api/health/route.ts` |
| بوابة المسارات | `middleware.ts` |
| السكيمة | `db/schema.sql` |

---

## 4) حالة كل محور بعد الفحص

### 4.1 Google OAuth — ✅ أُصلح
- **الجذر لـ `redirect_uri_mismatch`**: رابط رجوع الدخول كان يُشتق من `origin`، فيختلف عند النطاقات غير الأساسية (`*.vercel.app`). **أُصلح** (انظر §5.1).
- التدفقان منفصلان صحيحاً (scopes/cookies/callbacks). لا خلط.

### 4.2 Google verification — 🔶 خارج الكود
- Scope وحيد مبرّر (`adwords`). صفحتا `app/privacy/page.tsx` و`app/terms/page.tsx` موجودتان بمحتوى فعلي. صفحة رئيسية `app/page.tsx` موجودة.
- حالة "under review / not yet verified" = مراجعة Google، **ليست خطأ كود**. `lib/platform/readiness.ts` يوثّق هذا بوضوح (بند `google_oauth_verification`).

### 4.3 أسماء حسابات Google Ads — ✅ سليم (لا تعديل)
- تُقرأ من `customer.descriptive_name` و`customer_client.descriptive_name` مع camelCase الخاص بـ REST (`pickString(x,'descriptiveName','descriptive_name')`).
- `getCustomerMetadataWithFallback` يجرّب عدة `login-customer-id` (null ثم managers المُعدّة) ويُرجع أول نتيجة باسم.
- الاسم الاحتياطي في الواجهة: "حساب إعلاني غير مُسمّى" (`lib/accounts/display.ts`).
- إصلاح تلقائي (`/api/accounts/repair-names`) + تسمية يدوية (`/api/accounts/rename`) + رسائل واضحة في `account-switcher.tsx::friendlySyncError` لـ `USER_PERMISSION_DENIED` / `CUSTOMER_NOT_ENABLED` / `REQUESTED_METRICS_FOR_MANAGER` / refresh token revoked.
- الحساب `4201238455` يظهر باسمه "الصفرات" عند توفّر صلاحية القراءة.

### 4.4 المساعد الذكي — ✅ أُصلح
- **الجذر لـ"الردود المكررة/الغبية"**: (1) لم يكن يمرّر تاريخ المحادثة إطلاقاً؛ كل رسالة مستقلة. (2) ينشئ جلسة جديدة لكل رسالة. (3) عند غياب `ANTHROPIC_API_KEY` يعمل بوضع fallback قالبي (`buildDeterministicReply`). **أُصلحت (1) و(2)** (انظر §5.2). (3) قرار بيئة.
- المصادر المستخدمة فعلاً: الحساب المختار + `campaigns_cache` (metrics_7d) + آخر `audit` + `recommendations` + سؤال المستخدم. مؤكَّد.

### 4.5 الحسابات المتعددة — ✅ سليم (لا تعديل)
- `discoverAccessibleCustomers` يمشي شجرة MCC كاملة (عمق حتى 8)، آمن من metrics المدير، ويجمع المباشر + الأبناء.
- OAuth callback يربط **كل** حساب غير إداري تلقائياً ويحوّل للداشبورد (المسار القديم `onboarding/select-account` ما زال موجوداً لكنه شبه مُهمَل — مرشّح تنظيف).
- `account-switcher.tsx`: بحث + تبديل (cookie `modaafa_selected_customer_id`) + مزامنة + إصلاح أسماء + حالات تحميل.

### 4.6 UX / حالات التحميل — ✅ سليم (لا تعديل)
- `RouteProgress` (شريط علوي عام عند كل نقرة رابط داخلي) — يعالج شكوى "التعليق".
- `PendingSubmitButton` (عبر `useFormStatus`) لكل الفورمز المهمة.
- `loading.tsx` skeletons للداشبورد والـ onboarding.
- عربي أولاً بالكامل (`app/layout.tsx`: `<html lang="ar" dir="rtl">`).
- مسار المستخدم الجديد موجّه: `onboarding/page.tsx` يوزّع (business → connect → dashboard) حسب الحالة.

### 4.7 حذف الحساب — ✅ سليم (لا تعديل)
- `app/api/account/delete/route.ts`: يتطلب تأكيد "حذف حسابي"، يُبطل Google refresh tokens (`revokeRefreshToken`)، يلغي اشتراكات Stripe، يحذف `users` ثم Supabase auth user، ويمسح الكوكيز.
- `db/schema.sql`: FKs بـ `ON DELETE CASCADE` من `users → businesses → google_ads_accounts` (التي تحمل `refresh_token_encrypted`) → بقية الجداول. لا يترك بيانات حساسة.

---

## 5) التغييرات في هذه الجلسة (تفصيلي)

### 5.1 `lib/auth/google-login.ts` — إصلاح redirect_uri_mismatch
`getGoogleLoginRedirectUri(origin)` صار يفضّل الترتيب:
1. `GOOGLE_LOGIN_REDIRECT_URI` (إن وُجد)
2. `NEXT_PUBLIC_APP_URL` + `/api/auth/google/callback`
3. `origin` (fallback أخير للتطوير المحلي)

النتيجة: رابط الدخول ثابت على `https://ai.modaafa.com/api/auth/google/callback` في الإنتاج بغض النظر عن النطاق الذي دخل منه المستخدم. نفس الدالة تُستخدم في توليد authUrl وفي تبادل الـ code، فيبقى الاثنان متطابقين.

### 5.2 المساعد — ذاكرة محادثة + إعادة استخدام الجلسة
**`app/api/chat/assistant/route.ts`:**
- أضفت type `ChatTurn` + `sanitizeHistory(raw)` (يبقي user/assistant صحيحة، يقصّ 4000 حرف/رسالة، آخر 8 رسائل) + `mergeConsecutiveTurns()` (يضمن تبادل الأدوار المطلوب من Anthropic).
- `POST` يقرأ `history` و`sessionId` من الجسم.
- `buildReply`/`generateAssistantReply` يستقبلان `history` + `hasCampaignData` + `hasAudit`؛ الرسائل تُبنى كأدوار متبادلة: `[...history, finalUserTurn]` بعد الدمج، مع إسقاط أي assistant في المقدمة لتبدأ بـ user.
- `system` prompt محسّن: يتابع السياق، يمنع تكرار القالب، ويستخدم `dataState` ليطلب المطلوب بوضوح عند نقص البيانات.
- **إعادة استخدام الجلسة**: إن وصل `sessionId` صالح يخص المستخدم، يُحدَّث `draft_campaign` عليه بدل إنشاء جلسة جديدة لكل رسالة.

**`app/(dashboard)/assistant/assistant-client.tsx`:**
- state جديد `sessionId`.
- يرسل `history` (آخر 8 من `chat`) + `sessionId`، ويخزّن `data.session_id` العائد.
- `handleAccountChange` يصفّر `sessionId` (خيط جديد لكل حساب).

> جميع التغييرات مرّت `tsc --noEmit` بنجاح (exit 0).

---

## 6) حالة التحقق (Verification)
- ✅ `node_modules/.bin/tsc --noEmit` → **exit 0** (قبل وبعد التعديلات).
- ⚠️ `next build` **لم يُشغَّل في بيئة الفحص**: البيئة Linux/arm64 بينما المثبّت `@next/swc-darwin-arm64` فقط (خاص بـ macOS). شغّل `pnpm build` على جهاز الماك للتأكيد.
- ❌ لم يُنشر على Vercel، ولم يُعمل commit (كان `.git/index.lock` مقفولاً في بيئة الفحص). النشر قرار المالك.

---

## 7) متغيّرات البيئة المطلوبة (أسماء فقط)
تحقّق في Vercel (Production) — القيم الحرجة للمشاكل المذكورة:
- `NEXT_PUBLIC_APP_URL = https://ai.modaafa.com` ← أساسي لإصلاح 5.1
- `GOOGLE_OAUTH_REDIRECT_URI = https://ai.modaafa.com/api/auth/google-ads/callback`
- `GOOGLE_LOGIN_REDIRECT_URI` (اختياري؛ إن غاب يُشتق من `NEXT_PUBLIC_APP_URL`)
- `ANTHROPIC_API_KEY` ← بدونه المساعد بوضع fallback القالبي (سبب "الردود المكررة")
- Google Ads: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_MCC_CUSTOMER_ID` (+ اختيارياً `GOOGLE_ADS_MANAGER_CUSTOMER_ID`, `MOODAAFT_MANAGER_CUSTOMER_ID`)
- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- أخرى: `ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`, (اختياري) `GOOGLE_ADS_API_VERSION`, `GOOGLE_OAUTH_APP_VERIFIED`

**في Google Cloud Console → OAuth Client → Authorized redirect URIs، سجّل كليهما:**
```
https://ai.modaafa.com/api/auth/google/callback
https://ai.modaafa.com/api/auth/google-ads/callback
```

---

## 8) مهام مقترحة لـ Codex (Actionable)

> القاعدة: لا `git reset`، لا كشف أسرار، اقرأ الملف قبل تعديله، وشغّل `pnpm typecheck` و`pnpm build` بعد كل تعديل.

**A. تحقّق من الإصلاحات الحالية (أولوية عليا)**
1. راجع `lib/auth/google-login.ts::getGoogleLoginRedirectUri` وتأكّد أن الإنتاج يعطي `https://ai.modaafa.com/api/auth/google/callback`.
2. راجع تغييرات المساعد في `app/api/chat/assistant/route.ts` و`app/(dashboard)/assistant/assistant-client.tsx`؛ اختبر محادثة متعددة الأدوار وتبديل الحساب أثناءها.
3. شغّل `pnpm typecheck && pnpm build` محلياً (macOS).

**B. تنظيف اختياري (أولوية متوسطة)**
4. قرّر مصير المسار القديم `app/onboarding/select-account/page.tsx` + `app/api/auth/google-ads/select-account/route.ts` (شبه مُهمَل بعد الربط التلقائي). إمّا حذفه أو إبقاؤه كمسار بديل موثّق.
5. في OAuth callback (`app/api/auth/google-ads/callback/route.ts`) `savedAccounts?.[0]` يُستخدم كأول حساب للمزامنة الأولية والكوكي؛ رتّب الاختيار (مثلاً أول حساب غير إداري باسم) بدل الاعتماد على ترتيب الإدراج.

**C. تحسينات مقترحة (أولوية منخفضة)**
6. تخزين "سبب فقدان الاسم" (permission_denied / not_enabled / no_name) على مستوى الحساب في DB لعرض رسالة أدق في الواجهة بدل "غير مُسمّى" العامة.
7. تحميل تاريخ المحادثة من `chat_messages` server-side عند وجود `sessionId` (بدل الاعتماد فقط على history من العميل) لثبات أعلى.
8. إضافة اختبارات لـ `discoverAccessibleCustomers` (شجرة MCC) و`getCustomerMetadataWithFallback`.

**D. خارج الكود (تذكير للمالك)**
9. Google OAuth verification: أكمل branding + privacy/terms على `ai.modaafa.com` + فيديو تجريبي في Google Cloud. ليست مهمة كود.
10. تأكّد من متغيّرات §7 في Vercel، خصوصاً `ANTHROPIC_API_KEY` و`NEXT_PUBLIC_APP_URL`.

---

## 9) أوامر مرجعية
```bash
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm build          # next build (شغّله على macOS)
pnpm dev            # تطوير محلي

# فحص الصحة (يتطلب CRON_SECRET):
curl -H "Authorization: Bearer $CRON_SECRET" https://ai.modaafa.com/api/health
```

**قواعد Google Ads المهمّة:**
- لا تسحب metrics من MCC `7561141000` (Manager) → `REQUESTED_METRICS_FOR_MANAGER`. استخدم حساب عميل غير إداري للأداء.
- الحساب/البروفايل الصحيح في Chrome لهذا المشروع: مُضاعفة / moodaaft@gmail.com.
