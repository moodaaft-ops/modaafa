# عقد الفحص المجاني والاشتراك عند التطبيق

للمهمتين 02 (onboarding) و05 (الشات). الكود المرجعي: `lib/billing/free-audit.ts`.

## القاعدة
- التسجيل وربط الحساب والفحص وقراءة التقارير والتوصيات: بدون اشتراك.
- لكل حساب Google Ads فحصان مجانيان (الأول وإعادة واحدة). المفتاح هو customer id في Google، فحذف الحساب أو إعادة ربطه أو دخول مستخدم ثاني ما يصفّر العداد.
- الاشتراك مطلوب فقط عند: تنفيذ توصية (`POST /api/recommendations/action`)، تفعيل وضع التنفيذ المحافظ (`POST /api/autopilot/settings` مع `mode=conservative`)، وأي عمل آلي في الـcron (`/api/cron/optimize`).
- الاشتراك لا يعني موافقة: التنفيذ يبقى بعد المعاينة وموافقة العميل (`approve_before_execution`).
- التراجع (`/api/actions/rollback`) يبقى متاحاً بعد انتهاء الاشتراك ولا يستهلك حصة.

## الواجهة البرمجية
`POST /api/audit/run` يرد برموز الخطأ التالية:

| الرمز | HTTP | المعنى |
|---|---|---|
| `free_audits_exhausted` | 402 | انتهى الفحصان المجانيان. القراءة مفتوحة، فحص جديد يحتاج اشتراكاً |
| `audit_in_progress` | 409 | فحص شغّال لنفس الحساب، أعد المحاولة بعد انتهائه |
| `quota_exceeded` | 429 | مشترك وصل حد خطته |
| `usage_storage_unavailable` | 503 | تعذر التحقق، لم يُستهلك شيء |

نجاح الفحص يرجع `usage: { source: 'free' | 'subscription', remaining, resets_at }`.

## RPC (Supabase)

**`consume_free_audit(p_account_id uuid)`**

- الدور: `authenticated`.
- يرجع `(allowed, reason, used, event_id)`.
- الوسيط الوحيد هو معرّف الحساب. الـcustomer id يُقرأ داخل SQL من حساب يملكه `auth.uid()`، وغير ذلك `forbidden`.
- الحد 2 ومدة الحجز 15 دقيقة ثوابت داخل الدالة.

**`complete_free_audit(p_event_id uuid, p_user_id uuid, p_account_id uuid)`**

- الدور: `service_role` فقط. `authenticated` و`anon` يحصلون على `permission denied`.
- يُستدعى من السيرفر بعد حفظ التقرير، عبر `completeAuditAccess({ admin, userId, accountId, access })`.
- يتحقق أن الحجز والمستخدم والحساب الثلاثة تطابق صف الدفتر، وإلا يرجع `not_found`.
- يرجع نصاً: `completed` أو `already_completed` أو `expired` أو `not_found`.
- متكرر الأمان (idempotent)، ولا يكمل حجزاً انتهت مدته.
- السبب: لو كان متاحاً للعميل لكمّل الحجز وفحصه شغّال، وبدأ الفحص الثاني فوراً وتجاوز منع التزامن.

**`refund_free_audit(p_event_id uuid)`**

- الدور: `service_role` فقط.

**الجدول `free_audit_ledger`**

- مقفل على anon وauthenticated.
- الحالات: `reserved` ثم `completed` أو `abandoned`.
- فقط `completed` يُحسب من الحد.

للقراءة من الواجهة: `getFreeAuditStatus(customerId)` ترجع `{ limit, used, remaining }` (خادم فقط).

## للمهمة 02 (onboarding)
زر الفحص الأول يشتغل بدون اشتراك. لا تعرض صفحة الدفع قبل التقرير. اعرض الاشتراك عند الضغط على «تنفيذ» أو تفعيل التحسين الآلي، أو عند `free_audits_exhausted`.

## للمهمة 05 (الشات)
الشات والباني لهما حد خاص (`assistant`, `campaign_builder`) وما غيّرناهما. إذا قررتم فتحهما للمجاني فهذا قرار منفصل. أي تنفيذ يطلبه الشات يمر عبر المسارات أعلاه ولا يملك مساراً جانبياً.

## الحدود المعروفة
- الفحصان لكل حساب Google وليس لكل مستخدم: وكالة تنقل حساباً بين مستخدمين تحتاج رفعاً يدوياً للحد.
- حساب Google جديد (customer id مختلف) له فحصان جديدان، وهذا مقصود حسب النص.
- حجز عالق (انهيار السيرفر أثناء الفحص) يمنع فحصاً ثانياً حتى تنتهي مدته (15 دقيقة)، ثم يصير `abandoned` ولا يُحسب ولا يمنع. يعني انهيارنا ما يحرق الفحصين، والثمن أن انهياراً بعد حفظ التقرير وقبل الإكمال يعطي العميل فحصاً زائداً.
- `completeAuditAccess` يشتغل على عميل الإدارة ولا يرمي خطأ لأن التقرير انحفظ: يرجع `completed | already_completed | expired | not_found | error | noop` ويسجل الخطأ في اللوق. فشل الإكمال معناه أن الحجز ينتهي ولا يُحسب، لصالح العميل.
