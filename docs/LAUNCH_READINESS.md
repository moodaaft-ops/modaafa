# تقرير جاهزية الإطلاق — مُضاعِف (Modaafa Ads AI)

- التاريخ: 2026-07-22
- المُعِدّ: جلسة المراجعة الهندسية الشاملة (Claude)
- النطاق: `https://ai.modaafa.com`
- المرجعان المكمّلان: [قائمة الإطلاق](LAUNCH-CHECKLIST.md) و[دليل التشغيل](OPERATIONS-RUNBOOK.md)

---

## 1) ملخص بنية المشروع

- **Next.js 15.5 (App Router) + React 18 + TypeScript + Tailwind**، عربي أولاً RTL مع وضع فاتح/داكن كامل.
- **Supabase**: مصادقة + Postgres مع RLS مفعّل على كل الجداول (19 جدولاً). عزل المستأجرين سليم: كل سياسة مقيدة بـ `auth.uid()` مباشرة أو عبر سلسلة `business_id`، ولا توجد سياسة مفتوحة.
- **OAuth مزدوج منفصل**: دخول المنصة (`/api/auth/google/*`، نطاق openid/email/profile) وربط Google Ads (`/api/auth/google-ads/*`، نطاق adwords وحيد)، مع حالة CSRF مخزنة server-side أحادية الاستخدام (جدول `oauth_states`) + كوكي احتياطي.
- **Google Ads** عبر REST wrapper مخصص (gRPC لا يعمل على Vercel): اكتشاف شجرة MCC حتى عمق 8، ترقيم صفحات pageToken، أسماء عبر `descriptive_name` مع سلسلة fallback لعدة `login-customer-id`، ولا تُسحب metrics من حساب إداري إطلاقاً.
- **المساعد الذكي**: Anthropic API مع اكتشاف نماذج ديناميكي، وتاريخ محادثة محفوظ server-side، وسياق حقيقي (الحساب المختار + كاش الحملات + آخر فحص + التوصيات). الرد الاحتياطي مُعلَّم بوضوح في الواجهة (`ai_backend=fallback` + تنبيه).
- **مركز الموافقات**: التوصيات تمر بحالات pending → approved → executing → applied مع قفل تنفيذ (`execution_key`)، وvalidateOnly قبل التنفيذ، وحواجز أمان، وسجل rollback.
- **Stripe**: 3 خطط × شهري/سنوي، تجربة 14 يوماً بمنحة واحدة لكل مستخدم (`billing_trial_grants`)، webhook موقّع مع منع تكرار الأحداث (`processed_webhook_events`) وإعادة محاولة للأحداث العالقة، وCustomer Portal، وفواتير داخل المنصة.
- **التشغيل**: مهام Vercel Cron (مزامنة 02:00 وتحسين 03:00 UTC) بمصادقة `CRON_SECRET` timing-safe، حدود معدل (`rate_limit_windows`)، حدود استخدام حسب الخطة (`usage_events`)، بريد تشغيلي عبر Resend، وفحص صحة مفصل `/api/health` يرجع `launch_ready`.
- **الحذف النهائي**: تأكيد نصي صريح → إلغاء اشتراكات Stripe → إبطال refresh tokens في Google → حذف بيانات المنصة (CASCADE كامل) → حذف مستخدم المصادقة.

## 2) ما تم إصلاحه في جلسة 2026-07-22

