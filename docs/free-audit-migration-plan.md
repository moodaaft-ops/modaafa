# خطة تطبيق migration الفحص المجاني (للاعتماد، لا تطبيق قبله)

الملف: `db/migrations/20261009_free_audit_quota.sql` على PR #57. نسخة نهائية للمراجعة، لم تُطبَّق على الإنتاج.

## التحقق من metadata الإنتاج (مشروع `modaafa-prod`، من جلسة Supabase Dashboard، قراءة مخطط فقط)

فحصه أيمن وأرسل النتيجة، وتطابق ما يتوقعه الـmigration:

| الجدول | العمود | النوع | null |
|---|---|---|---|
| businesses | id | uuid | NO |
| businesses | user_id | uuid | NO |
| google_ads_accounts | id | uuid | NO |
| google_ads_accounts | business_id | uuid | NO |
| google_ads_accounts | customer_id | text | NO |
| google_ads_accounts | is_manager | boolean | NO |
| google_ads_accounts | status | text | YES |

- `to_regclass('public.free_audit_ledger')` يرجع NULL، وعدد دوال الحصة `quota_function_count = 0`. يعني الـdraft ما انطبق سابقاً.
- شرط الملكية داخل SQL: `google_ads_accounts.business_id = businesses.id` و`businesses.user_id = auth.uid()` مع `status = 'active'` و`is_manager is not true`. وجود `status` nullable لا يكسره: القيمة NULL لا تطابق `'active'` فيُرفض الحساب (يفشل مغلقاً، وهو المطلوب).
- لم تُقرأ صفوف عملاء ولا tokens ولا أسرار.
- هذا الجزء مأخوذ من نتيجة أيمن، وأنا ما شغّلت أي استعلام على الإنتاج (موصل Supabase عندي ما زال يحتاج إعادة ربط).

## ما تغيّر في النسخة النهائية

**1) معاملة صريحة.** الملف الآن يبدأ بـ`begin;` وينتهي بـ`commit;` (واحد من كل نوع). أي فشل يرجّع كل شي، ولا يبقى جدول بدون دوال أو العكس. الوصف السابق «معاملة واحدة» كان غير مطابق للملف، وصحّحته.

**2) تحصين الصلاحيات مع default privileges.** على Supabase، أي جدول أو دالة تنشئها في `public` تحصل تلقائياً على صلاحيات كاملة لـ`anon` و`authenticated` و`service_role` عبر `ALTER DEFAULT PRIVILEGES`، والدوال يأخذ منها `PUBLIC` صلاحية `EXECUTE` افتراضياً من Postgres نفسه. لذلك الـmigration ما يكتفي بمنح الحد الأدنى، بل **يسحب كل شي أولاً** من `PUBLIC` و`anon` و`authenticated` و`service_role` على كل كائن ينشئه، ثم يمنح الحد الأدنى فقط:

| الكائن | PUBLIC | anon | authenticated | service_role |
|---|---|---|---|---|
| جدول `free_audit_ledger` | لا شي | لا شي | لا شي | `SELECT` فقط |
| `consume_free_audit(uuid)` | لا | لا | `EXECUTE` | لا |
| `complete_free_audit(uuid,uuid,uuid)` | لا | لا | لا | `EXECUTE` |
| `refund_free_audit(uuid)` | لا | لا | لا | `EXECUTE` |

- لماذا `SELECT` لـservice_role: صفحة الفحص تقرأ الحصة بعميل الإدارة (`getFreeAuditStatus`). الكتابة كلها تمر عبر الدوال (security definer)، فما يحتاج `INSERT/UPDATE/DELETE` مباشرة.
- RLS مفعّل بدون أي policy، والدوال `security definer` مع `search_path` ثابت.
- ما وسّعت أي صلاحية على جداول موجودة (`businesses` و`google_ads_accounts` ما انلمسوا).

**3) الاختبارات.** المختبر يحاكي default privileges قبل التطبيق (للجداول والدوال والـsequences، وservice_role بـBYPASSRLS كما في Supabase)، ويثبت بعد التطبيق:

