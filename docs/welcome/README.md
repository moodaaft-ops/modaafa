# شاشة /welcome (أول دخول)

الصفحة: `app/welcome/page.tsx`. كل النص في ملف واحد: `lib/welcome/copy.ts`.

## متى تظهر
- مستخدم ما ربط ولا حساب إعلاني (لا فعّال ولا منتهي ولا موقوف): تظهر له كل ما دخل.
- مستخدم عنده أي حساب مربوط: `/welcome` يحوله إلى `/dashboard` ولا يسجل شي.
- الدخول: `/dashboard` و `/onboarding` يحولان المستخدم غير المربوط إلى `/welcome`.

## الأحداث (جدول `user_events`)
- `onboarding_viewed`: أول مرة فقط. تضمنها فهرس فريد جزئي في قاعدة البيانات.
- `connect_clicked`: يُسجل في `/api/auth/google-ads/connect` مع `source=welcome` عند الضغط من هذي الشاشة، وأي مصدر ثاني يُسجل `other`.
- الكتابة بعد إرسال الرد، وأي فشل في التسجيل ما يوقف الصفحة ولا الربط.

## قبل التفعيل
شغّل `db/migrations/20261012_user_events.sql` في Supabase SQL Editor. بدونه الشاشة تشتغل لكن الحدثين ما ينحفظون (يطلع تحذير في اللوقز فقط).

الجدول بنفس شكله في `db/migrations/20261012_welcome_email.sql` (PR #81): الأعمدة `stage` و`metadata` والربط مع `public.users` وأسماء الفهارس. فلا يهم أي ميقريشن تنشغل أول، الثانية ما تغيّر الجدول وتضيف فهرسها بس. لا تغيّر أسماء الأعمدة في أحدهما بدون الثاني.

## فيديو الديمو
يظهر فقط لما تضبط `NEXT_PUBLIC_WELCOME_VIDEO_EMBED_URL` على رابط `https://www.youtube-nocookie.com/embed/...`.

## الفحص
- `pnpm test`: `tests/welcome.test.ts`.
- المتصفح: `tests/e2e/welcome.spec.ts` (التعليمات في رأس الملف). لقطات الجوال في `screenshots/`.