| # | الإصلاح | الملفات |
|---|---|---|
| 1 | **قيد FK بين `public.users` و`auth.users`** مع CASCADE — قبلها كان حذف هوية المصادقة من خارج المنصة يترك كل بيانات المستأجر (بما فيها refresh tokens المشفرة) يتيمة للأبد | `db/migrations/20260722_users_auth_fk_and_rate_limit_order.sql`, `db/schema.sql` |
| 2 | **إصلاح ترتيب migrations دالة حد المعدل** — ملف "fix" كان يُطبق قبل إنشاء الجدول في البيئات الجديدة؛ الآن التعريف النهائي حتمي | نفس الملف أعلاه |
| 3 | **صفحات أخطاء عربية**: 404 مخصصة (كانت الافتراضية بالإنجليزية LTR في الإنتاج) + error boundary + global error | `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx` |
| 4 | **مقارنة timing-safe لتفويض فحص الصحة** بدل مقارنة نصية عادية | `app/api/health/route.ts` |
| 5 | **تحصين صفحات onboarding الفرعية**: redirect صريح عند غياب الجلسة بدل الاعتماد على middleware وحده، وإزالة عرض حسابات من كوكي بدون مستخدم موثق | `app/onboarding/{business,connect,select-account}/page.tsx` |
| 6 | **robots.txt + sitemap.xml** (كانا 404) مع حجب مسارات التطبيق عن الفهرسة | `app/robots.ts`, `app/sitemap.ts` |
| 7 | **favicon.ico + أيقونات PWA** (192/512 + maskable + apple-touch-icon PNG) وmanifest عربي RTL كامل + `theme-color` فاتح/داكن | `public/*`, `app/manifest.ts`, `app/layout.tsx` |
| 8 | **عناوين صفحات فريدة** (قالب `%s | مُضاعِف`) لكل الصفحات القانونية وصفحات لوحة التحكم — كان عنوان واحد مكرراً في الموقع كله | 12 صفحة + `app/(auth)/layout.tsx` |
| 9 | **توحيد الهوية الإنجليزية** إلى "Modaafa Ads AI" (كانت "Moodaaft" في الواجهات العامة) | `app/page.tsx`, `app/(auth)/login/page.tsx`, `app/privacy/page.tsx`, `lib/ui/legal-page.tsx` |
| 10 | **زر الوضع الداكن** أضيف للصفحات القانونية ومسار onboarding (كان مفقوداً فيها) + ترويسة موحدة للـ onboarding | `lib/ui/legal-page.tsx`, `app/onboarding/layout.tsx` |
| 11 | **هياكل تحميل مخصصة لكل قسم** (assistant/billing/settings/optimizer/reports/campaigns/audit) بدل هيكل واحد لا يطابق الشكل | 7 ملفات `loading.tsx` |
| 12 | **إصلاح الوضع الداكن في عدّاد صحة الحساب** (حلقة SVG كانت بلون فاتح ثابت) | `app/(dashboard)/audit/page.tsx` |
| 13 | **تعطيل مبدّل الحساب في المساعد أثناء التبديل** لمنع النقر المزدوج | `app/(dashboard)/assistant/assistant-client.tsx` |
| 14 | **مزامنة `db/schema.sql` مع الواقع**: أضيفت `rate_limit_windows` ودوال حد المعدل والاستخدام المفقودة (بيئة جديدة من schema.sql كانت ستفشل صامتاً) | `db/schema.sql` |
| 15 | **اختبارات جديدة** لأسماء الحسابات واختيار الحساب المفضل (5 اختبارات) | `tests/accounts-display-selection.test.ts` |

## 3) نتائج الفحوصات (بيئة المراجعة، 2026-07-22)

| الفحص | النتيجة |
|---|---|
| `tsc --noEmit` | ✅ exit 0 |
| `eslint . --max-warnings=0` | ✅ exit 0 |
| الاختبارات (`tsx --test`) | ✅ 25/25 |
| `next build` (إنتاجي) | ✅ exit 0 — كل المسارات تُبنى، وrobots/sitemap ظاهران |
| تشغيل إنتاجي محلي + لقطات | ✅ 404 عربية RTL، favicon.ico 200، manifest 200 |

## 4) ما تم اختباره على النسخة الحية (قبل نشر إصلاحات اليوم)

- الصفحة التعريفية والدخول والخصوصية والشروط وحذف البيانات: تعمل، RTL سليم، على الكمبيوتر والجوال (لقطات كاملة).
- الصفحات المحمية تحوّل 307 إلى `/login?next=…`، و`/login` بعد الدخول تحوّل للوحة.
- بدء OAuth الدخول يوجه إلى Google بـ `redirect_uri=https://ai.modaafa.com/api/auth/google/callback` مطابق حرفياً، وscopes صحيحة، وstate حاضر.
- `/api/auth/google-ads/connect` بدون جلسة يحوّل إلى الدخول (لا تسريب).
- ترويسات الأمان: CSP مقيدة + HSTS + nosniff + X-Frame-Options DENY.
- `/api/health` العام يرجع 200 برد محدود لا يكشف تفاصيل.

**لم يُختبر مباشرة في هذه الجلسة** (يحتاج جلسة Google حقيقية أو نشراً جديداً): رحلة OAuth كاملة بحساب moodaaft@gmail.com، سحب حسابات MCC 756-114-1000 الحية، محادثة المساعد على بيانات حية، تدفق Stripe تجريبي كامل، والفحص المفصل `launch_ready` (يتطلب `CRON_SECRET`). خطوات تنفيذها في §8.

## 5) المشكلات المتبقية (مرتبة)

- **P1 — النشر**: إصلاحات اليوم غير منشورة بعد. يجب تطبيق migration الجديد على Supabase ثم النشر على Vercel (خطوات §8).
- **P2 — اللغة الإنجليزية**: لا يوجد مبدّل لغة AR/EN. المنتج عربي أولاً بقرار واعٍ، والقاعدة جاهزة (`users.preferred_lang` موجود في السكيمة). التوصية: إطلاق تجريبي بالعربية، وإضافة i18n كاملة (next-intl أو قواميس خفيفة) في إصدار لاحق بدل ترجمة متعجلة تكسر الواجهة.
- **P2 — البنية**: مسار `select-account` القديم شبه مهمل بعد الربط التلقائي (يعمل كمسار بديل). قرار الإبقاء/الحذف مؤجل بلا أثر على الإطلاق.
- **P3 — تدوير مفتاح التشفير**: `ENCRYPTION_KEY` مفتاح واحد بلا إصدارات؛ التدوير يتطلب إعادة تشفير الصفوف. مقبول للإطلاق، يُخطط له لاحقاً.
- **P3 — أسباب غياب الاسم**: تخزين سبب فشل جلب اسم الحساب (permission/not_enabled) لعرض رسالة أدق من "غير مُسمّى".

