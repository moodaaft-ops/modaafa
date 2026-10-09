# خطة تطبيق `20261009_connect_job_fencing.sql`

الحالة: لم تُطبَّق على أي بيئة حقيقية. جُرّبت على Postgres 16 تجريبي فقط (37 فحصاً في `connect-job-fencing-pg-test.sh`). التطبيق على الإنتاج قرار المالك بعد مراجعة Codex.

## ما يضيفه وما لا يمسه

يضيف خمس دوال فقط: `connect_job_start(uuid, timestamptz)` و`connect_job_lock_live` و`connect_job_link` و`connect_job_select_account` و`connect_job_set_manager`. لا جدول ولا عمود ولا سياسة RLS ولا index ولا grant على جدول. الدوال `SECURITY INVOKER`، وتُنفَّذ من `service_role` فقط (الذي يتجاوز RLS أصلاً). الملف كله داخل `BEGIN ... COMMIT`، فلا توجد لحظة تظهر فيها دالة بصلاحية PUBLIC الافتراضية قبل الـ REVOKE. أي خطأ في المنتصف يتراجع كل شيء.

## قبل التطبيق: استعلامات metadata فقط (قراءة من الكتالوج، لا تمس بيانات)

```sql
-- 1) الأعمدة التي تعتمد عليها الدوال
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('job_runs','id'),('job_runs','job_name'),('job_runs','status'),('job_runs','started_at'),
    ('job_runs','finished_at'),('job_runs','details'),('job_runs','error_message'),
    ('businesses','id'),('businesses','user_id'),('businesses','selected_google_ads_customer_id'),
    ('google_ads_accounts','id'),('google_ads_accounts','business_id'),('google_ads_accounts','customer_id'),
    ('google_ads_accounts','customer_name'),('google_ads_accounts','manager_id'),
    ('google_ads_accounts','refresh_token_encrypted'),('google_ads_accounts','permissions_scope'),
    ('google_ads_accounts','status'),('google_ads_accounts','currency_code'),('google_ads_accounts','time_zone'),
    ('google_ads_accounts','is_manager'),('google_ads_accounts','google_status'))
order by 1, 2;
-- المتوقع: 22 صفاً. أي نقص يوقف التطبيق. details لازم تكون jsonb.

-- 2) القيد/الفهرس الذي يعتمد عليه ON CONFLICT
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.google_ads_accounts'::regclass and contype in ('u','p');
-- المتوقع: unique على (business_id, customer_id).

select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'job_runs';
-- المتوقع: job_runs_one_running_per_job (unique جزئي على job_name where status = 'running').

-- 3) دوال بنفس الأسماء موجودة مسبقاً؟
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'connect_job_%';
-- المتوقع: صفر صفوف. أي صف يعني تعارضاً يُراجع قبل المتابعة (create or replace سيستبدلها).

-- 4) RLS وصلاحيات الجداول (للتأكد أن شيئاً لن يتغير)
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('job_runs','businesses','google_ads_accounts');
-- نسجّل النتيجة قبل وبعد، ويجب أن تتطابق.
```

## ترتيب النشر

1. تطبيق الـ migration أولاً (الكود الحالي في الإنتاج لا يستدعي هذه الدوال، فلا يتأثر).
2. بعد التحقق أدناه، نشر الكود.
3. الكود الجديد يفشل بوضوح (`db_error` على الاتصال) إن نُشر قبل الـ migration، ولا يكتب شيئاً.

## التحقق بعد التطبيق (قراءة فقط)

```sql
-- خمس دوال، لا PUBLIC ولا anon ولا authenticated، وservice_role فقط
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer, p.proconfig::text as config,
       has_function_privilege('public',        p.oid, 'execute') as public_exec,
       has_function_privilege('anon',          p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       has_function_privilege('service_role',  p.oid, 'execute') as service_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'connect_job_%' order by 1;
-- المتوقع لكل صف: security_definer=false، config فيها search_path=public, pg_temp،
-- public_exec=false، anon_exec=false، auth_exec=false، service_exec=true.
```

ثم نعيد استعلام RLS (4) ونقارنه بما قبل التطبيق. لا نختبر بكتابة على بيانات حقيقية. اختبار سلوكي واحد آمن بعد النشر: ربط حساب تجريبي بمستخدم تجريبي من الواجهة، ومراجعة `job_runs` لذلك المستخدم فقط.

## التراجع (غير مدمّر)

لا بيانات تُحذف لأن الـ migration لا تنشئ بيانات. التراجع:

1. تراجع الكود أولاً (أو تعطيل التفرّع)، لأن الكود الجديد يحتاج الدوال.
2. ثم:

```sql
begin;
drop function if exists public.connect_job_set_manager(uuid, uuid, uuid, text);
drop function if exists public.connect_job_select_account(uuid, uuid, uuid, text);
drop function if exists public.connect_job_link(uuid, uuid, uuid, jsonb);
drop function if exists public.connect_job_lock_live(uuid, uuid);
drop function if exists public.connect_job_start(uuid, timestamptz);
commit;
```

صفوف `job_runs` التي كتبتها الدوال تبقى كما هي، والحقل الإضافي `details.consent_at` فيها يُتجاهَل بلا أثر.

## ترتيب الأحدث: ما يُضمَن وما لا يُضمَن

- الترتيب بوقت موافقة المستخدم (`oauth_states.created_at`)، لا بوقت وصول الـ callback. `connect_job_start` يرجع `stale` لـ callback أقدم من موافقة مسجّلة، ولا يفتح job ولا يكتب توكن، حتى لو الـ job الأحدث انتهى. المستخدم يُحوَّل لصفحة التجهيز.
- بدون وقت موثوق (تخزين الـ state على الخادم تعطّل وقُبل الكوكي الاحتياطي) لا نتجاوز ربطاً أحدث: إذا بدأ أي job ربط لهذا المستخدم خلال آخر 60 دقيقة (عمر الـ state) يرجع `untrusted_time`، ولا يُفتح job، ويُحوَّل المستخدم إلى `/onboarding/connect?error=restart_link` برسالة تطلب إعادة الربط. لا نقبل «آخر واصل يفوز». لم أضف وقتاً يأتي من العميل، فلا HMAC ولا تخزين جديد.
- ثمن هذا القرار: أثناء عطل تخزين الـ state، من فشل ربطه أو نجح قبل أقل من ساعة لا يستطيع إعادة الربط حتى تعود الخدمة أو تمر الساعة. أول ربط للمستخدم وأي ربط بعد ساعة يعمل.
- الحد الأول: المقارنة تقرأ `job_runs`. أنظف ما في الكود: `lib/platform/retention.ts` يحذف صفوف `job_runs` غير الجارية بعد 90 يوماً فقط (يُستدعى من cron المزامنة الساعي)، أي أطول بكثير من 60 دقيقة، فلا يمسح صف job حديثاً. قرأت الكود فقط. لم أقرأ جدول `cron.job` في الإنتاج ولا عندي اتصال به، فلا أعرف إن كان هناك مهمة pg_cron أخرى تحذف من `job_runs`. migration الجدولة في الريبو (`20261005_pg_cron_scheduler.sql`) يجدول `modaafa-sync` و`modaafa-optimize` فقط. المطلوب من المالك أو Codex قراءة `select jobname, schedule, command from cron.job;` (قراءة فقط) للتأكيد.
- الحد الثاني: موافقتان بنفس الميلي ثانية: يفوز من يصل ثانياً.
- الحد الثالث: لو جاء callback بوقت موثوق ولم يوجد أي job أقدم/أحدث في `job_runs` (مثلاً لم يبقَ صف)، لا يوجد ما يُقارَن به فيُقبل.

## لماذا كاش الحملات القديم لا يختلط بحساب آخر

- `syncCampaignCache` يكتب في `campaigns_cache` بمفتاح `account_id` (معرّف صف `google_ads_accounts`) وكل صف كاش يحمل `account_id` و`google_campaign_id`. الـ upsert `onConflict: account_id,google_campaign_id`، والحذف مقيّد بـ `account_id` وبـ `last_synced_at < syncedAt`.
- الـ `account_id` الذي تمرّره المهمة يأتي حصراً من صفوف ترجعها `connect_job_link` لنفس `business_id` ونفس المستخدم (الدالة ترفض business لا يملكه). المهمة القديمة لا تستطيع تمرير معرّف حساب من business آخر.
- العميل في المزامنة يُبنى من `customer_id` الحساب نفسه، فالبيانات المقروءة هي بيانات ذلك الـ customer فقط، حتى لو كان التوكن لموافقة أقدم.
- قرار مقبول مؤقتاً بتوجيه Codex: كتابة الكاش لا تُقفل ذرياً، فمهمة قديمة قيد المزامنة وقت استبدالها قد تكتب لقطة أقدم لنفس `account_id` فوق لقطة أحدث لثوانٍ، حتى المزامنة التالية. هذا تقادم لنفس الحساب، لا اختلاط بين حسابات. لا نوسّع `sync.ts` ولا الـ crons الآن. الخيار لاحقاً: upsert شرطي يرفض الكتابة حين `last_synced_at` المخزّن أحدث.
