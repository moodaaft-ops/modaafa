# خطة تطبيق migration الفحص المجاني (للاعتماد، لا تطبيق قبله)

الملف: `db/migrations/20261009_free_audit_quota.sql` على PR #57.

## الحالة الحالية

- **التحقق على Supabase الحقيقي: لم يتم.** موصل Supabase المعتمد موجود في الحساب لكن حالته `needs_reconnect` وغير مفعّل في هذي الجلسة، وما أقدر أعيد ربطه من عندي. ما قرأت شيئاً من قاعدة الإنتاج ولا غيّرت فيها شيئاً.
- **اسم المشروع على Supabase:** غير مؤكد، لأني ما قدرت أقرأ القائمة. يُملأ بعد إعادة الربط.
- **قاعدة معاينة معزولة (preview database):** ما لقيت أي إشارة لها في المستودع (لا `supabase/` ولا إعدادات فروع). اختباراتي كلها على Postgres 16 مؤقت وحذفته. 352 اختباراً نجحت منها 10 اختبارات SQL حقيقية.
- الفرع محدّث من main عند `b341b8e`.

## ما يتوقعه الـmigration من المخطط (من `db/schema.sql`)

| الجدول | العمود | النوع المتوقع |
|---|---|---|
| businesses | id, user_id | uuid، و`user_id` فريد وهو مفتاح المالك |
| google_ads_accounts | id, business_id | uuid |
| google_ads_accounts | customer_id | text، أرقام فقط (الدالة ترفض غير `^[0-9]{3,20}$`) |
| google_ads_accounts | status | text، القيمة المطلوبة `active` |
| google_ads_accounts | is_manager | boolean not null default false |

شرط الملكية داخل SQL: `google_ads_accounts.business_id = businesses.id` و`businesses.user_id = auth.uid()`.

## استعلامات قراءة فقط تُشغَّل عبر الموصل (مخطط وصلاحيات، بدون صفوف عملاء ولا tokens)

```sql
-- 1) أنواع الأعمدة
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'businesses' and column_name in ('id','user_id'))
    or (table_name = 'google_ads_accounts' and column_name in ('id','business_id','customer_id','status','is_manager')))
order by table_name, column_name;

-- 2) هل طُبّق الـdraft سابقاً؟ (المتوقع: صفر صفوف وnull)
select to_regclass('public.free_audit_ledger') as ledger;
select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('consume_free_audit','complete_free_audit','refund_free_audit');

-- 3) أسماء الدوال المحجوزة وصلاحيات الأدوار الحالية على جدول المالك
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('businesses','google_ads_accounts')
  and grantee in ('anon','authenticated','service_role');
```

**النتيجة المقبولة:** `customer_id` نوعه text، و`is_manager` boolean، و`user_id` uuid، والبند 2 فاضي. أي اختلاف يوقف التطبيق ويرجع لك.

## خطة التطبيق (additive، غير مدمّر)

1. **قبل أي شي:** تقرر أنت اعتماد التوافق بعد نتائج القراءة أعلاه.
2. **الترتيب:** نطبّق الـmigration أولاً، ثم ننشر الكود. الـmigration يضيف جدولاً ودوال جديدة فقط، فالكود القديم يشتغل معه بدون أي تأثر. لا يلمس أسعار Stripe ولا الاشتراكات ولا التجارب ولا مواعيد الخصم.
3. **التطبيق:** ملف واحد في معاملة واحدة، قابل للتكرار (`if not exists` و`create or replace` و`drop function if exists`).
4. **التحقق بعد التطبيق (قراءة فقط):**
   - `to_regclass('public.free_audit_ledger')` غير null.
   - `has_function_privilege('authenticated','public.complete_free_audit(uuid,uuid,uuid)','execute')` يرجع false.
   - نفس الاستعلام لـ`service_role` يرجع true، ولـ`refund_free_audit` للـ`authenticated` false.
   - `relrowsecurity` على الجدول true، ولا توجد policies.

## التراجع (rollback)

- **ترتيب التراجع:** نرجّع نشر الكود السابق أولاً، وبعدها فقط نحذف الدوال. لو حذفنا الدوال والكود الجديد شغّال، فحص المجاني يرجع 503.
- ```sql
  drop function if exists public.consume_free_audit(uuid);
  drop function if exists public.complete_free_audit(uuid, uuid, uuid);
  drop function if exists public.refund_free_audit(uuid);
  ```
- **الجدول `free_audit_ledger` نتركه** (فيه عداد الحصص، وحذفه يصفّر فحوصات العملاء). يُحذف فقط لو كان فاضياً ويطلب أيمن ذلك.

## ما لن يحدث

لا تطبيق على الإنتاج، ولا قراءة صفوف عملاء أو tokens، ولا صلاحيات جديدة، ولا خدمة مدفوعة، ولا إنشاء مشروع Supabase جديد.

## المطلوب منكم

إعادة ربط موصل Supabase وتفعيله في هذي الجلسة، وبعدها أشغّل الاستعلامات الثلاثة وأرجع النتيجة هنا. أو يشغّلها أيمن/كودكس مباشرة ويلصق المخرج.