## 6) العوائق الخارجية (ليست أخطاء كود)

1. **مراجعة Google لشاشة موافقة OAuth**: التقديم تم سابقاً، وحالة المراجعة يجب التحقق منها من Google Cloud Console (لا يمكن التحقق منها آلياً من هنا). حتى اكتمالها يظهر تحذير "لم تثبت Google ملكية التطبيق" ويقتصر الربط على Test users. **لا تضبط `GOOGLE_OAUTH_APP_VERIFIED=true` قبل موافقة Google الفعلية** — صفحة الربط تشرح هذا للمستخدم بالفعل.
2. **وضع Stripe live**: التحقق من أن الأسعار الستة live/recurring وwebhook الإنتاج مفعّل بالأحداث الستة — فحص `checkStripeConfiguration` في health المفصل يتحقق من كل هذا آلياً.
3. **نطاق Resend** موثق وتنبيهات التشغيل تصل — يظهر في health المفصل.
4. **صلاحية Google Ads Developer Token** لمستوى الوصول المطلوب (Basic/Standard) حسب حجم الحسابات.

## 7) حالة التكاملات

| التكامل | الحالة |
|---|---|
| **Google OAuth (دخول)** | ✅ كود سليم ومختبر حياً حتى شاشة Google؛ redirect URIs مطابقة |
| **Google verification** | 🔶 خارجي — قيد مراجعة Google؛ تحقق من الحالة في Cloud Console |
| **Google Ads API** | ✅ اكتشاف الحسابات والأسماء وشجرة MCC والحماية من metrics المدير — سليم كوداً ومغطى باختبارات؛ يحتاج جولة حية بعد النشر |
| **Stripe** | ✅ الكود كامل (checkout/trial/webhook/portal/idempotency)؛ التحقق النهائي عبر health المفصل + جولة تجريبية |
| **Anthropic** | ✅ اتصال حقيقي مع اكتشاف نماذج وfallback مُعلَّم؛ يتطلب `ANTHROPIC_API_KEY` صالحاً في الإنتاج |
| **Supabase RLS** | ✅ مراجعة كاملة — لا ثغرات عزل؛ قيد FK الجديد يغلق ثغرة اليتم |
| **Vercel Cron** | ✅ مجدولة ومؤمنة؛ راقب `job_runs` بعد النشر |

## 8) قائمة التحقق قبل الإطلاق (الخطوات البشرية بالترتيب)

1. [ ] طبّق migration الجديد على Supabase الإنتاج: `db/migrations/20260722_users_auth_fk_and_rate_limit_order.sql` (عبر SQL Editor أو `pnpm db:migrate`).
2. [ ] راجع التغييرات ثم ادفعها: `git add -A && git commit && git push` من جهازك (النشر تلقائي عبر Vercel). لا حاجة لأي تغيير في متغيرات البيئة لإصلاحات اليوم.
3. [ ] بعد النشر شغّل الفحص المفصل: `curl -H "Authorization: Bearer $CRON_SECRET" https://ai.modaafa.com/api/health` وتأكد من `launch_ready: true` (أو عالج البنود الظاهرة).
4. [ ] تحقق من حالة مراجعة Google OAuth في Cloud Console؛ عند الموافقة فقط اضبط `GOOGLE_OAUTH_APP_VERIFIED=true` وأعد النشر.
5. [ ] جولة حية بحساب moodaaft@gmail.com: دخول → onboarding → ربط Google Ads → ظهور حسابات MCC بأسمائها → تبديل حساب → مزامنة → فحص → سؤال المساعد 3 أسئلة مختلفة → توصية → اعتماد (بدون تنفيذ فعلي على حملة حقيقية).
6. [ ] جولة Stripe تجريبية (Test mode أو خطة حقيقية منخفضة ثم إلغاء فوري): checkout → رجوع → webhook → ظهور الاشتراك → فتح Portal → إلغاء.
7. [ ] تحقق من صفحة 404 الجديدة والأيقونات على الإنتاج بعد النشر.
8. [ ] ابدأ بإطلاق محدود 7 أيام حسب [LAUNCH-CHECKLIST](LAUNCH-CHECKLIST.md) §7.

## 9) الحكم

**جاهز تجريبياً (Beta-ready) — وغير جاهز للإطلاق العام بعد.**

الكود بكل مكوناته الحرجة (عزل البيانات، OAuth، الفوترة، حواجز التنفيذ، تجربة المستخدم، صفحات الأخطاء) في حالة إطلاق، وكل الفحوصات خضراء. الحاجزان المتبقيان خارجيان وتشغيليان لا برمجيان: **اكتمال مراجعة Google لشاشة الموافقة** (شرط الإطلاق العام)، و**جولة تحقق حية واحدة بعد نشر إصلاحات اليوم** (OAuth كامل + Stripe تجريبي + `launch_ready: true`). عند إغلاقهما يرتفع الحكم إلى جاهز للإطلاق الرسمي.