- لا `select/insert/update/delete/truncate/references/trigger` لـanon أو authenticated على الجدول.
- service_role: `select` فقط، ومحاولة `delete` مباشرة تفشل بـpermission denied.
- لا أي ACL لـPUBLIC (grantee 0) على الجدول أو الدوال الثلاث.
- مصفوفة `EXECUTE` أعلاه مطابقة تماماً، ومحاولات حقيقية من anon وauthenticated على `complete` و`refund` والجدول تفشل، والحجز يبقى `reserved`.
- معاملة واحدة صريحة، وRLS مفعّل بدون policies.
- النتيجة: 361 اختباراً نجحت كلها (منها 19 اختبار SQL على Postgres 16 حقيقي مؤقت، حذفته بعد الانتهاء).

## استعلامات قراءة فقط قبل التطبيق (إضافية، مخطط وصلاحيات بدون صفوف)

```sql
-- سياسة default privileges الفعلية في الإنتاج (هل الافتراضي مفتوح لـanon/authenticated؟)
select defaclrole::regrole as owner, defaclobjtype as kind, defaclacl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace or defaclnamespace = 0;
```

النتيجة لا تغيّر الخطة (السحب الصريح يغطي الحالتين)، لكنها توثّق الوضع الحالي.

## خطة التطبيق (additive، غير مدمّر) بعد اعتمادكم

1. أيمن يعتمد النسخة النهائية، ثم ينفّذ الملف في Supabase SQL Editor على `modaafa-prod` كملف واحد.
2. **الترتيب:** الـmigration أولاً ثم نشر الكود. الـmigration يضيف جدولاً ودوال فقط، والكود القديم يشتغل معه بدون تأثر. لا يلمس أسعار Stripe ولا الاشتراكات ولا التجارب ولا مواعيد الخصم.
3. **التحقق بعد التطبيق (قراءة فقط):**

```sql
select to_regclass('public.free_audit_ledger') is not null as ledger_exists;

select p.proname,
  has_function_privilege('anon', p.oid, 'execute')          as anon,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
  has_function_privilege('service_role', p.oid, 'execute')  as service_role
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('consume_free_audit','complete_free_audit','refund_free_audit')
order by p.proname;

select has_table_privilege('anon','public.free_audit_ledger','select') as anon_select,
       has_table_privilege('authenticated','public.free_audit_ledger','select') as auth_select,
       has_table_privilege('service_role','public.free_audit_ledger','select') as svc_select,
       has_table_privilege('service_role','public.free_audit_ledger','insert') as svc_insert,
       (select relrowsecurity from pg_class where oid = 'public.free_audit_ledger'::regclass) as rls;
```

**المتوقع:** `ledger_exists = true`؛ `complete_free_audit` و`refund_free_audit` = (false, false, true)؛ `consume_free_audit` = (false, true, false)؛ `anon_select = false`، `auth_select = false`، `svc_select = true`، `svc_insert = false`، `rls = true`.

## التراجع (rollback)

- نرجّع نشر الكود السابق أولاً، وبعدها فقط نحذف الدوال. لو حذفناها والكود الجديد شغّال، فحص المجاني يرجع 503.
- ```sql
  begin;
  drop function if exists public.consume_free_audit(uuid);
  drop function if exists public.complete_free_audit(uuid, uuid, uuid);
  drop function if exists public.refund_free_audit(uuid);
  commit;
  ```
- الجدول `free_audit_ledger` نتركه (فيه عداد حصص العملاء، وحذفه يصفّرها). يُحذف فقط لو كان فاضياً وبطلب صريح من أيمن.

## ما لن يحدث

لا تطبيق على الإنتاج ولا دمج قبل اعتمادكم، ولا قراءة صفوف عملاء أو tokens، ولا صلاحيات جديدة على جداول موجودة، ولا خدمة مدفوعة، ولا مشروع Supabase جديد. قاعدة معاينة معزولة ما لقيت لها أثراً في المستودع، فالاختبارات على Postgres مؤقت.
